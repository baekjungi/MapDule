const test = require('node:test');
const assert = require('node:assert/strict');

test('place search uses bounded Kakao results and validates nearby inputs', async () => {
  const { mobilityOperation } = require('../api/src/mobility');
  const originalKey = process.env.KAKAO_REST_API_KEY;
  const originalFetch = global.fetch;
  try {
    delete process.env.KAKAO_REST_API_KEY;
    await assert.rejects(mobilityOperation('search', { query: '역' }), { statusCode: 503 });
    process.env.KAKAO_REST_API_KEY = 'test';
    let requested;
    global.fetch = async (url) => {
      requested = url;
      return { ok: true, json: async () => ({ documents: [{ place_name: '카페', x: '127', y: '37.45' }, { place_name: '오류', x: 'NaN', y: '37' }] }) };
    };
    const result = await mobilityOperation('nearby', { participants: [{ place: { lat: 37.4, lng: 127 } }, { place: { lat: 37.5, lng: 127 } }], category: 'cafe' });
    assert.equal(result.places.length, 1);
    assert.equal(requested.searchParams.get('category_group_code'), 'CE7');
    assert.equal(requested.searchParams.get('radius'), '5000');
    await assert.rejects(mobilityOperation('nearby', { participants: [], category: '__proto__' }), { statusCode: 400 });
    await assert.rejects(mobilityOperation('search', { query: '' }), { statusCode: 400 });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = originalKey;
  }
});
const { recommendMidpoint } = require('../api/src/midpoint');

const request = () => ({
  mode: 'transit',
  participants: [
    { name: '가', place: { lat: 37.4, lng: 127 } },
    { name: '나', place: { lat: 37.5, lng: 127 } }
  ],
  candidates: [
    { name: '가까운 후보', place: { lat: 37.41, lng: 127 } },
    { name: '균등 후보', place: { lat: 37.45, lng: 127 } }
  ]
});

test('ranks candidate travel-time spread before maximum duration and exposes estimates', async () => {
  const result = await recommendMidpoint(request(), async (from, to) => ({
    travelMinutes: to.lat === 37.45 ? (from.lat === 37.4 ? 25 : 27) : (from.lat === 37.4 ? 5 : 30),
    method: to.lat === 37.45 ? 'odsay-transit' : 'estimate',
    transferCount: 1, walkingMinutes: 4
  }));
  assert.equal(result.candidates[0].name, '균등 후보');
  assert.equal(result.candidates[0].spreadMinutes, 2);
  assert.equal(result.candidates[0].averageMinutes, 26);
  assert.equal(result.candidates[0].maximumMinutes, 27);
  assert.equal(result.candidates[0].estimated, false);
  assert.equal(result.estimated, true);
  assert.ok(result.comparedAt);
});

test('rejects invalid participants, modes, coordinates and duplicate candidates without route calls', async () => {
  let calls = 0;
  const route = async () => { calls += 1; };
  for (const body of [null, { ...request(), mode: 'fly' }, { ...request(), participants: [] },
    { ...request(), candidates: [request().candidates[0], request().candidates[0]] },
    { ...request(), participants: [{ name: '가', place: { lat: 100, lng: 127 } }, request().participants[1]] }]) {
    await assert.rejects(recommendMidpoint(body, route), (error) => error.statusCode === 400);
  }
  assert.equal(calls, 0);
});

test('works without service keys and never labels straight-line estimates as real routes', async () => {
  const saved = process.env.ODSAY_API_KEY;
  delete process.env.ODSAY_API_KEY;
  try {
    const result = await recommendMidpoint(request());
    assert.equal(result.estimated, true);
    assert.ok(result.candidates.every((candidate) => candidate.travels.every((travel) => travel.method === 'estimate')));
  } finally {
    if (saved !== undefined) process.env.ODSAY_API_KEY = saved;
  }
});