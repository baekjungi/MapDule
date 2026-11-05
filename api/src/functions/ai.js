const { app } = require('@azure/functions');
const { getAiStatus, parseSchedulePrompt, analyzeSchedulePlan } = require('../ai-schedule');
const { readLimitedBody } = require('../request-body');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
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
    return jsonResponse(200, await operation(body));
  } catch (error) {
    context.error(`${label} request failed (${error.code || 'UNKNOWN'}).`);
    return jsonResponse(error.statusCode || 500, {
      error: error.message,
      ...(error.code ? { code: error.code } : {})
    });
  }
}

app.http('ai-status', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'ai/status',
  handler: async () => jsonResponse(200, { ...getAiStatus(), authRequired: true })
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
