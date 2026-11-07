const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../server');

const AI_KEYS = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT', 'KAKAO_REST_API_KEY', 'ODSAY_API_KEY'];

test('day plan over HTTP flags conflicts, tight moves and safe moves without any AI service', async (context) => {
  const saved = AI_KEYS.map((key) => process.env[key]);
  AI_KEYS.forEach((key) => delete process.env[key]);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    AI_KEYS.forEach((key, index) => {
      if (saved[index] !== undefined) process.env[key] = saved[index];
    });
    await new Promise((resolve) => server.close(resolve));
  });

  const gangnam = { lat: 37.4979, lng: 127.0276 };
  const yeoksam = { lat: 37.5008, lng: 127.0364 };
  const seongsu = { lat: 37.5446, lng: 127.0559 };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-11-06',
      transportMode: 'transit',
      events: [
        { id: 'a', title: '회의', startTime: '09:00', endTime: '10:00', location: '강남역', place: gangnam },
        { id: 'b', title: '점심', startTime: '11:00', endTime: '12:00', location: '역삼역', place: yeoksam },
        { id: 'c', title: '미팅', startTime: '12:10', endTime: '13:00', location: '성수역', place: seongsu },
        { id: 'd', title: '겹치는 일정', startTime: '12:30', endTime: '13:30', location: '성수역', place: seongsu },
        { id: 'e', title: '장소 없음', startTime: '15:00', endTime: '16:00' }
      ]
    })
  });
  const plan = await response.json();

  assert.equal(response.status, 200);
  assert.equal(plan.aiSummary, false);
  assert.deepEqual(plan.transitions.map((item) => item.status), ['ok', 'tight', 'conflict', 'unknown']);
  const [safe, tight] = plan.transitions;
  assert.equal(safe.fallbackReason, 'not-configured');
  assert.ok(safe.dataUpdatedAt);
  assert.equal(safe.recommendedDepartureTime, '10:46');
  assert.ok(tight.bufferMinutes < 0);
  assert.equal(tight.recommendedDepartureTime, `${String(Math.floor((12 * 60 + 10 - tight.travelMinutes - 10) / 60)).padStart(2, '0')}:${String((12 * 60 + 10 - tight.travelMinutes - 10) % 60).padStart(2, '0')}`);
  assert.match(plan.summary, /겹치거나|부족/);
  assert.ok(plan.recommendations.some((item) => item.includes('겹쳐요')));
});
