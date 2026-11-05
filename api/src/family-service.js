const crypto = require('node:crypto');
const { createFamilyChat } = require('./family-chat');

// 가족 캘린더와 이동 공유 API의 핵심 로직.
// Azure Functions(api/src/functions/family.js)와 로컬 server.js가 함께 사용한다.

const MEMBER_COLORS = ['#4f46e5', '#ef7d57', '#0e9f8f', '#d9468b', '#d99a1e', '#3b82f6', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#7c5a3a', '#64748b'];
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MEMBERS = 12;
const MAX_EVENTS = 1500;
const MAX_TRAIL_POINTS = 400;
const MAX_POINTS_PER_REQUEST = 30;
const MAX_TRACKING_ACCURACY_METERS = 100;
const MAX_STORED_ACCURACY_METERS = 2000;
const ARRIVAL_RADIUS_METERS = 60;
const ENDED_TRIP_VISIBLE_MS = 12 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 2 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = { create: 3, join: 8, member: 240, message: 20 };
const TRAVEL_MODES = new Set(['transit', 'walk', 'car']);
const DEPART_NOTICE_OPTIONS = new Set([0, 10, 20, 30, 45, 60, 90]);

function koreaDate(timestamp) {
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(date, count) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

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
  const lat = value.lat;
  const lng = value.lng;
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

  const chat = createFamilyChat({ store, now, FamilyError });
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
    const revision = `${now().toString(36)}-${randomId(3)}`;
    await store.update(familyKey(family.id), 'info', (current) => current ? { ...current, eventsRev: revision } : null);
    family.eventsRev = revision;
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
    const revBeforeList = family.eventsRev;
    const extended = await extendSeries(context);
    const [members, allEvents, storedTrips] = await Promise.all([
      listMembers(family.id),
      store.list(familyKey(family.id), 'event_'),
      store.list(familyKey(family.id), 'trip_')
    ]);
    const changed = await checkNoShows(context, allEvents, storedTrips, members);
    const eventsRev = changed || extended.changed ? family.eventsRev : revBeforeList;
    const events = query.rev === eventsRev ? null : allEvents;
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
      rooms: await chat.rooms(context),
      scheduleWarning: extended.limitReached ? '일정 한도로 반복 일정을 더 만들지 못했어요. 지난 일정을 정리해 주세요.' : null,
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
      arrivals: existing && existing.date === input.date ? existing.arrivals || {} : {},
      homeArrivals: existing && existing.date === input.date ? existing.homeArrivals || {} : {},
      departures: existing && existing.date === input.date && existing.startTime === startTime ? existing.departures || {} : {},
      departNotice: !allDay && DEPART_NOTICE_OPTIONS.has(Number(input.departNotice)) ? Number(input.departNotice) : 0,
      returnHome: !allDay && input.returnHome === true,
      noShow: existing && existing.date === input.date && existing.startTime === startTime
        && existing.departNotice === Number(input.departNotice) ? existing.noShow || {} : {},
      createdBy: existing?.createdBy || member.id,
      createdAt: existing?.createdAt || new Date(now()).toISOString(),
      updatedBy: member.id,
      updatedAt: new Date(now()).toISOString()
    };
    if (existing?.seriesId && body.scope === 'one') {
      Object.assign(event, { seriesId: existing.seriesId, repeatDays: existing.repeatDays, repeatUntil: existing.repeatUntil, detached: true });
    } else if (!allDay && input.repeat?.days?.length) {
      return saveSeries(context, event, input.repeat, existing);
    } else if (existing?.seriesId) {
      await removeOccurrences(context, existing.seriesId, existing.date, false);
      await store.remove(familyKey(family.id), `series_${existing.seriesId}`);
    }
    await store.put(familyKey(family.id), `event_${id}`, event);
    await touchEventsRevision(family);
    return { event };
  }

  async function deleteEvent(context, body) {
    const { family } = context;
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(body.id)) {
      throw new FamilyError(400, '삭제할 일정을 찾을 수 없습니다.', 'INVALID_INPUT');
    }
    const event = await store.get(familyKey(family.id), `event_${body.id}`);
    if (event?.seriesId) {
      const ruleKey = `series_${event.seriesId}`;
      const series = await store.get(familyKey(family.id), ruleKey);
      if (body.scope === 'series') {
        await removeOccurrences(context, event.seriesId, event.date, true);
        if (series && event.date > series.startDate) {
          series.until = addDays(event.date, -1);
          await store.put(familyKey(family.id), ruleKey, series);
        } else await store.remove(familyKey(family.id), ruleKey);
      } else if (series) {
        await store.update(familyKey(family.id), ruleKey, (current) => current ? {
          ...current, skip: [...new Set([...(current.skip || []), body.id.slice(-8)])]
        } : null);
      }
    }
    await removeEventRecord(context, body.id);
    await touchEventsRevision(family);
    return { deleted: body.id };
  }

  async function removeEventRecord(context, id) {
    const partition = familyKey(context.family.id);
    await store.remove(partition, `event_${id}`);
    await chat.remove(context, `event:${id}`);
    for (const { row, value } of await store.list(partition, 'trip_')) {
      if (value.eventId === id || value.returnFor === id) await store.remove(partition, row);
    }
  }

  async function removeOccurrences(context, seriesId, from, includeDetached) {
    for (const { value } of await store.list(familyKey(context.family.id), `event_${seriesId}-`)) {
      if (value.date >= from && (includeDetached || !value.detached)) await removeEventRecord(context, value.id);
    }
  }

  async function generateOccurrences(context, series, from, { replace = false, originalId } = {}) {
    const partition = familyKey(context.family.id);
    const allRows = await store.list(partition, 'event_');
    const existing = new Map(allRows.map(({ value }) => [value.id, value]));
    const horizon = addDays(koreaDate(now()), 56);
    const last = series.until && series.until < horizon ? series.until : horizon;
    const first = [from, series.startDate, koreaDate(now())].sort().at(-1);
    const planned = [];
    for (let date = first; date <= last; date = addDays(date, 1)) {
      const compact = date.replace(/-/g, '');
      const id = `${series.id}-${compact}`;
      const previous = existing.get(id);
      if (!series.days.includes(new Date(`${date}T12:00:00Z`).getUTCDay())
        || series.skip.includes(compact) || previous?.detached) continue;
      const sameSlot = previous?.date === date && previous?.startTime === series.template.startTime;
      planned.push({ ...series.template, id, date, seriesId: series.id, repeatDays: series.days, repeatUntil: series.until,
        arrivals: previous?.arrivals || {}, homeArrivals: previous?.homeArrivals || {},
        departures: sameSlot ? previous.departures || {} : {},
        noShow: sameSlot && previous.departNotice === series.template.departNotice ? previous.noShow || {} : {},
        createdAt: previous?.createdAt || series.createdAt, createdBy: previous?.createdBy || series.createdBy,
        updatedAt: new Date(now()).toISOString(), updatedBy: context.member.id });
    }
    const plannedIds = new Set(planned.map((event) => event.id));
    const removed = allRows.filter(({ value }) => value.id === originalId
      || (replace && value.seriesId === series.id && value.date >= from && !value.detached && !plannedIds.has(value.id)));
    const count = allRows.length - removed.length + planned.filter((event) => !existing.has(event.id)).length;
    if (count > MAX_EVENTS) throw new FamilyError(409, '가족 일정이 너무 많습니다. 지난 일정을 정리해 주세요.', 'TOO_MANY_EVENTS');
    await store.put(partition, `series_${series.id}`, { ...series, generatedUntil: last > (series.generatedUntil || '') ? last : series.generatedUntil });
    for (const { value } of removed) await removeEventRecord(context, value.id);
    for (const event of planned) await store.put(partition, `event_${event.id}`, event);
    return planned;
  }

  async function saveSeries(context, template, repeat, existing) {
    const days = [...new Set(repeat.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
    if (!days.length || (repeat.until && (!isValidDate(repeat.until) || repeat.until < template.date))) {
      throw new FamilyError(400, '반복 요일과 종료일을 확인해 주세요.', 'INVALID_INPUT');
    }
    const partition = familyKey(context.family.id);
    const previous = existing?.seriesId ? await store.get(partition, `series_${existing.seriesId}`) : null;
    if (!previous && (await store.list(partition, 'series_')).length >= 50) {
      throw new FamilyError(409, '반복 일정은 50개까지 만들 수 있어요.', 'TOO_MANY_EVENTS');
    }
    const series = { id: previous?.id || randomId(), template, days, until: repeat.until || null,
      startDate: previous?.startDate || template.date, skip: previous?.skip || [],
      createdBy: previous?.createdBy || context.member.id, createdAt: previous?.createdAt || new Date(now()).toISOString(),
      generatedUntil: addDays(template.date, -1) };
    const events = await generateOccurrences(context, series, template.date, {
      replace: Boolean(previous), originalId: existing && !existing.seriesId ? existing.id : null
    });
    await touchEventsRevision(context.family);
    return { event: events[0] || null, series: { id: series.id, days, until: series.until } };
  }

  async function extendSeries(context) {
    let changed = false;
    let limitReached = false;
    const horizon = addDays(koreaDate(now()), 56);
    for (const { value: series } of await store.list(familyKey(context.family.id), 'series_')) {
      if (series.generatedUntil >= horizon || (series.until && series.generatedUntil >= series.until)) continue;
      try {
        const events = await generateOccurrences(context, series, addDays(series.generatedUntil || addDays(koreaDate(now()), -1), 1));
        changed ||= events.length > 0;
      } catch (error) {
        if (error.code !== 'TOO_MANY_EVENTS') throw error;
        limitReached = true;
      }
    }
    if (changed) await touchEventsRevision(context.family);
    return { changed, limitReached };
  }

  function cleanPoints(rawPoints, startedAt) {
    if (!Array.isArray(rawPoints)) return [];
    const earliest = Date.parse(startedAt) - 60 * 1000;
    const latest = now() + 60 * 1000;
    const points = rawPoints.slice(0, MAX_POINTS_PER_REQUEST).map((point) => {
      const coordinate = cleanCoordinate(point);
      const at = Date.parse(point?.at);
      if (!coordinate || !Number.isFinite(at) || at < earliest || at > latest) return null;
      const accuracy = point.accuracy;
      if (accuracy !== null && accuracy !== undefined
        && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_STORED_ACCURACY_METERS)) return null;
      return {
        ...coordinate,
        at: new Date(at).toISOString(),
        accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null
      };
    }).filter(Boolean);
    return [...new Map(points.map((point) => [point.at, point])).values()]
      .sort((first, second) => first.at.localeCompare(second.at));
  }

  function applyArrival(trip) {
    const last = trip.points.at(-1);
    if (trip.status !== 'moving' || !trip.destination || !last) return;
    if (Number.isFinite(last.accuracy) && last.accuracy > MAX_TRACKING_ACCURACY_METERS) return;
    const accuracy = Number.isFinite(last.accuracy) ? Math.min(last.accuracy, MAX_TRACKING_ACCURACY_METERS) : ARRIVAL_RADIUS_METERS;
    const tolerance = Math.max(ARRIVAL_RADIUS_METERS, accuracy);
    if (distanceMeters(last, trip.destination) <= tolerance) {
      trip.status = 'arrived';
      trip.endedAt = last.at;
      trip.points = [];
      trip.destination = { name: trip.destination.name || '' };
    }
  }

  async function recordArrival(context, trip, wasMoving) {
    const { family } = context;
    if (!wasMoving || trip.status !== 'arrived' || !(trip.eventId || trip.returnFor)) return;
    const key = `event_${trip.returnFor || trip.eventId}`;
    const field = trip.returnFor ? 'homeArrivals' : 'arrivals';
    const event = await store.update(familyKey(family.id), key, (current) => current ? {
      ...current, [field]: { ...current[field], [trip.memberId]: trip.endedAt || new Date(now()).toISOString() }
    } : null);
    if (!event) return;
    await touchEventsRevision(family);
    await chat.arrival(context, event, trip);
  }

  async function checkNoShows(context, rows, trips, members) {
    const { family } = context;
    let changed = false;
    for (const { value: event } of rows) {
      if (!event.departNotice || event.allDay || !event.participants?.length) continue;
      const start = Date.parse(`${event.date}T${event.startTime}:00+09:00`);
      const due = start - event.departNotice * 60000;
      if (now() < due + 5 * 60000 || now() > start + 30 * 60000 || Date.parse(event.createdAt) > due) continue;
      const missing = event.participants.filter((id) => members.some((member) => member.id === id)
        && !event.noShow?.[id] && !event.departures?.[id] && !event.arrivals?.[id]
        && !trips.some(({ value }) => value.memberId === id && value.eventId === event.id && value.status !== 'stopped'));
      if (!missing.length) continue;
      const fresh = await store.get(familyKey(family.id), `event_${event.id}`);
      if (!fresh) continue;
      for (const memberId of missing) {
        if (fresh.noShow?.[memberId] || fresh.departures?.[memberId] || fresh.arrivals?.[memberId]) continue;
        fresh.noShow = { ...fresh.noShow, [memberId]: new Date(now()).toISOString() };
        const name = members.find((member) => member.id === memberId).name;
        await chat.append(context, 'family', `${name}님이 아직 '${event.title}'(${event.startTime} 시작)으로 출발하지 않았어요`,
          { system: true, token: `noshow-${event.id}-${memberId}-${start}`, at: due + 5 * 60000 });
      }
      const updated = await store.update(familyKey(family.id), `event_${event.id}`, (current) => current ? {
        ...current, noShow: { ...fresh.noShow, ...current.noShow }
      } : null);
      if (updated) Object.assign(event, updated);
      changed = true;
    }
    if (changed) await touchEventsRevision(family);
    return changed;
  }

  async function startTrip(context, body) {
    const { family, member } = context;
    const linkedEvent = typeof body.eventId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(body.eventId)
      ? await store.get(familyKey(family.id), `event_${body.eventId}`)
      : null;
    const homeEvent = !linkedEvent && typeof body.returnFor === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(body.returnFor)
      ? await store.get(familyKey(family.id), `event_${body.returnFor}`) : null;
    if (body.returnFor && (!homeEvent?.returnHome || !homeEvent.arrivals?.[member.id] || homeEvent.homeArrivals?.[member.id])) {
      throw new FamilyError(400, '귀가할 일정을 확인해 주세요.', 'INVALID_RETURN');
    }
    const destination = cleanPlace(body.destination) || linkedEvent?.place || null;
    const startedAt = new Date(now()).toISOString();
    const trip = {
      id: randomId(),
      memberId: member.id,
      eventId: linkedEvent ? linkedEvent.id : null,
      returnFor: homeEvent?.id || null,
      title: cleanText(body.title, 80, '이동 제목') || linkedEvent?.title || (homeEvent ? `${homeEvent.title} → 집` : '이동 중'),
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
    if (linkedEvent) {
      await store.update(familyKey(family.id), `event_${linkedEvent.id}`, (current) => current ? {
        ...current, departures: { ...current.departures, [member.id]: startedAt }
      } : null);
      await touchEventsRevision(family);
      await chat.open(context, linkedEvent, { tripId: trip.id });
      if (linkedEvent.noShow?.[member.id]) await chat.append(context, 'family', `${member.name}님이 이제 '${linkedEvent.title}'(으)로 출발했어요`,
        { system: true, token: `late-${trip.id}` });
    }
    if (homeEvent) await chat.open(context, homeEvent, { home: true, tripId: trip.id });
    await recordArrival(context, trip, true);
    return { trip };
  }

  async function addTripPoints(context, body) {
    const { family, member } = context;
    const trip = await store.get(familyKey(family.id), `trip_${member.id}`);
    if (!trip || trip.id !== body.tripId) throw new FamilyError(404, '진행 중인 이동이 없습니다.', 'TRIP_NOT_FOUND');
    if (trip.status !== 'moving') return { trip };
    const wasMoving = trip.status === 'moving';
    const points = cleanPoints(body.points, trip.startedAt);
    const lastTime = trip.points.at(-1)?.at || '';
    const merged = [...trip.points, ...points.filter((point) => point.at > lastTime)]
      .sort((first, second) => first.at.localeCompare(second.at));
    trip.points = thinTrail(merged);
    trip.updatedAt = new Date(now()).toISOString();
    applyArrival(trip);
    await store.put(familyKey(family.id), `trip_${member.id}`, trip);
    await recordArrival(context, trip, wasMoving);
    return { trip };
  }

  async function endTrip(context, body) {
    const { family, member } = context;
    const trip = await store.get(familyKey(family.id), `trip_${member.id}`);
    if (!trip || trip.id !== body.tripId) throw new FamilyError(404, '진행 중인 이동이 없습니다.', 'TRIP_NOT_FOUND');
    const wasMoving = trip.status === 'moving';
    if (wasMoving) {
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
    await recordArrival(context, trip, wasMoving);
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
    'GET messages': chat.list,
    'POST message': chat.send,
    'GET chat': chat.readRoom,
    'POST chat-send': chat.sendRoom,
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
      if (key === 'POST message' || key === 'POST chat-send') enforceRateLimit(context.member.id, 'message');
      return String(method).toUpperCase() === 'GET' ? memberActions[key](context, query || {}) : memberActions[key](context, body || {});
    }
    throw new FamilyError(404, '가족 API 경로를 찾을 수 없습니다.', 'NOT_FOUND');
  }

  return { handle, storageKind: store.kind };
}

module.exports = { createFamilyService, FamilyError, distanceMeters, MAX_TRAIL_POINTS };
