const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createAiRequestLimiter } = require('../api/src/ai-access');

test('anonymous AI requests share a per-client minute limit and recover after the window', async () => {
  let time = 0;
  const run = createAiRequestLimiter({ now: () => time });
  let calls = 0;
  const operation = async () => { calls += 1; return 'ok'; };
  for (let index = 0; index < 10; index += 1) assert.equal(await run('client-a', operation), 'ok');
  await assert.rejects(run('client-a', operation),
    (error) => error.statusCode === 429 && error.code === 'AI_RATE_LIMITED' && error.retryAfter === 60);
  assert.equal(calls, 10, 'rejected requests do not invoke the model');
  assert.equal(await run('client-b', operation), 'ok');
  time += 60_000;
  assert.equal(await run('client-a', operation), 'ok');
});

test('daily AI limit persists across minute windows and resets after 24 hours', async () => {
  let time = 0;
  const run = createAiRequestLimiter({ now: () => time });
  for (let batch = 0; batch < 10; batch += 1) {
    for (let index = 0; index < 10; index += 1) await run('client', async () => 'ok');
    time += 60_000;
  }
  await assert.rejects(run('client', async () => 'blocked'),
    (error) => error.statusCode === 429 && error.retryAfter === 85_800);
  time = 24 * 60 * 60 * 1000;
  assert.equal(await run('client', async () => 'reset'), 'reset');
});

test('AI concurrency is bounded and capacity is released after successes and failures', async () => {
  const run = createAiRequestLimiter();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = ['a', 'b', 'c'].map((client) => run(client, async () => gate));
  await assert.rejects(run('d', async () => 'blocked'), (error) => error.statusCode === 429 && error.retryAfter === 5);
  release('done');
  assert.deepEqual(await Promise.all(active), ['done', 'done', 'done']);
  await assert.rejects(run('d', async () => { throw new Error('model failed'); }), /model failed/);
  assert.equal(await run('d', async () => 'retry'), 'retry');
});

function loadAiHandlers() {
  const registrations = new Map();
  const file = path.join(__dirname, '..', 'api', 'src', 'functions', 'ai.js');
  const calls = [];
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require(name) {
      if (name === '@azure/functions') return { app: { http(name, options) { registrations.set(name, options); } } };
      if (name === '../ai-access') return { runAiRequest: createAiRequestLimiter() };
      if (name === '../ai-schedule') return {
        getAiStatus: () => ({ configured: true }),
        parseSchedulePrompt: async (prompt) => { calls.push(prompt); return { events: [], assumptions: [] }; },
        analyzeSchedulePlan: async (body) => { calls.push(body); return { transitions: [], summary: '완료' }; }
      };
      return require(path.resolve(path.dirname(file), name));
    },
    Response, Buffer, console
  }, { filename: file });
  return { registrations, calls };
}

test('Functions status and both AI operations accept requests without identity or cookies', async () => {
  const { registrations, calls } = loadAiHandlers();
  const status = await registrations.get('ai-status').handler();
  assert.deepEqual(await status.json(), { configured: true, authRequired: false });
  for (const [route, body] of [['ai-parse', { prompt: '내일 회의' }], ['ai-plan', { events: [] }]]) {
    const options = registrations.get(route);
    assert.equal(options.authLevel, 'anonymous');
    const request = new Request(`https://app.example/api/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const response = await options.handler(request, { error() {} });
    assert.equal(response.status, 200);
  }
  assert.equal(calls.length, 2);
});

test('Functions AI parse and plan share limits and return JSON 429 with Retry-After', async () => {
  const { registrations, calls } = loadAiHandlers();
  for (let index = 0; index < 11; index += 1) {
    const route = index % 2 ? 'ai-plan' : 'ai-parse';
    const request = new Request(`https://app.example/api/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': 'untrusted-first, proxy-client' },
      body: JSON.stringify({ prompt: '회의', events: [] })
    });
    const response = await registrations.get(route).handler(request, { error() {} });
    assert.equal(response.status, index < 10 ? 200 : 429);
    if (index === 10) {
      assert.equal((await response.json()).code, 'AI_RATE_LIMITED');
      assert.ok(Number(response.headers.get('Retry-After')) > 0);
    }
  }
  assert.equal(calls.length, 10);
});
