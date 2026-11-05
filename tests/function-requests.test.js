const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readLimitedBody } = require('../api/src/request-body');

test('body limits count UTF-8 bytes and accept exactly 16KiB but not one byte more', async () => {
  const limit = 16 * 1024;
  const overhead = Buffer.byteLength(JSON.stringify({ value: '' }));
  const available = limit - overhead;
  const value = '가'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
  const text = JSON.stringify({ value });
  assert.equal(Buffer.byteLength(text), limit);
  const request = (body) => new Request('https://app.example/api/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body
  });
  assert.deepEqual(await readLimitedBody(request(text)), { text, tooLarge: false });
  assert.deepEqual(await readLimitedBody(request(`${text} `)), { text: '', tooLarge: true });
});

function handlerFor(fileName, route) {
  const registrations = new Map();
  const file = path.join(__dirname, '..', 'api', 'src', 'functions', fileName);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require(name) {
      if (name === '@azure/functions') return { app: { http(name, options) { registrations.set(name, options); } } };
      return require(path.resolve(path.dirname(file), name));
    },
    Response, Buffer, console
  }, { filename: file });
  return registrations.get(route).handler;
}

for (const [file, route] of [['ai.js', 'ai-parse'], ['family.js', 'family']]) {
  test(`${route} stops reading oversized chunked bodies at the size limit`, async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls <= 3) controller.enqueue(new TextEncoder().encode('x'.repeat(9000)));
        else controller.close();
      },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    const request = {
      method: 'POST', headers: new Headers({ 'Content-Type': 'application/json' }), body,
      text: () => new Response(body).text()
    };
    const response = await handlerFor(file, route)(request, { error() {} });
    assert.equal(response.status, 413);
    assert.equal(pulls, 2, 'do not buffer the remainder of an oversized request');
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });

  test(`${route} handles disconnected body streams with a JSON client error`, async () => {
    const request = new Request('https://app.example/api/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, duplex: 'half',
      body: new ReadableStream({ start(controller) { controller.error(new Error('disconnected')); } })
    });
    const response = await handlerFor(file, route)(request, { error() {} });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(request.body.locked, false);
  });

  test(`${route} rejects oversized declared lengths without reading the stream`, async () => {
    let reads = 0;
    const request = {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json', 'Content-Length': '20000' }),
      body: new ReadableStream({ pull() { reads += 1; } }, { highWaterMark: 0 })
    };
    const response = await handlerFor(file, route)(request, { error() {} });
    assert.equal(response.status, 413);
    assert.equal(reads, 0);
  });

  test(`${route} returns consistent errors for malformed JSON, arrays and unsupported content types`, async () => {
    const handler = handlerFor(file, route);
    for (const [body, contentType, status] of [['{broken', 'application/json', 400], ['[]', 'application/json', 400], ['{}', 'text/plain', 415]]) {
      const request = new Request('https://app.example/api/test', {
        method: 'POST', headers: { 'Content-Type': contentType }, body
      });
      const response = await handler(request, { error() {} });
      assert.equal(response.status, status);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  });
}
