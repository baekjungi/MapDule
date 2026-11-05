const KAKAO_DIRECTIONS_URL = 'https://apis-navi.kakaomobility.com/v1/directions';
const KAKAO_TIMEOUT_MS = 5000;
const MAX_TRAVEL_MINUTES = 360;

const MODE_LABELS = { walk: '도보', transit: '대중교통', car: '자동차' };

function distanceMeters(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.lat - first.lat);
  const longitudeDelta = radians(second.lng - first.lng);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(arc)));
}

// 직선거리에 우회계수와 평균 속도를 적용한 추정. 실제 경로 API가 없을 때의 기본값이다.
function estimateByDistance(straightMeters, mode) {
  if (straightMeters < 100) {
    return { travelMinutes: 0, routeMeters: straightMeters, method: 'estimate', detail: '같은 장소로 보고 이동 시간을 0분으로 계산했어요.' };
  }
  const longDistance = straightMeters > 15000;
  const detour = longDistance ? 1.15 : 1.3;
  const routeMeters = Math.round(straightMeters * detour);
  const speedKmh = mode === 'walk' ? 4.5
    : mode === 'car' ? (longDistance ? 85 : 25)
      : (longDistance ? 70 : 20);
  const transferMinutes = mode === 'transit' && straightMeters > 1500 ? 5 : 0;
  const minutes = Math.ceil(routeMeters / 1000 / speedKmh * 60) + transferMinutes;
  const km = (straightMeters / 1000).toFixed(1);
  return {
    travelMinutes: Math.min(minutes, MAX_TRAVEL_MINUTES),
    routeMeters,
    method: 'estimate',
    detail: `직선 ${km}km에 우회계수 ${detour}를 적용한 ${MODE_LABELS[mode]} 평균 속도 추정${transferMinutes ? '(환승·대기 5분 포함)' : ''}입니다.`
  };
}

async function requestKakaoCarRoute(from, to) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return null;
  const url = new URL(KAKAO_DIRECTIONS_URL);
  url.searchParams.set('origin', `${from.lng},${from.lat}`);
  url.searchParams.set('destination', `${to.lng},${to.lat}`);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `KakaoAK ${key}` },
      signal: AbortSignal.timeout(KAKAO_TIMEOUT_MS)
    });
    if (!response.ok) {
      console.error(`Kakao Mobility directions failed with status ${response.status}.`);
      return null;
    }
    const route = (await response.json())?.routes?.[0];
    const duration = route?.summary?.duration;
    const distance = route?.summary?.distance;
    if (route?.result_code !== 0 || !Number.isFinite(duration) || duration < 0 || !Number.isFinite(distance)) return null;
    return {
      travelMinutes: Math.min(Math.ceil(duration / 60), MAX_TRAVEL_MINUTES),
      routeMeters: Math.round(distance),
      method: 'kakao-mobility',
      detail: '카카오모빌리티 자동차 경로(현재 교통 반영)로 계산했어요.'
    };
  } catch {
    console.error('Kakao Mobility directions could not be completed.');
    return null;
  }
}

async function estimateTravel(from, to, mode) {
  if (!from || !to) return null;
  const straightMeters = distanceMeters(from, to);
  if (mode === 'car' && straightMeters >= 100) {
    const routed = await requestKakaoCarRoute(from, to);
    if (routed) return { ...routed, straightLineDistanceMeters: straightMeters };
  }
  return { ...estimateByDistance(straightMeters, mode), straightLineDistanceMeters: straightMeters };
}

module.exports = { distanceMeters, estimateByDistance, estimateTravel };
