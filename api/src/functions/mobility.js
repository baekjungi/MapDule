const { app } = require('@azure/functions');
const { readLimitedBody } = require('../request-body');
const { handleMobilityRequest } = require('../mobility');

for (const action of ['status', 'search', 'nearby', 'midpoint']) {
  app.http(`mobility-${action}`, {
    methods: [action === 'status' ? 'GET' : 'POST'],
    authLevel: 'anonymous',
    route: `mobility/${action}`,
    handler: async (request) => {
      let body = {};
      if (action !== 'status') {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
          return new Response(JSON.stringify({ error: '요청 Content-Type은 application/json이어야 합니다.' }), { status: 415, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        try {
          const { text, tooLarge } = await readLimitedBody(request);
          if (tooLarge) return new Response(JSON.stringify({ error: '요청 본문이 너무 큽니다.' }), { status: 413, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
          body = JSON.parse(text);
        } catch {
          return new Response(JSON.stringify({ error: '요청 본문은 올바른 JSON이어야 합니다.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
      }
      const client = (request.headers.get('x-forwarded-for') || '').split(',').at(-1)?.trim() || 'unknown';
      const result = await handleMobilityRequest(action, body, client);
      return new Response(JSON.stringify(result.body), { status: result.status, headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        ...(result.status === 429 ? { 'Retry-After': String(result.retryAfter) } : {})
      } });
    }
  });
}