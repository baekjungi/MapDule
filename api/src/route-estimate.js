const KAKAO_DIRECTIONS_URL = 'https://apis-navi.kakaomobility.com/v1/directions';
const ODSAY_BASE_URL = 'https://api.odsay.com/v1/api/';
const KAKAO_TIMEOUT_MS = 5000;
const MAX_TRAVEL_MINUTES = 360;

const MODE_LABELS = { walk: '도보', transit: '대중교통', car: '자동차' };

function validPoint(point) {
  return point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

function getRouteStatus() {
  return {
    car: Boolean(process.env.KAKAO_REST_API_KEY),
    walk: Boolean(process.env.ODSAY_API_KEY),
    transit: Boolean(process.env.ODSAY_API_KEY)
  };
}

function distanceMeters(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.lat - first.lat);
  const longitudeDelta = radians(second.lng - first.lng);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, arc))));
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
    if (route?.result_code !== 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(distance) || distance <= 0) return null;
    return {
      travelMinutes: Math.ceil(duration / 60),
      routeMeters: Math.round(distance),
      walkingMinutes: 0,
      transferCount: 0,
      method: 'kakao-mobility',
      detail: '카카오모빌리티 자동차 경로(현재 교통 반영)로 계산했어요.'
    };
  } catch {
    console.error('Kakao Mobility directions could not be completed.');
    return null;
  }
}

async function requestOdsayRoute(from, to, mode) {
  const key = process.env.ODSAY_API_KEY;
  if (!key) return null;
  const url = new URL(mode === 'walk' ? 'searchWalkPathV2' : 'searchPubTransPathT', ODSAY_BASE_URL);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('output', 'json');
  if (mode === 'walk') {
    url.searchParams.set('opt', 'reco');
    url.searchParams.set('loc', `${from.lng},${from.lat},${to.lng},${to.lat}`);
  } else {
    for (const [name, value] of Object.entries({ SX: from.lng, SY: from.lat, EX: to.lng, EY: to.lat, SearchType: 0 })) {
      url.searchParams.set(name, String(value));
    }
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(KAKAO_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload.error) return null;
    const paths = payload.result?.path;
    if (!Array.isArray(paths)) return null;
    if (mode === 'walk') {
      const path = paths[0];
      const summary = path?.recommend?.summary;
      if (path?.hasPathResult !== true || !Number.isFinite(summary?.duration) || summary.duration <= 0
        || !Number.isFinite(summary.distance) || summary.distance <= 0) return null;
      return {
        travelMinutes: Math.ceil(summary.duration / 60),
        routeMeters: Math.round(summary.distance),
        walkingMinutes: Math.ceil(summary.duration / 60),
        transferCount: 0,
        method: 'odsay-walk',
        detail: 'ODsay 도보 경로로 계산했어요.'
      };
    }
    if (payload.result.searchType !== 0) return null;
    const path = paths.filter((item) => Number.isFinite(item.info?.totalTime) && item.info.totalTime > 0
      && Number.isFinite(item.info.totalDistance) && item.info.totalDistance > 0)
      .sort((first, second) => first.info.totalTime - second.info.totalTime)[0];
    if (!path || !Array.isArray(path.subPath)) return null;
    const walking = path.subPath.filter((part) => part.trafficType === 3);
    const rides = path.subPath.filter((part) => part.trafficType === 1 || part.trafficType === 2);
    if (walking.some((part) => !Number.isFinite(part.sectionTime) || part.sectionTime < 0)) return null;
    return {
      travelMinutes: Math.ceil(path.info.totalTime),
      routeMeters: Math.round(path.info.totalDistance),
      walkingMinutes: Math.ceil(walking.reduce((total, part) => total + part.sectionTime, 0)),
      transferCount: Math.max(0, rides.length - 1),
      method: 'odsay-transit',
      detail: 'ODsay 대중교통 경로(도보 포함)로 계산했어요. 실시간 지연·첫차·막차는 별도 확인이 필요해요.'
    };
  } catch {
    return null;
  }
}

async function estimateTravel(from, to, mode) {
  if (!validPoint(from) || !validPoint(to) || !Object.hasOwn(MODE_LABELS, mode)) return null;
  const straightMeters = distanceMeters(from, to);
  const dataUpdatedAt = new Date().toISOString();
  if (straightMeters >= 100) {
    const routed = mode === 'car' ? await requestKakaoCarRoute(from, to) : await requestOdsayRoute(from, to, mode);
    if (routed) return { ...routed, straightLineDistanceMeters: straightMeters, dataUpdatedAt };
  }
  return {
    ...estimateByDistance(straightMeters, mode),
    straightLineDistanceMeters: straightMeters,
    dataUpdatedAt,
    fallbackReason: straightMeters < 100 ? null : getRouteStatus()[mode] ? 'provider-unavailable' : 'not-configured'
  };
}

module.exports = { distanceMeters, estimateByDistance, estimateTravel, validPoint, getRouteStatus };
