const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getAiStatus, parseSchedulePrompt } = require('./api/src/ai-schedule');

const root = __dirname;
const envFile = path.join(root, '.env');
const MAX_REQUEST_BYTES = 16 * 1024;

function loadEnvironmentFile() {
  if (!fs.existsSync(envFile)) return;
  const contents = fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '');
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
}

loadEnvironmentFile();

const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

async function parseSchedule(request, response) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    sendJson(response, 415, { error: '요청 Content-Type은 application/json이어야 합니다.' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { error: '요청 본문 형식이 올바르지 않습니다.', code: 'INVALID_REQUEST' });
    return;
  }
  try {
    sendJson(response, 200, await parseSchedulePrompt(body.prompt));
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message,
      ...(error.code ? { code: error.code } : {})
    });
  }
}

function safePath(urlPath) {
  const requested = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const absolutePath = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) return null;
  const pathSegments = relativeToRoot.split(path.sep);
  if (pathSegments.some((segment) => /^\.env(?:\..*)?$/.test(segment) && segment !== '.env.example')) return null;
  return absolutePath;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (requestUrl.pathname === '/api/ai/status' && request.method === 'GET') {
    sendJson(response, 200, getAiStatus());
    return;
  }
  if (requestUrl.pathname === '/api/ai/parse' && request.method === 'POST') {
    await parseSchedule(request, response);
    return;
  }
  if (requestUrl.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API endpoint를 찾을 수 없습니다.' });
    return;
  }

  const filePath = safePath(request.url || '/');

  if (!filePath) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-cache'
    });
    response.end(content);
  });
});

if (require.main === module) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`MapDule is running at http://localhost:${port}`);
  });
}

module.exports = server;
