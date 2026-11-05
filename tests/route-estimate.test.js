const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateByDistance, estimateTravel } = require('../api/src/route-estimate');

const gangnam = { lat: 37.4979, lng: 127.0276 };
const seongsu = { lat: 37.5446, lng: 127.0559 };

test('estimates travel time with mode-specific speeds and treats the same place as zero minutes', () => {
  assert.equal(estimateByDistance(50, 'walk').travelMinutes, 0);
  const walk = estimateByDistance(2000, 'walk').travelMinutes;
  const transit = estimateByDistance(2000, 'transit').travelMinutes;
  const car = estimateByDistance(2000, 'car').travelMinutes;
  assert.equal(walk, Math.ceil(2600 / 1000 / 4.5 * 60));
  assert.equal(transit, Math.ceil(2600 / 1000 / 20 * 60) + 5);
  assert.ok(car < transit && transit < walk);
});

test('uses Kakao Mobility for car routes when a key is configured and falls back to the estimate on failure', async () => {
  const previousKey = process.env.KAKAO_REST_API_KEY;
  const previousFetch = global.fetch;
  process.env.KAKAO_REST_API_KEY = 'rest-key';
  try {
    let requested;
    global.fetch = async (url, options) => {
      requested = { url: new URL(url), headers: options.headers };
      return new Response(JSON.stringify({ routes: [{ result_code: 0, summary: { distance: 7300, duration: 1290 } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    };
    const routed = await estimateTravel(gangnam, seongsu, 'car');
    assert.equal(routed.method, 'kakao-mobility');
    assert.equal(routed.travelMinutes, 22);
    assert.equal(requested.url.searchParams.get('origin'), `${gangnam.lng},${gangnam.lat}`);
    assert.equal(requested.headers.Authorization, 'KakaoAK rest-key');

    global.fetch = async () => new Response('{}', { status: 401 });
    const fallback = await estimateTravel(gangnam, seongsu, 'car');
    assert.equal(fallback.method, 'estimate');
    assert.ok(fallback.travelMinutes > 0);

    let called = false;
    global.fetch = async () => { called = true; return new Response('{}'); };
    const transit = await estimateTravel(gangnam, seongsu, 'transit');
    assert.equal(transit.method, 'estimate');
    assert.equal(called, false);
  } finally {
    if (previousKey === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = previousKey;
    global.fetch = previousFetch;
  }
});
