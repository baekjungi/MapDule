const test = require('node:test');
const assert = require('node:assert/strict');
const { mobilityOperation } = require('../api/src/mobility');

test('place search keeps bounded Kakao results and validates search inputs', async () => {
  const savedKey = process.env.KAKAO_REST_API_KEY;
  const savedFetch = global.fetch;
  try {
    delete process.env.KAKAO_REST_API_KEY;
    await assert.rejects(mobilityOperation('search', { query: '역' }), { statusCode: 503 });
    process.env.KAKAO_REST_API_KEY = 'test';
    let requested;
    global.fetch = async (url) => {
      requested = url;
      return { ok: true, json: async () => ({ documents: [
        { place_name: '카페', x: '127', y: '37.45' },
        { place_name: '오류', x: 'NaN', y: '37' }
      ] }) };
    };
    const result = await mobilityOperation('search', { query: ' 카페 ' });
    assert.equal(result.places.length, 1);
    assert.equal(requested.pathname, '/v2/local/search/keyword.json');
    assert.equal(requested.searchParams.get('query'), '카페');
    assert.equal(requested.searchParams.get('size'), '5');
    await assert.rejects(mobilityOperation('search', { query: '' }), { statusCode: 400 });
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = savedKey;
  }
});

test('place search falls back to address search when keyword results are empty', async () => {
  const savedKey = process.env.KAKAO_REST_API_KEY;
  const savedFetch = global.fetch;
  const paths = [];
  try {
    process.env.KAKAO_REST_API_KEY = 'test';
    global.fetch = async (url) => {
      paths.push(url.pathname);
      return { ok: true, json: async () => ({
        documents: paths.length === 1 ? [] : [{ address_name: '서울 주소', x: '127', y: '37.5' }]
      }) };
    };
    const result = await mobilityOperation('search', { query: '서울 주소' });
    assert.deepEqual(paths, ['/v2/local/search/keyword.json', '/v2/local/search/address.json']);
    assert.deepEqual(result.places, [{ name: '서울 주소', address: '서울 주소', place: { lat: 37.5, lng: 127 } }]);
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = savedKey;
  }
});

test('removed recommendation operations return not found', async () => {
  for (const action of ['nearby', 'midpoint']) {
    await assert.rejects(mobilityOperation(action, {}), { statusCode: 404 });
  }
});
