const test = require('node:test');
const assert = require('node:assert/strict');
const { createFamilyService } = require('../api/src/family-service');
const { createMemoryStore } = require('../api/src/family-store');

const subscriptionFor = (name) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, name.length)]).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') }
});

async function setup({ withNotifier = true } = {}) {
  let clock = Date.parse('2026-10-25T16:00:00+09:00');
  const sent = [];
  const notifier = withNotifier ? async (subscription, payload) => {
    if (subscription.endpoint.endsWith('/gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    sent.push({ to: subscription.endpoint.split('/').pop(), ...payload });
  } : null;
  const store = createMemoryStore();
  const service = createFamilyService({ store, now: () => clock, notifier });
  const parent = await service.handle({ method: 'POST', action: 'create', body: { memberName: '엄마' } });
  const call = (member, method, action, data = {}) => service.handle({
    credential: member.credential, method, action, ...(method === 'GET' ? { query: data } : { body: data })
  });
  const state = await call(parent, 'GET', 'state');
  const join = (name) => service.handle({ method: 'POST', action: 'join', body: { memberName: name, inviteCode: state.family.inviteCode } });
  const child = await join('준기');
  const at = (value) => { clock = Date.parse(`2026-10-25T${value}:00+09:00`); };
  const save = async (extra = {}) => (await call(parent, 'POST', 'event', { event: {
    title: '수학학원', date: '2026-10-25', startTime: '17:00', endTime: '18:30', participants: [child.memberId],
    place: { lat: 37.5, lng: 127, name: '학원' }, departNotice: 30, ...extra } })).event;
  const subscribe = (member, name) => call(member, 'POST', 'push-subscribe', { subscription: subscriptionFor(name) });
  const start = (member, body) => call(member, 'POST', 'trip-start', {
    points: [{ lat: 37.55, lng: 127.05, accuracy: 20, at: new Date(clock).toISOString() }], ...body
  });
  const take = () => sent.splice(0);
  return { store, service, call, parent, child, at, save, subscribe, start, take, partition: `family:${state.family.id}` };
}

test('push subscription validates the endpoint and is removed when the member leaves', async () => {
  const { call, child, subscribe, store, partition } = await setup();
  await assert.rejects(call(child, 'POST', 'push-subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: {} } }),
    (error) => error.code === 'INVALID_PUSH');
  assert.deepEqual(await subscribe(child, 'child'), { subscribed: true, delivery: true });
  assert.ok(await store.get(partition, `push_${child.memberId}`));
  await call(child, 'POST', 'leave');
  assert.equal(await store.get(partition, `push_${child.memberId}`), null);
});

test('closed-app alarms: child departure alarm, then parent no-show alert, each sent once', async () => {
  const { service, parent, child, at, save, subscribe, take } = await setup();
  await subscribe(parent, 'mom');
  await subscribe(child, 'child');
  await save();
  at('16:29');
  await service.dispatchAlarms();
  assert.deepEqual(take(), []);
  at('16:30');
  await service.dispatchAlarms();
  const departure = take();
  assert.equal(departure.length, 1);
  assert.equal(departure[0].to, 'child');
  assert.equal(departure[0].title, '출발할 시간이에요');
  assert.equal(departure[0].url, '/#family');
  await service.dispatchAlarms();
  assert.deepEqual(take(), [], 'the same alarm is not sent twice');
  at('16:35');
  await service.dispatchAlarms();
  const noShow = take();
  assert.equal(noShow.length, 1);
  assert.equal(noShow[0].to, 'mom');
  assert.equal(noShow[0].title, '준기님이 아직 출발하지 않았어요');
  at('16:36');
  await service.dispatchAlarms();
  assert.deepEqual(take(), []);
});

test('no departure or no-show push once the child has left', async () => {
  const { service, parent, child, at, save, subscribe, start, take } = await setup();
  await subscribe(parent, 'mom');
  await subscribe(child, 'child');
  const event = await save();
  at('16:20');
  await start(child, { eventId: event.id });
  const started = take();
  assert.deepEqual(started.map((item) => [item.to, item.title]), [['mom', '준기님이 출발했어요']]);
  at('16:30');
  await service.dispatchAlarms();
  at('16:40');
  await service.dispatchAlarms();
  assert.deepEqual(take(), []);
});

test('arrival, class end, return-home alarm and home arrival reach the right people', async () => {
  const { service, call, parent, child, at, save, subscribe, start, take } = await setup();
  await subscribe(parent, 'mom');
  await subscribe(child, 'child');
  const event = await save({ returnHome: true });
  at('16:40');
  const { trip } = await start(child, { eventId: event.id });
  at('16:55');
  await call(child, 'POST', 'trip-end', { tripId: trip.id, reason: 'arrived' });
  assert.deepEqual(take().map((item) => [item.to, item.title]), [['mom', '준기님이 출발했어요'], ['mom', '준기님이 도착했어요']]);
  at('18:30');
  await service.dispatchAlarms();
  const ended = take().map((item) => [item.to, item.title]).sort();
  assert.deepEqual(ended, [['child', '수학학원 끝! 집에 갈 시간이에요'], ['mom', '준기님이 수학학원 일정을 마쳤어요']]);
  at('18:35');
  const home = await start(child, { returnFor: event.id, destination: { lat: 37.6, lng: 127.1, name: '집' } });
  assert.deepEqual(take().map((item) => [item.to, item.title]), [['mom', '준기님이 집으로 출발했어요']]);
  at('18:55');
  await call(child, 'POST', 'trip-end', { tripId: home.trip.id, reason: 'arrived' });
  assert.deepEqual(take().map((item) => [item.to, item.title, item.body]), [['mom', '준기님이 집에 왔어요', '수학학원 다녀왔어요']]);
});

test('expired subscriptions are dropped and dispatch is a no-op without push configuration', async () => {
  const { service, parent, child, at, save, subscribe, store, partition, take } = await setup();
  await subscribe(parent, 'gone');
  await save();
  at('16:35');
  await service.dispatchAlarms();
  assert.equal(await store.get(partition, `push_${parent.memberId}`), null);
  assert.deepEqual(take().map((item) => item.to), []);
  const quiet = await setup({ withNotifier: false });
  await quiet.subscribe(quiet.child, 'child');
  assert.deepEqual(await quiet.service.dispatchAlarms(), { families: 0, sent: 0 });
  void child;
});
