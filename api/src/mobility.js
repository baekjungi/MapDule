const { recommendMidpoint } = require('./midpoint');
const { getRouteStatus, validPoint } = require('./route-estimate');
const { createAiRequestLimiter } = require('./ai-access');

const runLimited = createAiRequestLimiter();
const categories = { cafe: 'CE7', restaurant: 'FD6', station: 'SW8' };

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

async function searchKakao(kind, params) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) fail(503, '장소 검색 키가 설정되지 않았어요. 장소의 위도·경도를 직접 입력할 수 있어요.');
  try {
    const url = new URL(`https://dapi.kakao.com/v2/local/search/${kind}.json`);
    url.search = new URLSearchParams({ ...params, size: '5' }).toString();
    const response = await fetch(url, {
      headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(5000), redirect: 'error'
    });
    if (!response.ok) fail(502, '장소 검색에 실패했어요. 잠시 후 다시 시도해 주세요.');
    const payload = await response.json();
    if (!Array.isArray(payload.documents)) fail(502, '장소 검색 결과를 확인하지 못했어요.');
    return payload.documents.map((item) => ({
      name: String(item.place_name || item.address_name || '').slice(0, 120),
      address: String(item.road_address_name || item.address_name || '').slice(0, 200),
      place: { lat: Number(item.y), lng: Number(item.x) }
    })).filter((item) => item.name && validPoint(item.place)).slice(0, 5);
  } catch (error) {
    if (error.statusCode) throw error;
    fail(502, '장소 검색에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}

async function mobilityOperation(action, body) {
  if (action === 'status') return { routes: getRouteStatus(), places: Boolean(process.env.KAKAO_REST_API_KEY) };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '요청 본문 형식이 올바르지 않습니다.');
  if (action === 'search') {
    if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 120) fail(400, '검색어를 확인해 주세요.');
    let places = await searchKakao('keyword', { query: body.query.trim() });
    if (!places.length) places = await searchKakao('address', { query: body.query.trim() });
    return { places };
  }
  if (action === 'nearby') {
    const points = body.participants;
    if (!Array.isArray(points) || points.length < 2 || points.length > 6
      || points.some((item) => !validPoint(item?.place)) || !Object.hasOwn(categories, body.category)) {
      fail(400, '참가자 출발지와 장소 종류를 확인해 주세요.');
    }
    const center = points.reduce((total, item) => ({ lat: total.lat + item.place.lat / points.length, lng: total.lng + item.place.lng / points.length }), { lat: 0, lng: 0 });
    return { places: await searchKakao('category', { category_group_code: categories[body.category], x: String(center.lng), y: String(center.lat), radius: '5000', sort: 'distance' }) };
  }
  if (action === 'midpoint') return recommendMidpoint(body);
  fail(404, '이동 API를 찾을 수 없습니다.');
}

async function handleMobilityRequest(action, body, clientKey) {
  try {
    const result = action === 'status' ? await mobilityOperation(action, body)
      : await runLimited(clientKey, () => mobilityOperation(action, body));
    return { status: 200, body: result };
  } catch (error) {
    return { status: error.statusCode || 500, retryAfter: error.retryAfter,
      body: { error: error.statusCode === 429 ? '장소·경로 요청이 많아요. 잠시 후 다시 시도해 주세요.'
        : error.statusCode ? error.message : '이동 서버에서 오류가 발생했습니다.' } };
  }
}

module.exports = { handleMobilityRequest, mobilityOperation };