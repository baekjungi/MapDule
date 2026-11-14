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
test('temporary delivery failures retain the reservation and retry after a minute', async () => {
  let time = Date.parse('2026-11-06T01:00:00Z');
  let attempts = 0;
  const service = createDeparturePushService({
    store: createMemoryStore(), now: () => time,
    send: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('temporarily unavailable'), { statusCode: 503 });
    }
  });
  await service.schedule({ subscription, items: [{
    id: 'retry', title: '출발', body: '약속', dueAt: new Date(time + 60000).toISOString(),
    expiresAt: new Date(time + 1800000).toISOString()
  }] }, token);
  time += 60000;
  assert.deepEqual(await service.dispatch(), { attempted: 1, sent: 0 });
  assert.deepEqual(await service.dispatch(), { attempted: 0, sent: 0 });
  time += 60000;
  assert.deepEqual(await service.dispatch(), { attempted: 1, sent: 1 });
  assert.equal(attempts, 2);
  assert.deepEqual(await service.dispatch(), { attempted: 0, sent: 0 });
});

test('a failed delivery never restores a reservation cancelled or replaced while sending', async () => {
  for (const replace of [false, true]) {
    let time = Date.parse('2026-11-06T01:00:00Z');
    let failSend;
    const service = createDeparturePushService({
      store: createMemoryStore(), now: () => time,
      send: () => new Promise((resolve, reject) => { failSend = reject; })
    });
    const body = { subscription, items: [{
      id: 'old', title: '출발', body: '약속', dueAt: new Date(time + 60000).toISOString(),
      expiresAt: new Date(time + 1800000).toISOString()
    }] };
    await service.schedule(body, token);
    time += 60000;
    const dispatching = service.dispatch();
    await new Promise((resolve) => setImmediate(resolve));
    if (replace) {
      await service.schedule({ ...body, items: [{ ...body.items[0], id: 'new',
        dueAt: new Date(time + 600000).toISOString() }] }, token);
    } else await service.cancel({ endpoint: subscription.endpoint }, token);
    failSend(new Error('network unavailable'));
    await dispatching;
    time += 60000;
    assert.deepEqual(await service.dispatch(), { attempted: 0, sent: 0 });
  }
});

test('delivery retries stop at expiry and invalid subscriptions discard remaining reservations', async () => {
  for (const statusCode of [503, 410]) {
    let time = Date.parse('2026-11-06T01:00:00Z');
    let attempts = 0;
    const service = createDeparturePushService({
      store: createMemoryStore(), now: () => time,
      send: async () => {
        attempts += 1;
        throw Object.assign(new Error('delivery failed'), { statusCode });
      }
    });
    await service.schedule({ subscription, items: [
      { id: 'one', title: '출발', body: '약속', dueAt: new Date(time + 60000).toISOString(),
        expiresAt: new Date(time + 90000).toISOString() },
      ...(statusCode === 410 ? [{ id: 'two', title: '출발', body: '약속',
        dueAt: new Date(time + 120000).toISOString(), expiresAt: new Date(time + 180000).toISOString() }] : [])
    ] }, token);
    time += 60000;
    assert.deepEqual(await service.dispatch(), { attempted: 1, sent: 0 });
    time += 60000;
    assert.deepEqual(await service.dispatch(), { attempted: 0, sent: 0 });
    assert.equal(attempts, 1);
  }
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

function browserHarness() {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const values = new Map();
  const requests = [];
  let cancellationFails = false;
  let schedulingFails = false;
  let scheduleResponse;
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
      if (url.endsWith('schedule') && scheduleResponse) return scheduleResponse();
      if (url.endsWith('schedule') && schedulingFails) {
        return new Response(JSON.stringify({ error: 'unavailable' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(url.endsWith('status') ? { enabled: true, publicKey: subscription.keys.p256dh }
        : url.endsWith('cancel') && cancellationFails ? { error: 'unavailable' } : { scheduled: 1 }),
      { status: url.endsWith('cancel') && cancellationFails ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  return {
    browser, values, requests,
    failCancellation: (value) => { cancellationFails = value; },
    failScheduling: (value) => { schedulingFails = value; },
    respondToSchedule: (value) => { scheduleResponse = value; }
  };
}

test('browser push schedules UTC instants, cancels edited routes and retains failed cancellation for retry', async () => {
  const { browser, values, requests, failScheduling, failCancellation } = browserHarness();
  const events = [{ id: 'from', date: '2026-12-01', title: '집', startTime: '12:00' }, { id: 'to', date: '2026-12-01', title: '약속', startTime: '14:00' }];
  assert.equal(await browser.MapDulePush.schedule('2026-12-01', [{ fromId: 'from', toId: 'to', toTitle: '약속', recommendedDepartureTime: '13:30', nextStartTime: '14:00', travelMinutes: 20 }], events), true);
  const scheduled = JSON.parse(requests.find((item) => item.url.endsWith('schedule')).options.body);
  assert.match(scheduled.items[0].dueAt, /Z$/);
  assert.equal(scheduled.items[0].expiresAt, new Date('2026-12-01T14:00:00').toISOString());
  assert.match(requests.find((item) => item.url.endsWith('schedule')).options.headers['X-MapDule-Push-Token'], /^[A-Za-z0-9_-]{43}$/);
  failScheduling(true);
  const replacement = [{ id: 'other', date: '2026-12-01', title: '새 약속', startTime: '15:00' }];
  await assert.rejects(browser.MapDulePush.schedule('2026-12-01', [{
    fromId: 'from', toId: 'other', toTitle: '새 약속', recommendedDepartureTime: '14:30',
    nextStartTime: '15:00', travelMinutes: 20
  }], [...events, ...replacement]), /unavailable/);
  assert.ok(JSON.parse(values.get('mapdule-push-state')).fingerprints.some(([id]) => id === 'to'),
    'a failed replacement must still track the previous server reservation');
  failCancellation(true);
  await browser.MapDulePush.reconcile([{ ...events[0], startTime: '12:30' }, events[1]]);
  assert.ok(values.has('mapdule-push-state'));
  failCancellation(false);
  await browser.MapDulePush.reconcile([{ ...events[0], startTime: '12:30' }, events[1]]);
  assert.equal(values.has('mapdule-push-state'), false);
});

test('browser cancellation waits for an in-flight schedule and cannot leave a later reservation behind', async () => {
  const { browser, values, requests, respondToSchedule } = browserHarness();
  let finish;
  respondToSchedule(() => new Promise((resolve) => { finish = resolve; }));
  const events = [{ id: 'to', date: '2026-12-01', title: '약속', startTime: '14:00' }];
  const scheduling = browser.MapDulePush.schedule('2026-12-01', [{
    fromId: 'from', toId: 'to', toTitle: '약속', recommendedDepartureTime: '13:30',
    nextStartTime: '14:00', travelMinutes: 20
  }], events);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  const cancelling = browser.MapDulePush.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.some((item) => item.url.endsWith('cancel')), false);
  finish(new Response(JSON.stringify({ scheduled: 1 }), { headers: { 'Content-Type': 'application/json' } }));
  await Promise.all([scheduling, cancelling]);
  assert.equal(requests.at(-1).url, '/api/push/cancel');
  assert.equal(values.has('mapdule-push-state'), false);
});

test('failed replacements keep both possible schedules without duplicate tracking, and success clears old tracking', async () => {
  const { browser, values, failScheduling, respondToSchedule } = browserHarness();
  const events = [{ id: 'from', title: '집' }, { id: 'to', title: '약속' }];
  const targets = [{
    fromId: 'from', toId: 'to', toTitle: '약속', recommendedDepartureTime: '13:30',
    nextStartTime: '14:00', travelMinutes: 20
  }];
  await browser.MapDulePush.schedule('2026-12-01', targets, events);
  const edited = [events[0], { ...events[1], title: '변경된 약속' }];
  respondToSchedule(() => { throw new Error('response lost'); });
  await assert.rejects(browser.MapDulePush.schedule('2026-12-01', targets, edited), /response lost/);
  respondToSchedule(null);
  failScheduling(true);
  await assert.rejects(browser.MapDulePush.schedule('2026-12-01', targets, edited), /unavailable/);
  assert.equal(JSON.parse(values.get('mapdule-push-state')).fingerprints.length, 3);
  failScheduling(false);
  await browser.MapDulePush.schedule('2026-12-01', targets, edited);
  assert.equal(JSON.parse(values.get('mapdule-push-state')).fingerprints.length, 2);
  await browser.MapDulePush.reconcile(edited);
  assert.ok(values.has('mapdule-push-state'));
});