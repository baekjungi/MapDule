const test = require('node:test');
const assert = require('node:assert/strict');

test('service worker shows bounded notifications and never opens a URL supplied by a push payload', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const listeners = {};
  const shown = [];
  const opened = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), {
    URL, self: { addEventListener: (name, handler) => { listeners[name] = handler; },
      registration: { showNotification: async (...args) => shown.push(args) },
      location: { origin: 'https://app.example' }, clients: { matchAll: async () => [], openWindow: async (url) => opened.push(url) } }
  });
  const waits = [];
  listeners.push({ data: { json: () => ({ title: 'x'.repeat(100), body: 'y'.repeat(300), url: 'https://attacker.test' }) }, waitUntil: (promise) => waits.push(promise) });
  listeners.notificationclick({ notification: { close() {} }, waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  assert.equal(shown[0][0].length, 80);
  assert.equal(shown[0][1].body.length, 200);
  assert.deepEqual(opened, ['/#ai']);
});
const { createDeparturePushService, validateSubscription, handleDeparturePushRequest } = require('../api/src/departure-push');
const { createMemoryStore } = require('../api/src/family-store');
const token = 'a'.repeat(43);
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/example', keys: {
  p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url')
} };
function harness() {
  let time = Date.parse('2026-11-06T01:00:00Z');
  const calls = [];
  const service = createDeparturePushService({ store: createMemoryStore(), now: () => time, send: async (...args) => calls.push(args) });
  const body = { subscription, items: [{ id: 'one', title: '출발할 시간이에요.', body: '약속 10:30 시작',
    dueAt: new Date(time + 60000).toISOString(), expiresAt: new Date(time + 1800000).toISOString() }] };
  return { service, body, calls, advance: (value) => { time += value; } };
}
test('schedules persist until due and concurrent dispatch claims prevent duplicate sends', async () => {
  const { service, body, calls, advance } = harness();
  assert.equal((await service.schedule(body, token)).scheduled, 1);
  assert.equal((await service.dispatch()).sent, 0);
  advance(60000);
  await Promise.all([service.dispatch(), service.dispatch()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].url, '/#ai');
  assert.equal((await service.dispatch()).sent, 0);
});
test('ownership, replacement, cancellation and expiry protect departure reservations', async () => {
  const { service, body, calls, advance } = harness();
  await service.schedule(body, token);
  await assert.rejects(service.schedule(body, 'b'.repeat(43)), { statusCode: 403 });
  await assert.rejects(service.cancel({ endpoint: subscription.endpoint }, 'b'.repeat(43)), { statusCode: 403 });
  await service.cancel({ endpoint: subscription.endpoint }, token);
  advance(60000);
  await service.dispatch();
  assert.equal(calls.length, 0);
  await assert.rejects(service.schedule(body, token), { statusCode: 400 });
  const fresh = harness();
  await fresh.service.schedule(fresh.body, token);
  fresh.advance(1800001);
  await fresh.service.dispatch();
  assert.equal(fresh.calls.length, 0);
});
test('rejects untrusted endpoints, broken keys, oversized lists and unauthenticated dispatch', async () => {
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://localhost/x', 'https://fcm.googleapis.com.attacker.test/x', 'https://fcm.googleapis.com:444/x', 'https://user@fcm.googleapis.com/x']) {
    assert.throws(() => validateSubscription({ ...subscription, endpoint }), { statusCode: 400 });
  }
  assert.throws(() => validateSubscription({ ...subscription, keys: { auth: 'x', p256dh: 'x' } }), { statusCode: 400 });
  const { service, body } = harness();
  await assert.rejects(service.schedule({ ...body, items: Array(21).fill(body.items[0]) }, token), { statusCode: 400 });
  await assert.rejects(service.schedule(body, 'weak'), { statusCode: 401 });
  assert.equal((await handleDeparturePushRequest('dispatch', {}, '', 'test')).status, 401);
});

test('browser push schedules UTC instants, cancels edited routes and retains failed cancellation for retry', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const values = new Map();
  const requests = [];
  let cancellationFails = false;
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const first = appSource.indexOf('function departureEventFingerprint(');
  const last = appSource.indexOf('async function disableDepartureReminders(', first);
  const fingerprint = vm.runInNewContext(`${appSource.slice(first, last)}; departureEventFingerprint`);
  const browser = { isSecureContext: true, PushManager: {}, departureEventFingerprint: fingerprint, showToast() {} };
  const registration = { pushManager: {
    getSubscription: async () => null,
    subscribe: async () => ({ ...subscription, toJSON: () => subscription })
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'departure-push.js'), 'utf8'), {
    window: browser, Notification: { permission: 'granted' },
    navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } },
    localStorage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    Date, Uint8Array, crypto: globalThis.crypto, btoa, atob, AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(url.endsWith('status') ? { enabled: true, publicKey: subscription.keys.p256dh }
        : url.endsWith('cancel') && cancellationFails ? { error: 'unavailable' } : { scheduled: 1 }),
      { status: url.endsWith('cancel') && cancellationFails ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  const events = [{ id: 'from', date: '2026-12-01', title: '집', startTime: '12:00' }, { id: 'to', date: '2026-12-01', title: '약속', startTime: '14:00' }];
  assert.equal(await browser.MapDulePush.schedule('2026-12-01', [{ fromId: 'from', toId: 'to', toTitle: '약속', recommendedDepartureTime: '13:30', nextStartTime: '14:00', travelMinutes: 20 }], events), true);
  const scheduled = JSON.parse(requests.find((item) => item.url.endsWith('schedule')).options.body);
  assert.match(scheduled.items[0].dueAt, /Z$/);
  assert.equal(scheduled.items[0].expiresAt, new Date('2026-12-01T14:00:00').toISOString());
  assert.match(requests.find((item) => item.url.endsWith('schedule')).options.headers.Authorization, /^Bearer [A-Za-z0-9_-]{43}$/);
  cancellationFails = true;
  await browser.MapDulePush.reconcile([{ ...events[0], startTime: '12:30' }, events[1]]);
  assert.ok(values.has('mapdule-push-state'));
  cancellationFails = false;
  await browser.MapDulePush.reconcile([{ ...events[0], startTime: '12:30' }, events[1]]);
  assert.equal(values.has('mapdule-push-state'), false);
});