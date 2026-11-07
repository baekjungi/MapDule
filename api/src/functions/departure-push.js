const { app } = require('@azure/functions');
const { readLimitedBody } = require('../request-body');
const { handleDeparturePushRequest } = require('../departure-push');

for (const action of ['status', 'schedule', 'cancel', 'dispatch']) {
  app.http(`push-${action}`, {
    methods: [action === 'status' ? 'GET' : 'POST'], authLevel: 'anonymous', route: `push/${action}`,
    handler: async (request) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      let body = {};
      if (action !== 'status') {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
          return new Response(JSON.stringify({ error: '요청 Content-Type은 application/json이어야 합니다.' }), { status: 415, headers });
        }
        try {
          const { text, tooLarge } = await readLimitedBody(request);
          if (tooLarge) return new Response(JSON.stringify({ error: '요청 본문이 너무 큽니다.' }), { status: 413, headers });
          body = JSON.parse(text);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
        } catch {
          return new Response(JSON.stringify({ error: '요청 본문은 올바른 JSON 객체여야 합니다.' }), { status: 400, headers });
        }
      }
      const client = (request.headers.get('x-forwarded-for') || '').split(',').at(-1)?.trim() || 'unknown';
      // Static Web Apps does not forward the Authorization header to managed APIs, so use a custom header.
      const token = request.headers.get('x-mapdule-push-token')
        || (request.headers.get('authorization') || '').replace(/^Bearer /, '');
      const result = await handleDeparturePushRequest(action, body, token, client);
      return new Response(JSON.stringify(result.body), { status: result.status, headers: {
        ...headers, ...(result.status === 429 ? { 'Retry-After': String(result.retryAfter) } : {})
      } });
    }
  });
}