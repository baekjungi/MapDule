const test = require('node:test');
const assert = require('node:assert/strict');
const { createFamilyService } = require('../api/src/family-service');
const { createMemoryStore, createTableStore } = require('../api/src/family-store');

async function setup() {
  let clock = Date.parse('2026-10-25T16:00:00+09:00');
  const store = createMemoryStore();
  const service = createFamilyService({ store, now: () => clock });
  const parent = await service.handle({ method: 'POST', action: 'create', body: { memberName: '엄마' } });
  const call = (member, method, action, data = {}) => service.handle({
    credential: member.credential, method, action, ...(method === 'GET' ? { query: data } : { body: data })
  });
  const state = await call(parent, 'GET', 'state');
  const join = (name) => service.handle({ method: 'POST', action: 'join', body: { memberName: name, inviteCode: state.family.inviteCode } });
  const child = await join('아이');
  const sibling = await join('동생');
  const eventInput = { title: '수학학원', date: '2026-10-25', startTime: '17:00', endTime: '18:30',
    participants: [child.memberId], place: { lat: 37.5, lng: 127, name: '학원' }, departNotice: 30 };
  const save = async (extra = {}) => (await call(parent, 'POST', 'event', { event: { ...eventInput, ...extra } })).event;
  const at = (value) => { clock = Date.parse(value.includes('T') ? value : `2026-10-25T${value}:00+09:00`); };
  const start = (member, event, home = false) => call(member, 'POST', 'trip-start', {
    ...(home ? { returnFor: event.id, destination: { lat: 37.6, lng: 127.1, name: '집' } } : { eventId: event.id }),
    points: [{ lat: 37.55, lng: 127.05, accuracy: 20, at: new Date(clock).toISOString() }]
  });
  const arrive = (member, trip) => call(member, 'POST', 'trip-end', { tripId: trip.id, reason: 'arrived' });
  return { store, service, call, parent, child, sibling, save, at, start, arrive, eventInput, partition: `family:${state.family.id}` };
}

test('room API preserves old family messages and rejects nonparticipants and forged system messages', async () => {
  const { call, parent, child, sibling, save, start } = await setup();
  await call(parent, 'POST', 'message', { text: '예전 대화' });
  assert.equal((await call(child, 'GET', 'chat', { room: 'family' })).messages[0].text, '예전 대화');
  const event = await save();
  await start(child, event);
  await assert.rejects(call(sibling, 'GET', 'chat', { room: `event:${event.id}` }), (error) => error.statusCode === 403);
  const sent = await call(child, 'POST', 'chat-send', { room: `event:${event.id}`, text: '버스 탔어요', system: true, senderId: parent.memberId });
  assert.equal(sent.message.system, false);
  assert.equal(sent.message.senderId, child.memberId);
  await assert.rejects(call(child, 'POST', 'chat-send', { room: 'family', text: 'a'.repeat(501) }), (error) => error.code === 'INVALID_MESSAGE');
});

test('moving rooms survive elapsed time and expiry removes messages from storage', async () => {
  const { store, partition, call, parent, child, save, start, arrive, at } = await setup();
  const event = await save();
  const { trip } = await start(child, event);
  at('20:00');
  assert.ok((await call(parent, 'GET', 'state')).rooms.some((room) => room.eventId === event.id));
  await arrive(child, trip);
  at('20:29');
  assert.ok((await call(parent, 'GET', 'state')).rooms.some((room) => room.eventId === event.id));
  at('20:30');
  assert.equal((await call(parent, 'GET', 'state')).rooms.some((room) => room.eventId === event.id), false);
  assert.deepEqual(await store.list(partition, `msg_e~${event.id}~`), []);
  await assert.rejects(call(child, 'GET', 'chat', { room: `event:${event.id}` }), (error) => error.statusCode === 410);
});

test('deleting an event immediately deletes its room, messages and active location share', async () => {
  const { store, partition, call, parent, child, save, start } = await setup();
  const event = await save();
  await start(child, event);
  await call(parent, 'POST', 'event-delete', { id: event.id });
  assert.deepEqual(await store.list(partition, `msg_e~${event.id}~`), []);
  assert.equal(await store.get(partition, `trip_${child.memberId}`), null);
});

test('concurrent state checks announce a missed departure once and late departure stays recorded', async () => {
  const { call, parent, child, save, at, start } = await setup();
  const event = await save();
  at('16:34');
  assert.deepEqual((await call(parent, 'GET', 'state')).events[0].noShow, {});
  at('16:35');
  const states = await Promise.all([call(parent, 'GET', 'state'), call(child, 'GET', 'state')]);
  assert.ok(states[0].events[0].noShow[child.memberId]);
  assert.equal((await call(parent, 'GET', 'chat', { room: 'family' })).messages.length, 1);
  at('16:40');
  await start(child, event);
  assert.match((await call(parent, 'GET', 'chat', { room: 'family' })).messages.at(-1).text, /이제/);
  assert.ok((await call(parent, 'GET', 'state')).events[0].departures[child.memberId]);
});

test('late-created, disabled and long-past events do not produce missed-departure alerts', async () => {
  const { call, parent, child, save, at } = await setup();
  await save({ departNotice: 0 });
  at('16:45');
  await save({ title: '늦게 등록' });
  assert.ok((await call(parent, 'GET', 'state')).events.every((event) => !event.noShow[child.memberId]));
  at('17:31');
  assert.equal((await call(parent, 'GET', 'chat', { room: 'family' })).messages.length, 0);
});

test('two travelers keep the return room until both are home, not just until one stops moving', async () => {
  const { call, parent, child, sibling, save, at, start, arrive } = await setup();
  const event = await save({ participants: [child.memberId, sibling.memberId], returnHome: true });
  const first = await start(child, event);
  const second = await start(sibling, event);
  at('16:45');
  await Promise.all([arrive(child, first.trip), arrive(sibling, second.trip)]);
  const arrivals = (await call(parent, 'GET', 'state')).events[0].arrivals;
  assert.equal(Object.keys(arrivals).length, 2);
  at('18:31');
  const home = await start(child, event, true);
  at('18:40');
  await arrive(child, home.trip);
  at('19:11');
  const pending = (await call(parent, 'GET', 'state')).rooms.find((room) => room.eventId === event.id);
  assert.ok(pending, 'the second child has not started the return journey yet');
  assert.equal(pending.allArrivedAt, null);
  const next = await start(sibling, event, true);
  at('19:20');
  await arrive(sibling, next.trip);
  const state = await call(parent, 'GET', 'state');
  assert.deepEqual(state.events[0].arrivals, arrivals);
  assert.equal(Object.keys(state.events[0].homeArrivals).length, 2);
  assert.ok(state.rooms.find((room) => room.eventId === event.id).allArrivedAt);
  at('19:50');
  assert.equal((await call(parent, 'GET', 'state')).rooms.length, 1);
});

test('weekly schedules support detached edits, skip dates and future deletion without losing past records', async () => {
  const { call, parent, child, save, at } = await setup();
  const first = await save({ date: '2026-10-26', repeat: { days: [1, 3, 5] } });
  let state = await call(parent, 'GET', 'state');
  assert.equal(state.events.length, 24);
  const wed = state.events.find((event) => event.date === '2026-10-28');
  await call(parent, 'POST', 'event', { scope: 'one', event: { ...wed, title: '이 날만', startTime: '18:00', endTime: '19:00' } });
  const fri = state.events.find((event) => event.date === '2026-10-30');
  await call(parent, 'POST', 'event', { scope: 'series', event: { ...fri, repeat: { days: [1, 5] } } });
  state = await call(child, 'GET', 'state');
  assert.equal(state.events.find((event) => event.id === wed.id).title, '이 날만');
  assert.ok(state.events.some((event) => event.id === first.id));
  assert.equal(state.events.some((event) => event.date === '2026-11-04'), false);
  await call(parent, 'POST', 'event-delete', { id: fri.id, scope: 'one' });
  at('2026-11-25T16:00:00+09:00');
  state = await call(child, 'GET', 'state');
  assert.equal(state.events.some((event) => event.id === fri.id), false);
  assert.ok(state.events.some((event) => event.date > '2026-12-20'));
  const future = state.events.find((event) => event.date >= '2026-12-01');
  await call(parent, 'POST', 'event-delete', { id: future.id, scope: 'series' });
  at('2027-01-01T16:00:00+09:00');
  state = await call(parent, 'GET', 'state');
  assert.ok(state.events.every((event) => event.date < future.date));
  assert.ok(state.events.some((event) => event.id === first.id));
});

test('repeat generation enforces capacity before removing or overwriting existing events', async () => {
  const { store, partition, call, parent, save, at } = await setup();
  const event = await save({ repeat: { days: [0] } });
  const initial = await store.list(partition, 'event_');
  for (let index = initial.length; index < 1499; index += 1) {
    await store.put(partition, `event_limit${index}`, { ...event, id: `limit${index}`, seriesId: null });
  }
  await assert.rejects(call(parent, 'POST', 'event', { event: { ...event, repeat: { days: [0, 1, 2, 3, 4, 5, 6] } }, scope: 'series' }),
    (error) => error.code === 'TOO_MANY_EVENTS');
  assert.deepEqual(await store.get(partition, `event_${event.id}`), event);
  at('2026-11-25T16:00:00+09:00');
  const state = await call(parent, 'GET', 'state');
  assert.ok(state.scheduleWarning);
  assert.equal(state.events.length, 1499);
});

test('a failed repeat write does not advance the generation cursor and the next state request repairs it', async () => {
  const { store, partition, call, parent, save } = await setup();
  const originalPut = store.put;
  let eventWrites = 0;
  store.put = async (target, row, value) => {
    if (row.startsWith('event_') && ++eventWrites === 2) throw new Error('temporary write failure');
    return originalPut.call(store, target, row, value);
  };
  await assert.rejects(save({ date: '2026-10-26', repeat: { days: [1, 3, 5] } }), /temporary write failure/);
  const rule = (await store.list(partition, 'series_'))[0].value;
  assert.equal(rule.generatedUntil, '2026-10-25');
  store.put = originalPut;
  const state = await call(parent, 'GET', 'state');
  assert.equal(state.events.length, 24);
  assert.equal((await store.list(partition, 'series_'))[0].value.generatedUntil, '2026-12-20');
});

test('simultaneous home arrivals keep both records and announce completion once', async () => {
  const { call, parent, child, sibling, save, at, start, arrive } = await setup();
  const event = await save({ participants: [child.memberId, sibling.memberId], returnHome: true });
  const outgoing = await Promise.all([start(child, event), start(sibling, event)]);
  at('16:50');
  await Promise.all([arrive(child, outgoing[0].trip), arrive(sibling, outgoing[1].trip)]);
  at('18:31');
  const home = await Promise.all([start(child, event, true), start(sibling, event, true)]);
  at('18:50');
  await Promise.all([arrive(child, home[0].trip), arrive(sibling, home[1].trip)]);
  const state = await call(parent, 'GET', 'state');
  assert.equal(Object.keys(state.events[0].homeArrivals).length, 2);
  assert.ok(state.rooms.find((room) => room.eventId === event.id).allArrivedAt);
  const chat = await call(parent, 'GET', 'chat', { room: `event:${event.id}` });
  assert.equal(chat.messages.filter((message) => message.text.startsWith('모두 집에')).length, 1);
});

test('Table conditional updates retry an ETag conflict and retain the other writer data', async () => {
  const requests = [];
  let reads = 0;
  const store = createTableStore('AccountName=test;AccountKey=dGVzdA==', 'family', async (url, options) => {
    requests.push({ url, ...options });
    if (url.endsWith('/Tables')) return new Response(null, { status: 201 });
    if (options.method === 'GET') {
      reads += 1;
      return Response.json({ data: JSON.stringify({ arrivals: reads === 1 ? {} : { sibling: 'earlier' } }) }, { headers: { etag: `version${reads}` } });
    }
    return new Response(null, { status: reads === 1 ? 412 : 204 });
  });
  const result = await store.update('family:one', 'event_one', (current) => ({ arrivals: { ...current.arrivals, child: 'now' } }));
  assert.deepEqual(result.arrivals, { sibling: 'earlier', child: 'now' });
  assert.deepEqual(requests.filter((request) => request.method === 'PUT').map((request) => request.headers['If-Match']), ['version1', 'version2']);
});