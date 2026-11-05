const crypto = require('node:crypto');

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_CLIENTS = 5000;

function createAiRequestLimiter({ now = () => Date.now() } = {}) {
  const clients = new Map();
  let activeRequests = 0;

  function reject(retryAfter) {
    throw Object.assign(new Error('AI 요청이 많아요. 잠시 후 다시 시도해 주세요.'), {
      statusCode: 429, code: 'AI_RATE_LIMITED', retryAfter: Math.max(1, Math.ceil(retryAfter))
    });
  }

  return async function run(clientKey, operation) {
    const time = now();
    const key = crypto.createHash('sha256').update(String(clientKey || 'unknown').slice(0, 128)).digest('hex');
    let client = clients.get(key);
    if (!client || time - client.dayStart >= DAY_MS) {
      if (!client && clients.size >= MAX_CLIENTS) {
        for (const [id, entry] of clients) {
          if (time - entry.dayStart >= DAY_MS) clients.delete(id);
        }
        if (clients.size >= MAX_CLIENTS) reject(60);
      }
      client = { dayStart: time, dayCount: 0, minuteStart: time, minuteCount: 0 };
      clients.set(key, client);
    }
    if (time - client.minuteStart >= MINUTE_MS) {
      client.minuteStart = time;
      client.minuteCount = 0;
    }
    if (client.dayCount >= 100) reject((DAY_MS - (time - client.dayStart)) / 1000);
    if (client.minuteCount >= 10) reject((MINUTE_MS - (time - client.minuteStart)) / 1000);
    if (activeRequests >= 3) reject(5);
    client.minuteCount += 1;
    client.dayCount += 1;
    activeRequests += 1;
    try {
      return await operation();
    } finally {
      activeRequests -= 1;
    }
  };
}

const runAiRequest = createAiRequestLimiter();

module.exports = { createAiRequestLimiter, runAiRequest };
