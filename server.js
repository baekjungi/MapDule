const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getAiStatus, parseSchedulePrompt } = require('./api/src/ai-schedule');
const { handleFamilyRequest } = require('./api/src/family-runtime');

const root = __dirname;
const envFile = path.join(root, '.env');
const MAX_REQUEST_BYTES = 16 * 1024;
const localFamilyDataFile = path.join(root, '.mapdule-data', 'family-dev.json');
const publicFiles = new Set(['index.html', 'app.js', 'styles.css', 'family.js', 'family.css']);
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://dapi.kakao.com https://t1.daumcdn.net https://t1.kakaocdn.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https://*.kakao.com https://*.daumcdn.net",
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

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
    ...securityHeaders,
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

async function familyRoute(request, response, action, requestUrl) {
  let body = {};
  if (request.method === 'POST') {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      sendJson(response, 415, { error: '요청 Content-Type은 application/json이어야 합니다.' });
      return;
    }
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(response, 400, { error: '요청 본문 형식이 올바르지 않습니다.' });
      return;
    }
  }
  try {
    const result = await handleFamilyRequest({
      method: request.method,
      action,
      body,
      query: Object.fromEntries(requestUrl.searchParams.entries()),
      credential: request.headers['x-mapdule-member'],
      clientKey: request.socket.remoteAddress
    }, { localFilePath: localFamilyDataFile });
    sendJson(response, result.status, result.body);
  } catch {
    sendJson(response, 500, { error: '가족 서버에서 오류가 발생했습니다.' });
  }
}

function safePath(urlPath) {
  let requested;
  try {
    requested = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  const relativePath = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const absolutePath = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) return null;
  const pathSegments = relativeToRoot.split(path.sep);
  if (pathSegments.some((segment) => segment.startsWith('.'))) return null;
  if (!publicFiles.has(relativeToRoot)) return null;
  return absolutePath;
}

const server = http.createServer(async (request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url || '/', 'http://localhost');
  } catch {
    response.writeHead(400, securityHeaders);
    response.end('Bad request');
    return;
  }
  if (requestUrl.pathname === '/api/ai/status' && request.method === 'GET') {
    sendJson(response, 200, getAiStatus());
    return;
  }
  if (requestUrl.pathname === '/api/ai/parse' && request.method === 'POST') {
    await parseSchedule(request, response);
    return;
  }
  const familyMatch = requestUrl.pathname.match(/^\/api\/family\/([a-z-]+)$/);
  if (familyMatch && ['GET', 'POST'].includes(request.method)) {
    await familyRoute(request, response, familyMatch[1], requestUrl);
    return;
  }
  if (requestUrl.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API endpoint를 찾을 수 없습니다.' });
    return;
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  const filePath = safePath(request.url || '/');

  if (!filePath) {
    response.writeHead(403, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, {
        ...securityHeaders,
        'Content-Type': 'text/plain; charset=utf-8'
      });
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      ...securityHeaders,
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-cache'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  });
});

if (require.main === module) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`MapDule is running at http://localhost:${port}`);
  });
}

module.exports = server;
