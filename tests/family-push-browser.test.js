const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const familySource = fs.readFileSync(path.join(__dirname, '..', 'family.js'), 'utf8');
const pushSource = fs.readFileSync(path.join(__dirname, '..', 'departure-push.js'), 'utf8');
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');

function harness({ saved = false, permission = 'default', userAgent = 'Chrome' } = {}) {
  const values = new Map(saved ? [['mapdule-family-push', JSON.stringify({ endpoint: 'old' })]] : []);
  const calls = [];
  const notices = [];
  let config = { enabled: true, publicKey };
  let delivery = true;
  let subscription = null;
  const fresh = { endpoint: 'https://fcm.googleapis.com/fcm/send/fresh',
    options: { applicationServerKey: Buffer.from(publicKey, 'base64url') },
    toJSON() { return { endpoint: this.endpoint }; } };
  const notification = {
    permission,
    requestPermission: async () => { calls.push('permission'); return permission === 'denied' ? 'denied' : 'granted'; }
  };
  const registration = { pushManager: {
    getSubscription: async () => subscription,
    subscribe: async () => { calls.push('subscribe'); subscription = fresh; return fresh; }
  } };
  const context = vm.createContext({
    window: { isSecureContext: true, PushManager: {}, Notification: notification,
      matchMedia: () => ({ matches: false }), departureEventFingerprint() {} },
    Notification: notification,
    navigator: { userAgent, serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } },
    localStorage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    readJson: (key, fallback) => values.has(key) ? JSON.parse(values.get(key)) : fallback,
    writeJson: (key, value) => values.set(key, JSON.stringify(value)),
    renderFamilyView() {}, showToast: (message) => notices.push(message), escapeHtml: (text) => text,
    isJoined: () => true,
    api: async () => { calls.push('api'); return { subscribed: true, delivery }; },
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(url.endsWith('status') ? config : { cancelled: true }),
        { headers: { 'Content-Type': 'application/json' } });
    },
    Uint8Array, Date, btoa, atob, AbortSignal, crypto: globalThis.crypto
  });
  vm.runInContext(pushSource, context);
  const start = familySource.indexOf('  function pushSupported()');
  const end = familySource.indexOf('  // ---------- 데리러 와 줘 ----------', start);
  const htmlStart = familySource.indexOf('  function familyPushHtml()');
  const htmlEnd = familySource.indexOf('  function renderJoined(', htmlStart);
  assert.ok(start >= 0 && end > start && htmlStart >= 0 && htmlEnd > htmlStart);
  vm.runInContext(`const FAMILY_PUSH_KEY = 'mapdule-family-push';
    let pushConfig = null, pushBusy = false, pushSynced = false, pushSyncing = false, pushError = '';
    ${familySource.slice(start, end)}
    ${familySource.slice(htmlStart, htmlEnd)}`, context);
  return {
    context, values, calls, notices,
    enable: () => context.enableFamilyPush(), sync: () => context.syncFamilyPush(),
    html: () => context.familyPushHtml(),
    config: (value) => { config = value; }, delivery: (value) => { delivery = value; },
    subscription: (value) => { subscription = value; }
  };
}

test('family permission is requested in the click gesture before any network wait', async () => {
  const browser = harness();
  const pending = browser.enable();
  assert.deepEqual(browser.calls, ['permission']);
  await pending;
  assert.deepEqual(browser.calls, ['permission', '/api/push/status', 'subscribe', 'api']);
  assert.ok(browser.values.has('mapdule-family-push'));
  assert.equal(browser.notices.length, 1);
});

test('blocked notifications and uninstalled iOS apps never subscribe or claim success', async () => {
  for (const options of [{ permission: 'denied' }, { userAgent: 'iPhone Safari' }]) {
    const browser = harness(options);
    await browser.enable();
    assert.ok(!browser.calls.includes('/api/push/status'));
    assert.ok(!browser.values.has('mapdule-family-push'));
    assert.match(browser.notices[0], /허용|홈 화면/);
    assert.doesNotMatch(browser.html(), /켜져 있어요/);
  }
});

test('family registration without a working server notifier does not show enabled', async () => {
  const browser = harness({ permission: 'granted' });
  browser.delivery(false);
  await browser.enable();
  assert.ok(!browser.calls.includes('permission'));
  assert.ok(!browser.values.has('mapdule-family-push'));
  assert.match(browser.notices[0], /발송이 준비되지/);
  assert.match(browser.html(), /알림 다시 연결/);
  browser.delivery(true);
  await browser.enable();
  assert.match(browser.html(), /켜져 있어요/);
});

test('saved family push retries disabled server configuration instead of staying falsely enabled', async () => {
  const browser = harness({ saved: true, permission: 'granted' });
  assert.doesNotMatch(browser.html(), /켜져 있어요/);
  browser.config({ enabled: false });
  await browser.sync();
  assert.match(browser.html(), /서버가 아직 준비되지/);
  assert.doesNotMatch(browser.html(), /켜져 있어요/);
  assert.match(browser.html(), /data-family-push-off/);
  browser.config({ enabled: true, publicKey });
  await browser.sync();
  assert.equal(browser.calls.filter((value) => value === '/api/push/status').length, 2);
  assert.match(browser.html(), /켜져 있어요/);
});

test('family sync failures are visible, retryable and cannot create overlapping requests', async () => {
  const browser = harness({ saved: true, permission: 'granted' });
  let finish;
  browser.context.api = () => {
    browser.calls.push('api');
    return new Promise((resolve) => { finish = resolve; });
  };
  const pending = browser.sync();
  await new Promise((resolve) => setImmediate(resolve));
  await browser.sync();
  assert.equal(browser.calls.filter((value) => value === 'api').length, 1);
  finish({ subscribed: true, delivery: false });
  await pending;
  assert.match(browser.html(), /발송/);
  assert.doesNotMatch(browser.html(), /켜져 있어요/);
  browser.context.api = async () => ({ subscribed: true, delivery: true });
  await browser.sync();
  assert.match(browser.html(), /켜져 있어요/);
});

test('family reconnect replaces a subscription made with an obsolete VAPID key', async () => {
  const browser = harness({ saved: true, permission: 'granted' });
  browser.values.set('mapdule-push-state', JSON.stringify({ endpoint: 'old', fingerprints: [] }));
  browser.subscription({
    options: { applicationServerKey: Uint8Array.from([4, ...Array(64).fill(2)]).buffer },
    unsubscribe: async () => { browser.calls.push('unsubscribe'); return true; }
  });
  await browser.sync();
  assert.deepEqual(browser.calls, ['/api/push/status', '/api/push/cancel', 'unsubscribe', 'subscribe', 'api']);
  assert.equal(browser.values.has('mapdule-push-state'), false);
  assert.match(browser.html(), /켜져 있어요/);
});
