const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 가족 기능 저장소. 모든 구현은 같은 비동기 인터페이스를 가진다.
//   get(partition, row) -> value | null
//   put(partition, row, value)
//   remove(partition, row)
//   list(partition, rowPrefix) -> [{ row, value }]

function createMemoryStore(initialEntries = [], onChange = () => {}) {
  const entries = new Map(initialEntries.map(([key, value]) => [key, value]));
  const keyOf = (partition, row) => `${partition}\u0000${row}`;
  const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  return {
    kind: 'memory',
    async get(partition, row) {
      return clone(entries.get(keyOf(partition, row)));
    },
    async put(partition, row, value) {
      entries.set(keyOf(partition, row), clone(value));
      onChange(entries);
    },
    async remove(partition, row) {
      entries.delete(keyOf(partition, row));
      onChange(entries);
    },
    async list(partition, rowPrefix = '') {
      const prefix = keyOf(partition, rowPrefix);
      const rows = [];
      for (const [key, value] of entries) {
        if (key.startsWith(prefix)) rows.push({ row: key.slice(partition.length + 1), value: clone(value) });
      }
      return rows.sort((first, second) => first.row.localeCompare(second.row));
    }
  };
}

// 로컬 미리보기(server.js)용. 서버를 다시 켜도 가족 데이터가 남도록 JSON 파일에 저장한다.
function createFileStore(filePath) {
  let initialEntries = [];
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(saved)) initialEntries = saved;
  } catch {
    initialEntries = [];
  }
  let timer = null;
  const store = createMemoryStore(initialEntries, (entries) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify([...entries]), 'utf8');
    }, 200);
  });
  return { ...store, kind: 'file' };
}

function parseConnectionString(connectionString) {
  const values = Object.fromEntries(connectionString.split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  if (!values.AccountName || !values.AccountKey) {
    throw new Error('Storage connection string must include AccountName and AccountKey.');
  }
  const protocol = values.DefaultEndpointsProtocol || 'https';
  const endpoint = (values.TableEndpoint || `${protocol}://${values.AccountName}.table.${values.EndpointSuffix || 'core.windows.net'}`).replace(/\/+$/, '');
  return { accountName: values.AccountName, accountKey: values.AccountKey, endpoint };
}

// 배포용. Azure Table Storage 하나의 테이블에 JSON 문자열로 저장한다.
// 추가 npm 패키지 없이 REST API(SharedKeyLite 인증)를 직접 호출한다.
function createTableStore(connectionString, tableName = 'mapdulefamily', fetchImpl = globalThis.fetch) {
  const { accountName, accountKey, endpoint } = parseConnectionString(connectionString);
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password) {
    throw new Error('Table storage endpoint must use HTTPS and must not contain credentials.');
  }
  const endpointPath = endpointUrl.pathname.replace(/\/+$/, '');
  const key = Buffer.from(accountKey, 'base64');
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const entityPath = (partition, row) => `/${tableName}(PartitionKey=${encodeURIComponent(quote(partition))},RowKey=${encodeURIComponent(quote(row))})`;

  async function request(method, resourcePath, { query = '', body, headers = {} } = {}) {
    const date = new Date().toUTCString();
    const canonicalResource = `/${accountName}${endpointPath}${resourcePath}`;
    const signature = crypto.createHmac('sha256', key).update(`${date}\n${canonicalResource}`, 'utf8').digest('base64');
    const response = await fetchImpl(`${endpoint}${resourcePath}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        'x-ms-date': date,
        'x-ms-version': '2019-02-02',
        Accept: 'application/json;odata=nometadata',
        DataServiceVersion: '3.0;NetFx',
        MaxDataServiceVersion: '3.0;NetFx',
        Authorization: `SharedKeyLite ${accountName}:${signature}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000)
    });
    return response;
  }

  async function fail(response, action) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Table storage ${action} failed (${response.status}): ${detail.slice(0, 200)}`);
    error.statusCode = response.status;
    throw error;
  }

  let ready = null;
  const ensureTable = () => {
    ready ||= (async () => {
      const response = await request('POST', '/Tables', { body: { TableName: tableName }, headers: { Prefer: 'return-no-content' } });
      if (!response.ok && response.status !== 409) await fail(response, 'create table');
    })().catch((error) => {
      ready = null;
      throw error;
    });
    return ready;
  };

  // 접두사 검색의 상한값: 마지막 글자를 다음 글자로 바꾼다 (event_ -> event`).
  const prefixUpperBound = (prefix) => `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;

  return {
    kind: 'table',
    async get(partition, row) {
      await ensureTable();
      const response = await request('GET', entityPath(partition, row));
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, 'get');
      const entity = await response.json();
      return JSON.parse(entity.data);
    },
    async put(partition, row, value) {
      await ensureTable();
      const response = await request('PUT', entityPath(partition, row), {
        body: { PartitionKey: partition, RowKey: row, data: JSON.stringify(value) }
      });
      if (!response.ok) await fail(response, 'put');
    },
    async remove(partition, row) {
      await ensureTable();
      const response = await request('DELETE', entityPath(partition, row), { headers: { 'If-Match': '*' } });
      if (!response.ok && response.status !== 404) await fail(response, 'delete');
    },
    async list(partition, rowPrefix = '') {
      await ensureTable();
      let filter = `PartitionKey eq ${quote(partition)}`;
      if (rowPrefix) filter += ` and RowKey ge ${quote(rowPrefix)} and RowKey lt ${quote(prefixUpperBound(rowPrefix))}`;
      const rows = [];
      let continuation = null;
      do {
        const params = new URLSearchParams({ $filter: filter });
        if (continuation) {
          params.set('NextPartitionKey', continuation.partition);
          if (continuation.row) params.set('NextRowKey', continuation.row);
        }
        const response = await request('GET', `/${tableName}()`, { query: params.toString().replace(/\+/g, '%20') });
        if (!response.ok) await fail(response, 'query');
        const result = await response.json();
        for (const entity of result.value || []) rows.push({ row: entity.RowKey, value: JSON.parse(entity.data) });
        const nextPartition = response.headers.get('x-ms-continuation-NextPartitionKey');
        continuation = nextPartition ? { partition: nextPartition, row: response.headers.get('x-ms-continuation-NextRowKey') } : null;
      } while (continuation);
      return rows.sort((first, second) => first.row.localeCompare(second.row));
    }
  };
}

module.exports = { createMemoryStore, createFileStore, createTableStore, parseConnectionString };
