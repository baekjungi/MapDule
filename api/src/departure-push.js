const crypto = require('node:crypto');
const { createFileStore, createTableStore } = require('./family-store');
const { createAiRequestLimiter } = require('./ai-access');

const WEEK_MS = 7 * 86400000;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function fail(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }

function validateSubscription(subscription) {
  let url;
  try { url = new URL(subscription?.endpoint); } catch { fail(400, '푸시 구독 주소가 올바르지 않습니다.'); }
  const allowed = url.hostname === 'fcm.googleapis.com' || url.hostname === 'web.push.apple.com'
    || /^(?:[a-z0-9-]+\.)?push\.services\.mozilla\.com$/.test(url.hostname)
    || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
  if (!allowed || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash
    || url.href.length > 2048 || url.pathname === '/') fail(400, '지원하지 않는 푸시 구독 주소입니다.');
  const keys = subscription?.keys;
  const validKey = (value, size) => typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value)
    && Buffer.from(value, 'base64url').length === size;
  if (!validKey(keys?.p256dh, 65) || Buffer.from(keys.p256dh, 'base64url')[0] !== 4 || !validKey(keys?.auth, 16)) {
    fail(400, '푸시 구독 키가 올바르지 않습니다.');
  }
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function createDeparturePushService({ store, send, now = () => Date.now() }) {
  const partition = 'departure-push';
  function owner(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, '알림 기기 인증이 필요합니다.');
    return hash(token);
  }
  function authorize(record, tokenHash) {
    if (record && record.tokenHash !== tokenHash) fail(403, '다른 기기의 알림은 변경할 수 없습니다.');
  }
  return {
    async schedule(body, token) {
      const tokenHash = owner(token);
      const subscription = validateSubscription(body?.subscription);
      if (!Array.isArray(body.items) || body.items.length > 20) fail(400, '출발 알림은 최대 20개까지 예약할 수 있어요.');
      const time = now();
      const items = body.items.map((item) => {
        const dueAt = Date.parse(item?.dueAt);
        const expiresAt = Date.parse(item?.expiresAt);
        if (typeof item?.id !== 'string' || !item.id || item.id.length > 120
          || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 80
          || typeof item.body !== 'string' || item.body.length > 200
          || !Number.isFinite(dueAt) || dueAt <= time || dueAt > time + WEEK_MS
          || !Number.isFinite(expiresAt) || expiresAt <= dueAt || expiresAt > dueAt + 86400000) {
          fail(400, '알림 내용과 아직 지나지 않은 출발 시각을 확인해 주세요.');
        }
        return { id: item.id, title: item.title.trim(), body: item.body, dueAt, expiresAt };
      });
      if (new Set(items.map((item) => item.id)).size !== items.length) fail(400, '중복된 알림입니다.');
      const row = hash(subscription.endpoint);
      await store.update(partition, row, (record) => {
        authorize(record, tokenHash);
        return { tokenHash, subscription, items, revision: crypto.randomUUID(), expiresAt: time + WEEK_MS + 86400000 };
      });
      return { scheduled: items.length };
    },
    async cancel(body, token) {
      const tokenHash = owner(token);
      if (typeof body?.endpoint !== 'string' || body.endpoint.length > 2048) fail(400, '구독 주소가 필요합니다.');
      const row = hash(body.endpoint);
      await store.update(partition, row, (record) => {
        authorize(record, tokenHash);
        return record ? { ...record, items: [], revision: crypto.randomUUID() } : null;
      });
      return { cancelled: true };
    },
    async dispatch() {
      const started = now();
      let attempted = 0;
      let sent = 0;
      const records = await store.list(partition);
      for (const { row } of records) {
        if (attempted >= 5 || now() - started >= 20000) break;
        let claimed;
        const record = await store.update(partition, row, (current) => {
          claimed = null;
          if (!current) return null;
          if (current.expiresAt <= now() && current.subscription) return { ...current, subscription: null, items: [], revision: crypto.randomUUID() };
          const active = current.items.filter((item) => item.expiresAt > now());
          claimed = current.expiresAt > now() && active.find((item) => item.dueAt <= now());
          if (!claimed && active.length === current.items.length) return null;
          return { ...current, items: active.filter((item) => item !== claimed) };
        });
        if (!claimed || !record) continue;
        const latest = await store.get(partition, row);
        if (latest?.revision !== record.revision) continue;
        attempted += 1;
        try {
          await send(record.subscription, { title: claimed.title, body: claimed.body, tag: `departure-${claimed.id}`, url: '/#ai' },
            { TTL: Math.max(1, Math.min(600, Math.ceil((claimed.expiresAt - now()) / 1000))), urgency: 'high', timeout: 4000 });
          sent += 1;
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) {
            await store.update(partition, row, (current) => current?.revision === record.revision
              ? { ...current, items: [], expiresAt: now(), revision: crypto.randomUUID() } : null);
          }
        }
      }
      return { attempted, sent };
    }
  };
}

let cachedService;
const runLimited = createAiRequestLimiter();
function pushConfiguration({ localFilePath } = {}) {
  const publicKey = process.env.MAPDULE_VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.MAPDULE_VAPID_PRIVATE_KEY || '';
  const subject = process.env.MAPDULE_VAPID_SUBJECT || '';
  const storage = process.env.MAPDULE_STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING;
  const enabled = Boolean(/^[A-Za-z0-9_-]+$/.test(publicKey) && Buffer.from(publicKey, 'base64url').length === 65
    && /^[A-Za-z0-9_-]+$/.test(privateKey) && Buffer.from(privateKey, 'base64url').length === 32
    && /^(mailto:[^\s@]+@[^\s]+|https:\/\/[^\s]+)$/.test(subject)
    && (storage || localFilePath) && (localFilePath || process.env.MAPDULE_PUSH_DISPATCH_KEY?.length >= 32));
  return { enabled, publicKey: enabled ? publicKey : null, storage, privateKey, subject };
}
function getService(options) {
  if (cachedService) return cachedService;
  const config = pushConfiguration(options);
  if (!config.enabled) fail(503, '닫힌 앱 알림 서버가 아직 설정되지 않았어요. 탭 알림을 사용할 수 있어요.');
  const webPush = require('web-push');
  cachedService = createDeparturePushService({
    store: config.storage ? createTableStore(config.storage, 'mapdulepush') : createFileStore(options.localFilePath),
    send: (subscription, payload, settings) => webPush.sendNotification(subscription, JSON.stringify(payload), {
      ...settings, vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }
    })
  });
  return cachedService;
}
async function handleDeparturePushRequest(action, body, token, clientKey, options = {}) {
  try {
    if (action === 'status') {
      const { enabled, publicKey } = pushConfiguration(options);
      return { status: 200, body: { enabled, publicKey } };
    }
    if (action === 'dispatch') {
      const key = process.env.MAPDULE_PUSH_DISPATCH_KEY;
      if (!key || key.length < 32 || typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(key)
        || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(key))) fail(401, '예약 실행 인증이 필요합니다.');
      return { status: 200, body: await getService(options).dispatch() };
    }
    if (!['schedule', 'cancel'].includes(action)) fail(404, '알림 API를 찾을 수 없습니다.');
    return { status: 200, body: await runLimited(clientKey, () => getService(options)[action](body, token)) };
  } catch (error) {
    return { status: error.statusCode || 500, retryAfter: error.retryAfter,
      body: { error: error.statusCode === 429 ? '알림 요청이 많아요. 잠시 후 다시 시도해 주세요.'
        : error.statusCode ? error.message : '알림 서버에서 오류가 발생했습니다.' } };
  }
}
async function dispatchLocalDepartures(options) {
  if (pushConfiguration(options).enabled) await getService(options).dispatch();
}

module.exports = { createDeparturePushService, validateSubscription, handleDeparturePushRequest, dispatchLocalDepartures };