const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSchedulePlan, parseSchedulePrompt } = require('../api/src/ai-schedule');

test('rejects empty schedule prompts before calling Azure OpenAI', async () => {
  await assert.rejects(
    parseSchedulePrompt(' '),
    (error) => error.statusCode === 400 && error.code === 'INVALID_PROMPT'
  );
});

test('sends the configured deployment and validates its event response', async () => {
  const previous = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    fetch: global.fetch
  };
  let requestChecked = false;
  process.env.AZURE_OPENAI_ENDPOINT = 'https://resource.example';
  process.env.AZURE_OPENAI_API_KEY = 'test-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'test-deployment';
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/openai/v1/chat/completions');
    assert.equal(options.headers['api-key'], 'test-key');
    assert.equal(JSON.parse(options.body).model, 'test-deployment');
    requestChecked = true;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            events: [{
              title: '회의',
              date: '2026-10-25',
              startTime: '15:00',
              endTime: '16:00',
              allDay: false,
              category: '업무',
              location: '',
              notes: ''
            }],
            assumptions: []
          })
        }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await parseSchedulePrompt('내일 오후 3시에 회의');
    assert.equal(result.events[0].title, '회의');
    assert.equal(result.events[0].date, '2026-10-25');
    assert.equal(requestChecked, true);
  } finally {
    for (const [key, value] of [
      ['AZURE_OPENAI_ENDPOINT', previous.endpoint],
      ['AZURE_OPENAI_API_KEY', previous.key],
      ['AZURE_OPENAI_DEPLOYMENT', previous.deployment]
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = previous.fetch;
  }
});

test('uses the Responses API when the endpoint includes the responses route', async () => {
  const previous = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    fetch: global.fetch
  };
  process.env.AZURE_OPENAI_ENDPOINT = 'https://resource.example/openai/v1/responses';
  process.env.AZURE_OPENAI_API_KEY = 'test-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'test-deployment';
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/openai/v1/responses');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-deployment');
    assert.match(body.input, /json/);
    assert.match(body.input, /내일 오후 3시에 회의/);
    assert.match(body.instructions, /json/);
    assert.equal(body.text.format.type, 'json_object');
    return new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            events: [{
              title: '회의',
              date: '2026-10-25',
              startTime: '15:00',
              endTime: '16:00',
              allDay: false,
              category: '업무',
              location: '',
              notes: ''
            }],
            assumptions: []
          })
        }]
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await parseSchedulePrompt('내일 오후 3시에 회의');
    assert.equal(result.events[0].title, '회의');
  } finally {
    for (const [key, value] of [
      ['AZURE_OPENAI_ENDPOINT', previous.endpoint],
      ['AZURE_OPENAI_API_KEY', previous.key],
      ['AZURE_OPENAI_DEPLOYMENT', previous.deployment]
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = previous.fetch;
  }
});

test('calculates travel on the server and only asks Azure OpenAI to summarize the exact results', async () => {
  const previous = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    fetch: global.fetch
  };
  process.env.AZURE_OPENAI_ENDPOINT = 'https://resource.example';
  process.env.AZURE_OPENAI_API_KEY = 'test-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'schedule-planner';
  let requestBody;
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/openai/v1/chat/completions');
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: '두 일정 사이에 이동과 짧은 휴식이 가능합니다.',
        recommendations: ['식사 전 여유가 있어요.'],
        assumptions: []
      }) } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await analyzeSchedulePlan({
      date: '2026-11-04',
      transportMode: 'transit',
      events: [
        { id: 'meeting', title: '회의', date: '2026-11-04', startTime: '09:00', endTime: '10:00', location: '강남역', place: { lat: 37.4979, lng: 127.0276 } },
        { id: 'dinner', title: '저녁 약속', date: '2026-11-04', startTime: '11:00', endTime: '12:00', location: '역삼역', place: { lat: 37.5008, lng: 127.0364 } }
      ]
    });

    assert.equal(requestBody.model, 'schedule-planner');
    assert.match(requestBody.messages[1].content, /"transitions"/);
    assert.equal(result.transitions[0].gapMinutes, 60);
    assert.ok(result.transitions[0].straightLineDistanceMeters > 0);
    assert.equal(result.transitions[0].travelMinutes, 4);
    assert.equal(result.transitions[0].bufferMinutes, 56);
    assert.equal(result.transitions[0].recommendedDepartureTime, '10:46');
    assert.equal(result.transitions[0].status, 'ok');
    assert.equal(result.transitions[0].routeSource, 'estimate');
    assert.equal(result.summary, '두 일정 사이에 이동과 짧은 휴식이 가능합니다.');
    assert.equal(result.aiSummary, true);
    assert.ok(result.assumptions.some((item) => item.includes('실시간')));
  } finally {
    for (const [key, value] of [
      ['AZURE_OPENAI_ENDPOINT', previous.endpoint],
      ['AZURE_OPENAI_API_KEY', previous.key],
      ['AZURE_OPENAI_DEPLOYMENT', previous.deployment]
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = previous.fetch;
  }
});

test('still returns exact travel results with a local summary when Azure OpenAI fails or is not configured', async () => {
  const previous = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    fetch: global.fetch
  };
  const plan = {
    date: '2026-11-04',
    transportMode: 'car',
    events: [
      { id: 'one', title: '첫 일정', date: '2026-11-04', startTime: '09:00', endTime: '10:00', location: '장소 A', place: { lat: 37.5, lng: 127 } },
      { id: 'two', title: '다음 일정', date: '2026-11-04', startTime: '10:10', endTime: '11:00', location: '장소 B', place: { lat: 37.56, lng: 127.1 } }
    ]
  };
  try {
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    const local = await analyzeSchedulePlan(plan);
    assert.equal(local.transitions[0].status, 'tight');
    assert.ok(local.transitions[0].bufferMinutes < 0);
    assert.equal(local.aiSummary, false);
    assert.equal(local.aiNotice, null);
    assert.match(local.summary, /부족/);
    assert.ok(local.recommendations.length > 0);

    process.env.AZURE_OPENAI_ENDPOINT = 'https://resource.example';
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'schedule-planner';
    global.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
    const failed = await analyzeSchedulePlan(plan);
    assert.equal(failed.transitions[0].travelMinutes, local.transitions[0].travelMinutes);
    assert.equal(failed.aiSummary, false);
    assert.match(failed.aiNotice, /AI 요약/);
  } finally {
    for (const [key, value] of [
      ['AZURE_OPENAI_ENDPOINT', previous.endpoint],
      ['AZURE_OPENAI_API_KEY', previous.key],
      ['AZURE_OPENAI_DEPLOYMENT', previous.deployment]
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = previous.fetch;
  }
});

test('does not invent travel time when coordinates are missing', async () => {
  const result = await analyzeSchedulePlan({
    date: '2026-11-04',
    events: [
      { id: 'one', title: '첫 일정', date: '2026-11-04', startTime: '09:00', endTime: '10:00', location: '장소 A' },
      { id: 'two', title: '다음 일정', date: '2026-11-04', startTime: '10:30', endTime: '11:00', location: '장소 B' }
    ]
  });
  assert.equal(result.transitions[0].travelMinutes, null);
  assert.equal(result.transitions[0].status, 'unknown');
  assert.ok(result.assumptions.some((item) => item.includes('위치가 없는')));
});

test('null, empty, boolean or out-of-range coordinates never become a fabricated distance', async () => {
  const valid = { lat: 37.5, lng: 127 };
  for (const bad of [{ lat: null, lng: null }, { lat: '', lng: '' }, { lat: true, lng: true }, { lat: undefined, lng: 127 }, { lat: 91, lng: 127 }, { lat: [], lng: [] }, { lat: '37.5', lng: '127' }]) {
    const result = await analyzeSchedulePlan({
      date: '2026-11-04',
      events: [
        { id: 'one', title: '첫 일정', date: '2026-11-04', startTime: '09:00', endTime: '10:00', location: 'A', place: bad },
        { id: 'two', title: '다음 일정', date: '2026-11-04', startTime: '11:00', endTime: '12:00', location: 'B', place: valid }
      ]
    });
    assert.equal(result.transitions[0].straightLineDistanceMeters, null, JSON.stringify(bad));
    assert.equal(result.transitions[0].travelMinutes, null);
    assert.equal(result.transitions[0].status, 'unknown');
  }
});

test('keeps events that cross midnight or lack an end time instead of failing the whole analysis', async () => {
  const previous = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    fetch: global.fetch
  };
  process.env.AZURE_OPENAI_ENDPOINT = 'https://resource.example';
  process.env.AZURE_OPENAI_API_KEY = 'test-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'test-deployment';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const content = calls === 1
      ? 'not json'
      : JSON.stringify({
        events: [
          { title: '야식', date: '2026-11-04', startTime: '23:30', endTime: '01:00', allDay: false, category: '개인', location: '', notes: '' },
          { title: '회의', date: '2026-11-04', startTime: '10:00', allDay: false, category: '업무', location: '', notes: '' }
        ],
        assumptions: []
      });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await parseSchedulePrompt('오늘 밤 11시 반에 야식, 10시 회의');
    assert.equal(calls, 2);
    assert.equal(result.events[0].endTime, '23:59');
    assert.equal(result.events[1].endTime, '11:00');
    assert.ok(result.assumptions.some((item) => item.includes('맞췄어요')));
  } finally {
    for (const [key, value] of [
      ['AZURE_OPENAI_ENDPOINT', previous.endpoint],
      ['AZURE_OPENAI_API_KEY', previous.key],
      ['AZURE_OPENAI_DEPLOYMENT', previous.deployment]
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = previous.fetch;
  }
});
