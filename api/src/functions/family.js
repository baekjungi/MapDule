const { app } = require('@azure/functions');
const { handleFamilyRequest } = require('../family-runtime');

const MAX_REQUEST_BYTES = 16 * 1024;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(status === 429 ? { 'Retry-After': '60' } : {})
    }
  });
}

async function readLimitedBody(request) {
  if (!request.body) return { text: '', tooLarge: false };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => {});
      return { text: '', tooLarge: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
}

function clientKeyFor(request) {
  const forwardedFor = request.headers.get('x-forwarded-for') || '';
  return forwardedFor.split(',').at(-1)?.trim() || 'unknown';
}

app.http('family', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'family/{action}',
  handler: async (request, context) => {
    let body = {};
    if (request.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
        return jsonResponse(415, { error: '요청 Content-Type은 application/json이어야 합니다.' });
      }
      const contentLength = Number(request.headers.get('content-length') || 0);
      if (contentLength > MAX_REQUEST_BYTES) {
        return jsonResponse(413, { error: '요청 본문이 너무 큽니다.' });
      }
      const { text, tooLarge } = await readLimitedBody(request);
      if (tooLarge) {
        return jsonResponse(413, { error: '요청 본문이 너무 큽니다.' });
      }
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return jsonResponse(400, { error: '요청 본문은 올바른 JSON이어야 합니다.' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return jsonResponse(400, { error: '요청 본문 형식이 올바르지 않습니다.' });
      }
    }

    try {
      const result = await handleFamilyRequest({
        method: request.method,
        action: request.params.action,
        body,
        query: Object.fromEntries(request.query.entries()),
        credential: request.headers.get('x-mapdule-member'),
        clientKey: clientKeyFor(request)
      });
      return jsonResponse(result.status, result.body);
    } catch (error) {
      context.error(`Family request failed (${error.statusCode || 'UNKNOWN'}).`);
      return jsonResponse(error.statusCode === 429 ? 429 : 500, {
        error: error.statusCode === 429 ? error.message : '가족 서버에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
        ...(error.code ? { code: error.code } : {})
      });
    }
  }
});
