const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function safePath(urlPath) {
  const requested = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const absolutePath = path.resolve(root, relativePath);
  return absolutePath.startsWith(root) ? absolutePath : null;
}

const server = http.createServer((request, response) => {
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

server.listen(port, '0.0.0.0', () => {
  console.log(`MapDule is running at http://localhost:${port}`);
});
