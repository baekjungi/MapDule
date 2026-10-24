const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSchedulePrompt } = require('../api/src/ai-schedule');

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
