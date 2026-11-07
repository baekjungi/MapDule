const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateByDistance, estimateTravel } = require('../api/src/route-estimate');

const gangnam = { lat: 37.4979, lng: 127.0276 };
const seongsu = { lat: 37.5446, lng: 127.0559 };

test('uses ODsay walking seconds and urban transit minutes and rejects incomplete routes', async () => {
  const previousKey = process.env.ODSAY_API_KEY;
  const previousFetch = global.fetch;
  process.env.ODSAY_API_KEY = 'odsay-test-key';
  try {
    let requested;
    let payload = { result: { path: [{ hasPathResult: true, recommend: { summary: { duration: 961, distance: 1200 } } }] } };
    global.fetch = async (url) => {
      requested = new URL(url);
      return Response.json(payload);
    };
    const walk = await estimateTravel(gangnam, seongsu, 'walk');
    assert.equal(walk.method, 'odsay-walk');
    assert.equal(walk.travelMinutes, 17);
    assert.equal(walk.walkingMinutes, 17);
    assert.equal(requested.searchParams.get('loc'), `${gangnam.lng},${gangnam.lat},${seongsu.lng},${seongsu.lat}`);
    payload = { result: { searchType: 0, path: [
      { info: { totalTime: 48, totalDistance: 9000 }, subPath: [] },
      { info: { totalTime: 32, totalDistance: 7000 }, subPath: [
        { trafficType: 3, sectionTime: 6 }, { trafficType: 1 }, { trafficType: 2 }, { trafficType: 3, sectionTime: 2 }
      ] }
    ] } };
    const transit = await estimateTravel(gangnam, seongsu, 'transit');
    assert.equal(transit.method, 'odsay-transit');
    assert.equal(transit.travelMinutes, 32);
    assert.equal(transit.walkingMinutes, 8);
    assert.equal(transit.transferCount, 1);
    assert.equal(requested.searchParams.get('SX'), String(gangnam.lng));
    assert.equal(requested.searchParams.get('apiKey'), 'odsay-test-key');
    assert.ok(transit.dataUpdatedAt);
    payload.result.searchType = 1;
    assert.equal((await estimateTravel(gangnam, seongsu, 'transit')).method, 'estimate');
    payload = { error: { code: '-99' } };
    assert.equal((await estimateTravel(gangnam, seongsu, 'walk')).fallbackReason, 'provider-unavailable');
    global.fetch = async () => { throw new Error('timeout'); };
    assert.equal((await estimateTravel(gangnam, seongsu, 'transit')).method, 'estimate');
    assert.equal(await estimateTravel({ lat: 91, lng: 127 }, seongsu, 'walk'), null);
    assert.equal(await estimateTravel(gangnam, seongsu, 'unknown'), null);
  } finally {
    if (previousKey === undefined) delete process.env.ODSAY_API_KEY;
    else process.env.ODSAY_API_KEY = previousKey;
    global.fetch = previousFetch;
  }
});

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
