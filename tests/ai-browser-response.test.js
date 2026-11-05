const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('async function readAiResponse(');
const end = source.indexOf('function appendAiSignInLink(', start);
const readAiResponse = vm.runInNewContext(`${source.slice(start, end)}; readAiResponse`, { URL });

test('AI authentication errors are recognized before parsing HTML or JSON bodies', async () => {
  for (const status of [401, 403]) {
    const response = new Response('<!DOCTYPE html><html>Login</html>', {
      status, headers: { 'Content-Type': 'text/html' }
    });
    await assert.rejects(readAiResponse(response), (error) => error.code === 'AI_LOGIN_REQUIRED' && /로그인/.test(error.message));
    assert.equal(response.bodyUsed, false);
  }
  await assert.rejects(readAiResponse({
    status: 200, redirected: true, url: 'https://app.example/.auth/login/aad'
  }), (error) => error.code === 'AI_LOGIN_REQUIRED');
});

test('HTML API responses and malformed JSON produce localized errors instead of parser exceptions', async () => {
  for (const response of [
    new Response('<!DOCTYPE html><html>Gateway error</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    new Response('<!DOCTYPE html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    new Response('broken', { headers: { 'Content-Type': 'application/json' } }),
    Response.json(null), Response.json([]), Response.json('invalid')
  ]) {
    await assert.rejects(readAiResponse(response), (error) =>
      error.code === 'AI_INVALID_RESPONSE' && /응답/.test(error.message) && !/Unexpected token|DOCTYPE|SyntaxError/.test(error.message));
  }
});

test('AI JSON success and server validation errors preserve intended behavior', async () => {
  assert.equal((await readAiResponse(Response.json({ events: [], assumptions: [] }))).events.length, 0);
  await assert.rejects(readAiResponse(Response.json({ error: '문장을 확인해 주세요.', code: 'INVALID_PROMPT' }, { status: 400 })),
    (error) => error.message === '문장을 확인해 주세요.' && error.code === 'INVALID_PROMPT');
  await assert.rejects(readAiResponse(Response.json({ error: {} }, { status: 503 })),
    (error) => error.code === 'AI_REQUEST_FAILED' && /처리하지 못/.test(error.message));
});
