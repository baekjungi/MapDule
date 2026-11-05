const crypto = require('node:crypto');

const MAX_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 1000;
const ROOM_GRACE_MS = 30 * 60 * 1000;

function createFamilyChat({ store, now, FamilyError }) {
  const partitionFor = (context) => `family:${context.family.id}`;

  function roomInfo(key = 'family') {
    if (key === 'family') return { key, prefix: 'message_', row: 'room_f' };
    const match = typeof key === 'string' && key.match(/^event:([A-Za-z0-9_-]{6,64})$/);
    if (!match) throw new FamilyError(400, '대화방을 찾을 수 없습니다.', 'INVALID_INPUT');
    return { key, eventId: match[1], prefix: `msg_e~${match[1]}~`, row: `room_e~${match[1]}` };
  }

  const linked = (trip, eventId) => trip.eventId === eventId || trip.returnFor === eventId;
  const endTime = (event) => Date.parse(`${event.date}T${event.endTime}:00+09:00`);

  async function remove(context, key) {
    const room = roomInfo(key);
    if (!room.eventId) return;
    const partition = partitionFor(context);
    const rows = await store.list(partition, room.prefix);
    for (let offset = 0; offset < rows.length; offset += 20) {
      await Promise.all(rows.slice(offset, offset + 20).map(({ row }) => store.remove(partition, row)));
    }
    await store.remove(partition, room.row);
  }

  async function resolve(context, key) {
    const room = roomInfo(key);
    if (!room.eventId) return room;
    const partition = partitionFor(context);
    const meta = await store.get(partition, room.row);
    const event = await store.get(partition, `event_${room.eventId}`);
    const trips = (await store.list(partition, 'trip_')).map(({ value }) => value);
    if (!meta || !event || (!trips.some((trip) => linked(trip, room.eventId) && trip.status === 'moving')
      && now() >= Date.parse(meta.closesAt))) {
      await remove(context, key);
      throw new FamilyError(410, '이 대화방은 이미 사라졌어요.', 'ROOM_CLOSED');
    }
    const memberId = context.member.id;
    if (event.participants?.length && !event.participants.includes(memberId)
      && !meta.travelers.includes(memberId) && event.createdBy !== memberId) {
      throw new FamilyError(403, '이 대화방에 참여하지 않았어요.', 'NOT_IN_ROOM');
    }
    return { ...room, meta, event };
  }

  async function append(context, key, text, { system = false, token, at } = {}) {
    const room = roomInfo(key);
    const timestamp = at ?? now();
    const message = {
      id: `${String(timestamp).padStart(13, '0')}_${token || crypto.randomUUID()}`,
      senderId: system ? null : context.member.id,
      senderName: system ? '안내' : context.member.name,
      text, system, createdAt: new Date(timestamp).toISOString()
    };
    const partition = partitionFor(context);
    const row = `${room.prefix}${message.id}`;
    if (token) {
      if (!(await store.insert(partition, row, message))) return;
    } else await store.put(partition, row, message);
    const records = await store.list(partition, room.prefix);
    const limit = room.eventId ? 300 : MAX_MESSAGES;
    await Promise.all(records.slice(0, Math.max(0, records.length - limit))
      .map((record) => store.remove(partition, record.row)));
    return message;
  }

  async function rooms(context) {
    const partition = partitionFor(context);
    const result = [];
    const keys = ['family', ...(await store.list(partition, 'room_e~')).map(({ value }) => `event:${value.eventId}`)];
    for (const key of keys) {
      let room;
      try { room = await resolve(context, key); } catch (error) {
        if ([403, 410].includes(error.statusCode)) continue;
        throw error;
      }
      const last = (await store.list(partition, room.prefix)).at(-1)?.value;
      const moving = room.eventId && (await store.list(partition, 'trip_'))
        .some(({ value }) => linked(value, room.eventId) && value.status === 'moving');
      result.push({
        key, kind: room.eventId ? 'event' : 'family', eventId: room.eventId || null,
        title: room.event?.title || '가족방', closesAt: moving ? null : room.meta?.closesAt || null,
        allArrivedAt: room.meta?.allArrivedAt || null,
        lastId: last?.id || null, lastAt: last?.createdAt || null,
        lastText: last?.text.slice(0, 80) || '', lastMemberId: last?.senderId || null,
        lastSystem: Boolean(last?.system)
      });
    }
    return result;
  }

  async function open(context, event, { home = false, tripId } = {}) {
    const room = roomInfo(`event:${event.id}`);
    const partition = partitionFor(context);
    const closesAt = Math.max(endTime(event) + (event.returnHome ? 2 * 60 * 60 * 1000 : ROOM_GRACE_MS), now() + ROOM_GRACE_MS);
    await store.update(partition, room.row, (previous) => ({
      eventId: event.id, travelers: [...new Set([...(previous?.travelers || []), context.member.id])],
      allArrivedAt: null, closesAt: new Date(closesAt).toISOString()
    }));
    await append(context, room.key, `${context.member.name}님이 ${home ? '집으로 ' : ''}출발했어요`,
      { system: true, token: `depart-${tripId}`, at: now() });
  }

  async function arrival(context, event, trip) {
    const room = roomInfo(`event:${event.id}`);
    const partition = partitionFor(context);
    const meta = await store.get(partition, room.row);
    if (!meta) return;
    await append(context, room.key, `${context.member.name}님이 ${trip.returnFor ? '집에 ' : ''}도착했어요`,
      { system: true, token: `arrive-${trip.id}`, at: Date.parse(trip.endedAt) });
    const members = new Set((await store.list(partition, 'member_')).map(({ value }) => value.id));
    const travelers = meta.travelers.filter((id) => members.has(id));
    const trips = (await store.list(partition, 'trip_')).map(({ value }) => value);
    if (trips.some((item) => linked(item, event.id) && item.status === 'moving')) return;
    const complete = travelers.length && travelers.every((id) =>
      event.returnHome ? event.homeArrivals?.[id] : event.arrivals?.[id]);
    if (complete) {
      meta.allArrivedAt = new Date(now()).toISOString();
      meta.closesAt = new Date(now() + ROOM_GRACE_MS).toISOString();
      await store.put(partition, room.row, meta);
      await append(context, room.key, `모두 ${event.returnHome ? '집에 ' : ''}도착했어요. 이 대화방은 30분 뒤 사라져요.`, { system: true, token: `complete-${trip.id}` });
    }
  }

  async function readRoom(context, query) {
    const room = await resolve(context, query.room || 'family');
    const records = await store.list(partitionFor(context), room.prefix);
    const after = typeof query.after === 'string' && /^\d{13}_/.test(query.after) ? query.after.slice(0, 13) : '';
    return { room: room.key, messages: records.filter(({ value }) => !after || value.id.slice(0, 13) >= after)
      .slice(-200).map(({ value }) => value) };
  }

  async function sendRoom(context, body) {
    const room = await resolve(context, body.room || 'family');
    validate(body.text, 500);
    return { room: room.key, message: await append(context, room.key, body.text.trim()) };
  }

  function validate(text, maxLength) {
    if (typeof text !== 'string' || !text.trim() || text.length > maxLength
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new FamilyError(400, `메시지는 공백이 아닌 1~${maxLength}자로 입력해 주세요.`, 'INVALID_MESSAGE');
    }
  }

  async function list(context) {
    const records = await store.list(partitionFor(context), 'message_');
    return { messages: records.slice(-MAX_MESSAGES).map(({ value }) => value) };
  }

  async function send(context, body) {
    validate(body.text, MAX_MESSAGE_LENGTH);
    return { message: await append(context, 'family', body.text.trim()) };
  }

  return { list, send, rooms, open, arrival, remove, readRoom, sendRoom, append };
}

module.exports = { createFamilyChat, MAX_MESSAGES, MAX_MESSAGE_LENGTH };
