const test = require('node:test');
const assert = require('node:assert/strict');
const { createFamilyService, MAX_TRAIL_POINTS } = require('../api/src/family-service');
const { createMemoryStore, createTableStore } = require('../api/src/family-store');

function setup(startTime = Date.parse('2026-10-25T09:00:00+09:00')) {
  let clock = startTime;
  const store = createMemoryStore();
  const service = createFamilyService({ store, now: () => clock });
  return {
    service,
    store,
    advance(ms) { clock += ms; },
    time() { return clock; }
  };
}

async function createFamilyWithTwoMembers(service) {
  const parent = await service.handle({ method: 'POST', action: 'create', body: { familyName: '백씨네', memberName: '아빠' } });
  const state = await service.handle({ method: 'GET', action: 'state', credential: parent.credential });
  const child = await service.handle({ method: 'POST', action: 'join', body: { inviteCode: state.family.inviteCode.toLowerCase(), memberName: '준기' } });
  return { parent, child, inviteCode: state.family.inviteCode };
}

test('creates a family and lets a second member join with the invite code', async () => {
  const { service } = setup();
  const { parent, child } = await createFamilyWithTwoMembers(service);
  const state = await service.handle({ method: 'GET', action: 'state', credential: child.credential });
  assert.equal(state.family.name, '백씨네');
  assert.deepEqual(state.members.map((member) => member.name).sort(), ['아빠', '준기'].sort());
  assert.notEqual(state.members[0].color, state.members[1].color);
  assert.equal(state.me, child.memberId);
  assert.ok(state.members.every((member) => !('secretHash' in member)), 'secret hashes must never leave the server');
  assert.ok(parent.credential.split('.').length === 3);
});

test('rejects unknown invite codes and forged credentials', async () => {
  const { service } = setup();
  const { child } = await createFamilyWithTwoMembers(service);
  await assert.rejects(
    service.handle({ method: 'POST', action: 'join', body: { inviteCode: 'ZZZZZZ', memberName: '엄마' } }),
    (error) => error.statusCode === 404 && error.code === 'INVITE_NOT_FOUND'
  );
  const [familyId, memberId] = child.credential.split('.');
  await assert.rejects(
    service.handle({ method: 'GET', action: 'state', credential: `${familyId}.${memberId}.forgedsecretvalue123` }),
    (error) => error.statusCode === 401
  );
  await assert.rejects(service.handle({ method: 'GET', action: 'state' }), (error) => error.statusCode === 401);
});

test('shares family events with participants and skips unchanged event lists', async () => {
  const { service } = setup();
  const { parent, child } = await createFamilyWithTwoMembers(service);
  const { event } = await service.handle({
    method: 'POST',
    action: 'event',
    credential: parent.credential,
    body: { event: { title: '할머니 댁 방문', date: '2026-10-31', startTime: '14:00', endTime: '17:00', allDay: false, location: '청주 할머니 댁', participants: [parent.memberId, child.memberId, 'unknown-member'], place: { lat: 36.64, lng: 127.49, name: '할머니 댁' } } }
  });
  assert.deepEqual(event.participants, [parent.memberId, child.memberId]);

  const first = await service.handle({ method: 'GET', action: 'state', credential: child.credential });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].place.name, '할머니 댁');

  const second = await service.handle({ method: 'GET', action: 'state', credential: child.credential, query: { rev: first.eventsRev } });
  assert.equal(second.events, null, 'unchanged events are not re-sent');

  await service.handle({ method: 'POST', action: 'event-delete', credential: child.credential, body: { id: event.id } });
  const third = await service.handle({ method: 'GET', action: 'state', credential: parent.credential, query: { rev: first.eventsRev } });
  assert.deepEqual(third.events, []);
});

test('validates event times', async () => {
  const { service } = setup();
  const { parent } = await createFamilyWithTwoMembers(service);
  await assert.rejects(
    service.handle({ method: 'POST', action: 'event', credential: parent.credential, body: { event: { title: '잘못된 일정', date: '2026-10-31', startTime: '15:00', endTime: '14:00' } } }),
    (error) => error.statusCode === 400
  );
  const allDay = await service.handle({ method: 'POST', action: 'event', credential: parent.credential, body: { event: { title: '가족 여행', date: '2026-11-01', allDay: true } } });
  assert.equal(allDay.event.startTime, '00:00');
});

test('tracks a trip from departure until it arrives near the destination', async () => {
  const { service, advance, time } = setup();
  const { parent, child } = await createFamilyWithTwoMembers(service);
  const destination = { lat: 37.4979, lng: 127.0276, name: '강남역' };
  const { trip } = await service.handle({
    method: 'POST',
    action: 'trip-start',
    credential: child.credential,
    body: { title: '학원 가는 길', destination, mode: 'transit', points: [{ lat: 37.4842, lng: 126.9297, accuracy: 20, at: new Date(time()).toISOString() }] }
  });
  assert.equal(trip.status, 'moving');

  advance(10 * 60 * 1000);
  const moving = await service.handle({
    method: 'POST', action: 'trip-point', credential: child.credential,
    body: { tripId: trip.id, points: [{ lat: 37.49, lng: 126.98, accuracy: 15, at: new Date(time()).toISOString() }] }
  });
  assert.equal(moving.trip.status, 'moving');
  assert.equal(moving.trip.points.length, 2);

  const watching = await service.handle({ method: 'GET', action: 'state', credential: parent.credential });
  assert.equal(watching.trips.length, 1);
  assert.equal(watching.trips[0].memberId, child.memberId);

  advance(10 * 60 * 1000);
  const arrived = await service.handle({
    method: 'POST', action: 'trip-point', credential: child.credential,
    body: { tripId: trip.id, points: [{ lat: 37.49795, lng: 127.02755, accuracy: 10, at: new Date(time()).toISOString() }] }
  });
  assert.equal(arrived.trip.status, 'arrived');
  assert.ok(arrived.trip.endedAt);
  assert.deepEqual(arrived.trip.points, []);
  assert.deepEqual(arrived.trip.destination, { name: '강남역' });

  advance(13 * 60 * 60 * 1000);
  const later = await service.handle({ method: 'GET', action: 'state', credential: parent.credential });
  assert.equal(later.trips.length, 0, 'old finished trips are hidden');
});

test('stopping a share deletes the stored trip and route', async () => {
  const { service, store, time } = setup();
  const { child } = await createFamilyWithTwoMembers(service);
  const { trip } = await service.handle({
    method: 'POST', action: 'trip-start', credential: child.credential,
    body: { title: '산책', points: [{ lat: 37.5, lng: 127, at: new Date(time()).toISOString() }] }
  });
  const stopped = await service.handle({ method: 'POST', action: 'trip-end', credential: child.credential, body: { tripId: trip.id, reason: 'stopped' } });
  assert.equal(stopped.trip.status, 'stopped');
  assert.deepEqual(stopped.trip.points, []);
  assert.equal(stopped.trip.destination, null);
  assert.equal(await store.get(`family:${child.credential.split('.')[0]}`, `trip_${child.memberId}`), null);
});

test('keeps long trails under the storage limit', async () => {
  const { service, advance, time } = setup();
  const { child } = await createFamilyWithTwoMembers(service);
  const { trip } = await service.handle({ method: 'POST', action: 'trip-start', credential: child.credential, body: { title: '긴 이동' } });
  for (let batch = 0; batch < 20; batch += 1) {
    const points = Array.from({ length: 30 }, (_, index) => {
      advance(5000);
      return { lat: 37 + (batch * 30 + index) * 0.0001, lng: 127, at: new Date(time()).toISOString() };
    });
    await service.handle({ method: 'POST', action: 'trip-point', credential: child.credential, body: { tripId: trip.id, points } });
  }
  const state = await service.handle({ method: 'GET', action: 'state', credential: child.credential });
  assert.ok(state.trips[0].points.length <= MAX_TRAIL_POINTS);
  assert.ok(Math.abs(state.trips[0].points.at(-1).lat - (37 + 599 * 0.0001)) < 1e-6, 'the latest point is always kept');
});

test('removes the family when the last member leaves', async () => {
  const { service, store } = setup();
  const { parent, child, inviteCode } = await createFamilyWithTwoMembers(service);
  const familyId = parent.credential.split('.')[0];
  await service.handle({
    method: 'POST',
    action: 'event',
    credential: parent.credential,
    body: { event: { title: '가족 일정', date: '2026-11-01', startTime: '12:00', endTime: '13:00' } }
  });
  await service.handle({ method: 'POST', action: 'leave', credential: child.credential });
  await assert.rejects(service.handle({ method: 'GET', action: 'state', credential: child.credential }), (error) => error.statusCode === 401);
  await service.handle({ method: 'POST', action: 'leave', credential: parent.credential });
  await assert.rejects(
    service.handle({ method: 'POST', action: 'join', body: { inviteCode, memberName: '엄마' } }),
    (error) => error.code === 'INVITE_NOT_FOUND'
  );
  assert.deepEqual(await store.list(`family:${familyId}`), []);
});

test('limits repeated family creation and invite-code guesses per client', async () => {
  const { service } = setup();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await service.handle({ method: 'POST', action: 'create', clientKey: 'client-a', body: { memberName: `사람${attempt}` } });
  }
  await assert.rejects(
    service.handle({ method: 'POST', action: 'create', clientKey: 'client-a', body: { memberName: '네번째' } }),
    (error) => error.statusCode === 429 && error.code === 'RATE_LIMITED'
  );

  const anotherService = setup().service;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await assert.rejects(
      anotherService.handle({ method: 'POST', action: 'join', clientKey: 'client-b', body: { inviteCode: 'ZZZZZZ', memberName: '사람' } }),
      (error) => error.statusCode === 404
    );
  }
  await assert.rejects(
    anotherService.handle({ method: 'POST', action: 'join', clientKey: 'client-b', body: { inviteCode: 'ZZZZZZ', memberName: '사람' } }),
    (error) => error.statusCode === 429 && error.code === 'RATE_LIMITED'
  );
});

test('removes expired trip records from storage on the next state request', async () => {
  const { service, store, advance, time } = setup();
  const { parent, child } = await createFamilyWithTwoMembers(service);
  const { trip } = await service.handle({
    method: 'POST',
    action: 'trip-start',
    credential: child.credential,
    body: { title: '이동', points: [{ lat: 37.5, lng: 127, at: new Date(time()).toISOString() }] }
  });
  await service.handle({ method: 'POST', action: 'trip-end', credential: child.credential, body: { tripId: trip.id, reason: 'stopped' } });
  advance(13 * 60 * 60 * 1000);

  const state = await service.handle({ method: 'GET', action: 'state', credential: parent.credential });
  assert.equal(state.trips.length, 0);
  assert.equal(await store.get(`family:${parent.credential.split('.')[0]}`, `trip_${child.memberId}`), null);
});

test('table store signs Azure Table Storage REST requests', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET' && url.includes('()?')) {
      return new Response(JSON.stringify({ value: [{ RowKey: 'event_a', data: '{"id":"a"}' }] }), { status: 200 });
    }
    if (options.method === 'GET') return new Response('{}', { status: 404 });
    return new Response(null, { status: options.method === 'POST' ? 409 : 204 });
  };
  const store = createTableStore('DefaultEndpointsProtocol=https;AccountName=mapdulestore;AccountKey=dGVzdGtleQ==;EndpointSuffix=core.windows.net', 'mapdulefamily', fetchImpl);
  assert.equal(await store.get('family:abc', 'info'), null);
  await store.put('family:abc', "event_it's", { title: '테스트' });
  const rows = await store.list('family:abc', 'event_');

  assert.deepEqual(rows, [{ row: 'event_a', value: { id: 'a' } }]);
  const putCall = calls.find((call) => call.options.method === 'PUT');
  assert.equal(putCall.url, "https://mapdulestore.table.core.windows.net/mapdulefamily(PartitionKey='family%3Aabc',RowKey='event_it''s')");
  assert.ok(putCall.options.signal, 'storage requests have a bounded timeout');
  assert.match(putCall.options.headers.Authorization, /^SharedKeyLite mapdulestore:[A-Za-z0-9+/=]+$/);
  assert.equal(JSON.parse(putCall.options.body).PartitionKey, 'family:abc');
  assert.ok(putCall.options.signal, 'storage requests have a bounded timeout');
  const queryCall = calls.find((call) => call.url.includes('()?'));
  assert.match(decodeURIComponent(queryCall.url), /RowKey ge 'event_' and RowKey lt 'event`'/);
  assert.throws(
    () => createTableStore('DefaultEndpointsProtocol=http;AccountName=mapdulestore;AccountKey=dGVzdGtleQ=='),
    /HTTPS/
  );
});
