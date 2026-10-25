const crypto = require('node:crypto');

// 가족 캘린더와 이동 공유 API의 핵심 로직.
// Azure Functions(api/src/functions/family.js)와 로컬 server.js가 함께 사용한다.

const MEMBER_COLORS = ['#4f46e5', '#ef7d57', '#0e9f8f', '#d9468b', '#d99a1e', '#3b82f6', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#7c5a3a', '#64748b'];
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MEMBERS = 12;
const MAX_EVENTS = 1500;
const MAX_TRAIL_POINTS = 400;
const MAX_POINTS_PER_REQUEST = 30;
const ARRIVAL_RADIUS_METERS = 120;
const ENDED_TRIP_VISIBLE_MS = 12 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 2 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = { create: 3, join: 8, member: 240 };
const TRAVEL_MODES = new Set(['transit', 'walk', 'car']);

class FamilyError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function randomId(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function createInviteCode() {
  const bytes = crypto.randomBytes(6);
  return [...bytes].map((byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('');
}

function cleanText(value, maxLength, fieldName, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new FamilyError(400, `${fieldName} 형식이 올바르지 않습니다.`, 'INVALID_INPUT');
  const text = value.trim().slice(0, maxLength);
  if (required && !text) throw new FamilyError(400, `${fieldName}을(를) 입력해 주세요.`, 'INVALID_INPUT');
  return text;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function cleanCoordinate(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

function cleanPlace(value) {
  const coordinate = cleanCoordinate(value);
  if (!coordinate) return null;
  return { ...coordinate, name: cleanText(typeof value.name === 'string' ? value.name : '', 120, '장소 이름') };
}

function distanceMeters(first, second) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRadians(second.lat - first.lat);
  const dLng = toRadians(second.lng - first.lng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(first.lat)) * Math.cos(toRadians(second.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

// 이동 기록이 길어지면 오래된 구간부터 점을 솎아 저장 용량을 지킨다.
function thinTrail(points) {
  let trail = points;
  while (trail.length > MAX_TRAIL_POINTS) {
    const keepRecent = Math.floor(MAX_TRAIL_POINTS / 2);
    const older = trail.slice(0, trail.length - keepRecent);
    const recent = trail.slice(trail.length - keepRecent);
    trail = [...older.filter((_, index) => index % 2 === 0 || index === older.length - 1), ...recent];
  }
  return trail;
}

function parseCredential(credential) {
  if (typeof credential !== 'string') return null;
  const parts = credential.trim().split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]{8,64}$/.test(part))) return null;
  const [familyId, memberId, secret] = parts;
  return { familyId, memberId, secret };
}

function publicMember(member) {
  return {
    id: member.id,
    name: member.name,
    color: member.color,
    joinedAt: member.joinedAt,
    lastSeenAt: member.lastSeenAt || member.joinedAt
  };
}

function createFamilyService({ store, now = () => Date.now() }) {
  if (!store) throw new Error('A store is required.');

  const familyKey = (familyId) => `family:${familyId}`;
  const requestBuckets = new Map();

  function enforceRateLimit(clientKey, action) {
    const identity = typeof clientKey === 'string' && clientKey ? clientKey.slice(0, 128) : 'unknown';
    const bucketKey = `${identity}:${action}`;
    const currentTime = now();
    const limit = RATE_LIMITS[action] || RATE_LIMITS.member;
    let bucket = requestBuckets.get(bucketKey);
    if (!bucket || currentTime - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
      bucket = { startedAt: currentTime, count: 0 };
      requestBuckets.set(bucketKey, bucket);
    }
    if (bucket.count >= limit) {
      throw new FamilyError(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.', 'RATE_LIMITED');
    }
    bucket.count += 1;
    if (requestBuckets.size > 5000) {
      for (const [key, entry] of requestBuckets) {
        if (currentTime - entry.startedAt >= RATE_LIMIT_WINDOW_MS) requestBuckets.delete(key);
      }
      while (requestBuckets.size > 5000) requestBuckets.delete(requestBuckets.keys().next().value);
    }
  }

  async function loadFamily(familyId) {
    const family = await store.get(familyKey(familyId), 'info');
    if (!family) throw new FamilyError(404, '가족 정보를 찾을 수 없습니다.', 'FAMILY_NOT_FOUND');
    return family;
  }

  async function listMembers(familyId) {
    return (await store.list(familyKey(familyId), 'member_')).map(({ value }) => value);
  }

  async function touchEventsRevision(family) {
    family.eventsRev = `${now().toString(36)}-${randomId(3)}`;
    await store.put(familyKey(family.id), 'info', family);
  }

  async function authenticate(credential) {
    const parsed = parseCredential(credential);
    if (!parsed) throw new FamilyError(401, '가족 연결 정보가 없습니다. 다시 참여해 주세요.', 'NOT_MEMBER');
    const member = await store.get(familyKey(parsed.familyId), `member_${parsed.memberId}`);
    const expected = Buffer.from(member?.secretHash || '', 'hex');
    const actual = Buffer.from(hashSecret(parsed.secret), 'hex');
    if (!member || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new FamilyError(401, '가족 연결 정보가 올바르지 않습니다. 다시 참여해 주세요.', 'NOT_MEMBER');
    }
    const family = await loadFamily(parsed.familyId);
    return { family, member };
  }

  async function addMember(family, name) {
    const members = await listMembers(family.id);
    if (members.length >= MAX_MEMBERS) {
      throw new FamilyError(409, `가족은 최대 ${MAX_MEMBERS}명까지 참여할 수 있습니다.`, 'FAMILY_FULL');
    }
    const usedColors = new Set(members.map((member) => member.color));
    const color = MEMBER_COLORS.find((candidate) => !usedColors.has(candidate)) || MEMBER_COLORS[members.length % MEMBER_COLORS.length];
    const secret = randomId(24);
    const member = {
      id: randomId(),
      name,
      color,
      secretHash: hashSecret(secret),
      joinedAt: new Date(now()).toISOString(),
      lastSeenAt: new Date(now()).toISOString()
    };
    await store.put(familyKey(family.id), `member_${member.id}`, member);
    return { member, credential: `${family.id}.${member.id}.${secret}` };
  }

  async function createFamily(body) {
    const familyName = cleanText(body.familyName, 30, '가족 이름') || '우리 가족';
    const memberName = cleanText(body.memberName, 20, '내 이름', { required: true });
    let inviteCode = createInviteCode();
    for (let attempt = 0; attempt < 5 && await store.get('invite', inviteCode); attempt += 1) {
      inviteCode = createInviteCode();
    }
    const family = {
      id: randomId(),
      name: familyName,
      inviteCode,
      createdAt: new Date(now()).toISOString(),
      eventsRev: `${now().toString(36)}-${randomId(3)}`
    };
    await store.put(familyKey(family.id), 'info', family);
    await store.put('invite', inviteCode, { familyId: family.id });
    const { member, credential } = await addMember(family, memberName);
    return { credential, memberId: member.id };
  }

  async function joinFamily(body) {
    const inviteCode = cleanText(body.inviteCode, 12, '초대 코드', { required: true }).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const memberName = cleanText(body.memberName, 20, '내 이름', { required: true });
    const invite = inviteCode ? await store.get('invite', inviteCode) : null;
    if (!invite) throw new FamilyError(404, '초대 코드를 찾을 수 없습니다. 코드를 다시 확인해 주세요.', 'INVITE_NOT_FOUND');
    const family = await loadFamily(invite.familyId);
    const { member, credential } = await addMember(family, memberName);
    return { credential, memberId: member.id };
  }

  async function getState(context, query) {
    const { family, member } = context;
    const lastSeen = Date.parse(member.lastSeenAt || 0);
    if (!Number.isFinite(lastSeen) || now() - lastSeen > LAST_SEEN_WRITE_INTERVAL_MS) {
      member.lastSeenAt = new Date(now()).toISOString();
      await store.put(familyKey(family.id), `member_${member.id}`, member);
    }
    // 리비전을 먼저 읽고 일정 목록을 나중에 읽어야, 그 사이에 바뀐 일정이 다음 조회에서 빠지지 않는다.
    const eventsRev = family.eventsRev;
    const unchanged = typeof query.rev === 'string' && query.rev === eventsRev;
    const [members, events, storedTrips] = await Promise.all([
      listMembers(family.id),
      unchanged ? null : store.list(familyKey(family.id), 'event_'),
      store.list(familyKey(family.id), 'trip_')
    ]);
    const currentTime = now();
    const visibleTrips = [];
    for (const { row, value: trip } of storedTrips) {
      if (trip.status === 'stopped') {
        await store.remove(familyKey(family.id), row);
        continue;
      }
      if (trip.status === 'moving') {
        visibleTrips.push(trip);
        continue;
      }
      if (currentTime - Date.parse(trip.endedAt || trip.updatedAt) >= ENDED_TRIP_VISIBLE_MS) {
        await store.remove(familyKey(family.id), row);
        continue;
      }
      if (trip.points?.length) {
        trip.points = [];
        if (trip.destination) trip.destination = { name: trip.destination.name || '' };
        await store.put(familyKey(family.id), row, trip);
      }
      visibleTrips.push(trip);
    }
    return {
      family: { id: family.id, name: family.name, inviteCode: family.inviteCode, createdAt: family.createdAt },
      me: member.id,
      members: members.map(publicMember),
      eventsRev,
      events: events ? events.map(({ value }) => value) : null,
      trips: visibleTrips,
      serverTime: new Date(currentTime).toISOString()
    };
  }

  async function saveEvent(context, body) {
    const { family, member } = context;
    const input = body.event;
    if (!input || typeof input !== 'object') throw new FamilyError(400, '일정 정보가 없습니다.', 'INVALID_INPUT');
    const title = cleanText(input.title, 80, '일정 제목', { required: true });
    if (!isValidDate(input.date)) throw new FamilyError(400, '날짜 형식이 올바르지 않습니다.', 'INVALID_INPUT');
    const allDay = input.allDay === true;
    const startTime = allDay ? '00:00' : input.startTime;
    const endTime = allDay ? '23:59' : input.endTime;
    if (!allDay && (!isValidTime(startTime) || !isValidTime(endTime) || endTime <= startTime)) {
      throw new FamilyError(400, '시작·종료 시간을 확인해 주세요.', 'INVALID_INPUT');
    }
    const members = await listMembers(family.id);
    const memberIds = new Set(members.map((item) => item.id));
    const participants = Array.isArray(input.participants)
      ? [...new Set(input.participants.filter((id) => typeof id === 'string' && memberIds.has(id)))]
      : [];
    const id = typeof input.id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(input.id) ? input.id : randomId();
    const existing = await store.get(familyKey(family.id), `event_${id}`);
    if (!existing) {
      const count = (await store.list(familyKey(family.id), 'event_')).length;
      if (count >= MAX_EVENTS) throw new FamilyError(409, '가족 일정이 너무 많습니다. 지난 일정을 정리해 주세요.', 'TOO_MANY_EVENTS');
    }
    const event = {
      id,
      title,
      date: input.date,
      startTime,
      endTime,
      allDay,
      location: cleanText(input.location, 120, '장소'),
      notes: cleanText(input.notes, 300, '메모'),
      participants,
      place: cleanPlace(input.place),
      createdBy: existing?.createdBy || member.id,
      createdAt: existing?.createdAt || new Date(now()).toISOString(),
      updatedBy: member.id,
      updatedAt: new Date(now()).toISOString()
    };
    await store.put(familyKey(family.id), `event_${id}`, event);
    await touchEventsRevision(family);
    return { event };
  }

  async function deleteEvent(context, body) {
    const { family } = context;
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(body.id)) {
      throw new FamilyError(400, '삭제할 일정을 찾을 수 없습니다.', 'INVALID_INPUT');
    }
    await store.remove(familyKey(family.id), `event_${body.id}`);
    await touchEventsRevision(family);
    return { deleted: body.id };
  }

  function cleanPoints(rawPoints, startedAt) {
    if (!Array.isArray(rawPoints)) return [];
    const earliest = Date.parse(startedAt) - 60 * 1000;
    const latest = now() + 60 * 1000;
    return rawPoints.slice(0, MAX_POINTS_PER_REQUEST).map((point) => {
      const coordinate = cleanCoordinate(point);
      const at = Date.parse(point?.at);
      if (!coordinate || !Number.isFinite(at) || at < earliest || at > latest) return null;
      const accuracy = Number(point.accuracy);
      return {
        ...coordinate,
        at: new Date(at).toISOString(),
        accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(Math.round(accuracy), 5000) : null
      };
    }).filter(Boolean);
  }

  function applyArrival(trip) {
    const last = trip.points.at(-1);
    if (trip.status !== 'moving' || !trip.destination || !last) return;
    const tolerance = Math.max(ARRIVAL_RADIUS_METERS, Math.min(last.accuracy || 0, 300));
    if (distanceMeters(last, trip.destination) <= tolerance) {
      trip.status = 'arrived';
      trip.endedAt = last.at;
      trip.points = [];
      trip.destination = { name: trip.destination.name || '' };
    }
  }

  async function startTrip(context, body) {
    const { family, member } = context;
    const linkedEvent = typeof body.eventId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(body.eventId)
      ? await store.get(familyKey(family.id), `event_${body.eventId}`)
      : null;
    const destination = cleanPlace(body.destination) || linkedEvent?.place || null;
    const startedAt = new Date(now()).toISOString();
    const trip = {
      id: randomId(),
      memberId: member.id,
      eventId: linkedEvent ? linkedEvent.id : null,
      title: cleanText(body.title, 80, '이동 제목') || linkedEvent?.title || '이동 중',
      destination,
      mode: TRAVEL_MODES.has(body.mode) ? body.mode : 'transit',
      status: 'moving',
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      points: []
    };
    trip.points = cleanPoints(body.points, startedAt);
    applyArrival(trip);
    await store.put(familyKey(family.id), `trip_${member.id}`, trip);
    return { trip };
  }

  async function addTripPoints(context, body) {
    const { family, member } = context;
    const trip = await store.get(familyKey(family.id), `trip_${member.id}`);
    if (!trip || trip.id !== body.tripId) throw new FamilyError(404, '진행 중인 이동이 없습니다.', 'TRIP_NOT_FOUND');
    if (trip.status !== 'moving') return { trip };
    const points = cleanPoints(body.points, trip.startedAt);
    const lastTime = trip.points.at(-1)?.at || '';
    const merged = [...trip.points, ...points.filter((point) => point.at > lastTime)]
      .sort((first, second) => first.at.localeCompare(second.at));
    trip.points = thinTrail(merged);
    trip.updatedAt = new Date(now()).toISOString();
    applyArrival(trip);
    await store.put(familyKey(family.id), `trip_${member.id}`, trip);
    return { trip };
  }

  async function endTrip(context, body) {
    const { family, member } = context;
    const trip = await store.get(familyKey(family.id), `trip_${member.id}`);
    if (!trip || trip.id !== body.tripId) throw new FamilyError(404, '진행 중인 이동이 없습니다.', 'TRIP_NOT_FOUND');
    if (trip.status === 'moving') {
      trip.status = body.reason === 'arrived' ? 'arrived' : 'stopped';
      trip.endedAt = new Date(now()).toISOString();
    }
    // 공유를 중간에 멈추면 지나온 경로는 지운다.
    if (trip.status === 'stopped') {
      trip.points = [];
      trip.destination = null;
      await store.remove(familyKey(family.id), `trip_${member.id}`);
      return { trip };
    } else if (trip.status === 'arrived') {
      trip.points = [];
      if (trip.destination) trip.destination = { name: trip.destination.name || '' };
    }
    trip.updatedAt = new Date(now()).toISOString();
    await store.put(familyKey(family.id), `trip_${member.id}`, trip);
    return { trip };
  }

  async function leaveFamily(context) {
    const { family, member } = context;
    await store.remove(familyKey(family.id), `trip_${member.id}`);
    await store.remove(familyKey(family.id), `member_${member.id}`);
    const remaining = await listMembers(family.id);
    if (!remaining.length) {
      const records = await store.list(familyKey(family.id));
      for (let offset = 0; offset < records.length; offset += 20) {
        await Promise.all(records.slice(offset, offset + 20).map(({ row }) => store.remove(familyKey(family.id), row)));
      }
      await store.remove('invite', family.inviteCode);
    }
    return { left: true };
  }

  const publicActions = {
    'POST create': createFamily,
    'POST join': joinFamily
  };
  const memberActions = {
    'GET state': getState,
    'POST event': saveEvent,
    'POST event-delete': deleteEvent,
    'POST trip-start': startTrip,
    'POST trip-point': addTripPoints,
    'POST trip-end': endTrip,
    'POST leave': leaveFamily
  };

  async function handle({ method, action, body = {}, query = {}, credential, clientKey }) {
    const key = `${String(method).toUpperCase()} ${action}`;
    if (publicActions[key]) {
      enforceRateLimit(clientKey, action);
      return publicActions[key](body || {});
    }
    if (memberActions[key]) {
      enforceRateLimit(clientKey, 'member');
      const context = await authenticate(credential);
      return key === 'GET state' ? getState(context, query || {}) : memberActions[key](context, body || {});
    }
    throw new FamilyError(404, '가족 API 경로를 찾을 수 없습니다.', 'NOT_FOUND');
  }

  return { handle, storageKind: store.kind };
}

module.exports = { createFamilyService, FamilyError, distanceMeters, MAX_TRAIL_POINTS };
