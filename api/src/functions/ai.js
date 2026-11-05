const { app } = require('@azure/functions');
const { getAiStatus, parseSchedulePrompt, analyzeSchedulePlan } = require('../ai-schedule');
const { readLimitedBody } = require('../request-body');
const { runAiRequest } = require('../ai-access');

function jsonResponse(status, body, retryAfter = 60) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(status === 429 ? { 'Retry-After': String(retryAfter) } : {})
    }
  });
}

async function handleAiRequest(request, context, operation, label) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return jsonResponse(415, { error: '요청 Content-Type은 application/json이어야 합니다.' });
  }
  let body;
  try {
    const { text, tooLarge } = await readLimitedBody(request);
    if (tooLarge) return jsonResponse(413, { error: '요청 본문이 너무 큽니다.' });
    body = JSON.parse(text);
  } catch {
    context.error(`${label} request body could not be read as JSON.`);
    return jsonResponse(400, { error: '요청 본문은 올바른 JSON이어야 합니다.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(400, { error: '요청 본문 형식이 올바르지 않습니다.', code: 'INVALID_REQUEST' });
  }
  try {
    const clientKey = (request.headers.get('x-forwarded-for') || '').split(',').at(-1)?.trim() || 'unknown';
    return jsonResponse(200, await runAiRequest(clientKey, () => operation(body)));
  } catch (error) {
    context.error(`${label} request failed (${error.code || 'UNKNOWN'}).`);
    return jsonResponse(error.statusCode || 500, {
      error: error.message,
      ...(error.code ? { code: error.code } : {})
    }, error.retryAfter);
  }
}

app.http('ai-status', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'ai/status',
  handler: async () => jsonResponse(200, { ...getAiStatus(), authRequired: false })
});

app.http('ai-parse', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'ai/parse',
  handler: async (request, context) => handleAiRequest(request, context, ({ prompt }) => parseSchedulePrompt(prompt), 'AI schedule')
});

app.http('ai-plan', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'ai/plan',
  handler: async (request, context) => handleAiRequest(request, context, analyzeSchedulePlan, 'AI schedule plan')
});
