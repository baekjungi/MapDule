const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../server');

test('serves the app but blocks hidden files and repository metadata', async (context) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const appResponse = await fetch(`${baseUrl}/`);
  assert.equal(appResponse.status, 200);
  assert.equal(appResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(appResponse.headers.get('x-frame-options'), 'DENY');
  assert.match(appResponse.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(appResponse.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(appResponse.headers.get('content-security-policy'), /https:\/\/t1\.kakaocdn\.net/);

  for (const asset of ['/family.js', '/family.css']) {
    const response = await fetch(`${baseUrl}${asset}`);
    assert.equal(response.status, 200, `${asset} should be served`);
  }

  for (const filePath of [
    '/.git/config',
    '/%2egit/config',
    '/.env',
    '/server.js',
    '/README.md',
    '/package.json',
    '/tests/server.test.js'
  ]) {
    const response = await fetch(`${baseUrl}${filePath}`);
    assert.equal(response.status, 403, `${filePath} should be blocked`);
  }

  const methodResponse = await fetch(`${baseUrl}/`, { method: 'POST' });
  assert.equal(methodResponse.status, 405);
});

test('rejects malformed percent-encoding without crashing the server', async () => {
  const serverInstance = require('../server');
  await new Promise((resolve) => serverInstance.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = serverInstance.address();
    const response = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => serverInstance.close(resolve));
  }
});

test('serves the local family API with bounded request bodies and member authentication', async (context) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const statusResponse = await fetch(`${baseUrl}/api/family/status`);
  assert.deepEqual(await statusResponse.json(), { available: true, storage: 'file' });

  const unauthorizedResponse = await fetch(`${baseUrl}/api/family/state`);
  assert.equal(unauthorizedResponse.status, 401);

  const oversizedResponse = await fetch(`${baseUrl}/api/family/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberName: 'a'.repeat(17_000) })
  });
  assert.equal(oversizedResponse.status, 413);
});