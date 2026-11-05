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

test('asks Azure OpenAI to estimate travel from real events and validates exact schedule buffers', async () => {
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
        transitions: [{ fromId: 'meeting', toId: 'dinner', travelMinutes: 25, reason: '직선거리와 대중교통 평균 속도를 이용한 추정입니다.' }],
        recommendations: ['식사 전 35분 여유가 있어요.'],
        assumptions: ['실시간 교통 정보는 반영되지 않았어요.']
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
    assert.match(requestBody.messages[1].content, /straightLineDistanceMeters/);
    assert.equal(result.transitions[0].gapMinutes, 60);
    assert.ok(result.transitions[0].straightLineDistanceMeters > 0);
    assert.equal(result.transitions[0].travelMinutes, 25);
    assert.equal(result.transitions[0].bufferMinutes, 35);
    assert.equal(result.transitions[0].recommendedDepartureTime, '10:25');
    assert.equal(result.transitions[0].status, 'ok');
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

test('rejects invalid AI travel results and does not invent time when coordinates are missing', async () => {
  const previous = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    fetch: global.fetch
  };
  process.env.AZURE_OPENAI_ENDPOINT = 'https://resource.example';
  process.env.AZURE_OPENAI_API_KEY = 'test-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'schedule-planner';
  let travelMinutes = null;
  global.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      summary: '위치 좌표가 없어 이동 시간은 계산할 수 없습니다.',
      transitions: [{ fromId: 'one', toId: 'two', travelMinutes, reason: '장소 좌표가 없습니다.' }],
      recommendations: [],
      assumptions: []
    }) } }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await analyzeSchedulePlan({
      date: '2026-11-04',
      events: [
        { id: 'one', title: '첫 일정', date: '2026-11-04', startTime: '09:00', endTime: '10:00', location: '장소 A' },
        { id: 'two', title: '다음 일정', date: '2026-11-04', startTime: '10:30', endTime: '11:00', location: '장소 B' }
      ]
    });
    assert.equal(result.transitions[0].travelMinutes, null);
    assert.equal(result.transitions[0].status, 'unknown');
    assert.ok(result.assumptions.some((item) => item.includes('좌표가 없는')));

    travelMinutes = 500;
    await assert.rejects(
      analyzeSchedulePlan({
        date: '2026-11-04',
        events: [
          { id: 'one', title: '첫 일정', date: '2026-11-04', startTime: '09:00', endTime: '10:00', location: '장소 A', place: { lat: 37.5, lng: 127 } },
          { id: 'two', title: '다음 일정', date: '2026-11-04', startTime: '10:30', endTime: '11:00', location: '장소 B', place: { lat: 37.51, lng: 127.01 } }
        ]
      }),
      (error) => error.code === 'AZURE_OPENAI_INVALID_PLAN'
    );
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
