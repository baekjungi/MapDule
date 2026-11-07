const { estimateTravel, validPoint } = require('./route-estimate');

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

async function recommendMidpoint(body, route = estimateTravel) {
  if (!body || !Array.isArray(body.participants) || body.participants.length < 2 || body.participants.length > 6
    || !Array.isArray(body.candidates) || body.candidates.length < 1 || body.candidates.length > 5
    || !['walk', 'transit', 'car'].includes(body.mode)) {
    throw invalid('참가자 2~6명, 후보 장소 1~5곳과 이동 수단을 확인해 주세요.');
  }
  const clean = (item) => {
    if (!item || !validPoint(item.place) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) {
      throw invalid('출발지와 후보 장소의 이름·좌표를 확인해 주세요.');
    }
    return { name: item.name.trim(), place: { lat: item.place.lat, lng: item.place.lng } };
  };
  const participants = body.participants.map(clean);
  const candidates = body.candidates.map(clean);
  if (new Set(candidates.map((item) => `${item.place.lat},${item.place.lng}`)).size !== candidates.length) {
    throw invalid('같은 후보 장소를 중복해서 입력하지 마세요.');
  }
  const results = [];
  for (const candidate of candidates) {
    const travels = await Promise.all(participants.map(async (participant) => {
      const travel = await route(participant.place, candidate.place, body.mode);
      if (!travel || !Number.isFinite(travel.travelMinutes) || travel.travelMinutes < 0) {
        throw Object.assign(new Error('후보 장소의 이동 시간을 계산하지 못했어요.'), { statusCode: 502 });
      }
      return { name: participant.name, ...travel };
    }));
    const minutes = travels.map((item) => item.travelMinutes);
    const maximumMinutes = Math.max(...minutes);
    const spreadMinutes = maximumMinutes - Math.min(...minutes);
    results.push({
      ...candidate,
      travels,
      averageMinutes: Math.round(minutes.reduce((total, value) => total + value, 0) / minutes.length),
      maximumMinutes,
      spreadMinutes,
      estimated: travels.some((item) => item.method === 'estimate'),
      walkingMinutes: travels.reduce((total, item) => total + (item.walkingMinutes || 0), 0),
      transferCount: travels.reduce((total, item) => total + (item.transferCount || 0), 0)
    });
  }
  results.sort((first, second) => first.spreadMinutes - second.spreadMinutes
    || first.maximumMinutes - second.maximumMinutes
    || first.transferCount - second.transferCount
    || first.walkingMinutes - second.walkingMinutes);
  return { mode: body.mode, candidates: results, estimated: results.some((item) => item.estimated), comparedAt: new Date().toISOString() };
}

module.exports = { recommendMidpoint };