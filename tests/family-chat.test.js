const test = require('node:test');
const assert = require('node:assert/strict');
const { createFamilyService } = require('../api/src/family-service');
const { createMemoryStore } = require('../api/src/family-store');
const { MAX_MESSAGES, MAX_MESSAGE_LENGTH } = require('../api/src/family-chat');

async function setup() {
  const store = createMemoryStore();
  let clock = Date.parse('2026-11-04T10:00:00Z');
  const service = createFamilyService({ store, now: () => clock++ });
  const first = await service.handle({ method: 'POST', action: 'create', body: { memberName: '엄마' } });
  const state = await service.handle({ method: 'GET', action: 'state', credential: first.credential });
  const second = await service.handle({
    method: 'POST', action: 'join', body: { memberName: '아이', inviteCode: state.family.inviteCode }
  });
  const send = (member, text, extra = {}) => service.handle({
    method: 'POST', action: 'message', credential: member.credential, body: { text, ...extra }
  });
  const list = (member) => service.handle({ method: 'GET', action: 'messages', credential: member.credential });
  return { store, service, first, second, send, list, familyId: state.family.id };
}

test('family members share persisted text, newlines and emoji with server-owned sender data', async () => {
  const { store, first, second, send, list } = await setup();
  assert.deepEqual(await list(first), { messages: [] });
  const text = '다녀올게요!\n\u{1F600} \u2764\uFE0F';
  const { message } = await send(first, `  ${text}  `, { senderId: second.memberId, senderName: '사칭' });
  assert.equal(message.text, text);
  assert.equal(message.senderId, first.memberId);
  assert.equal(message.senderName, '엄마');
  assert.ok(Number.isFinite(Date.parse(message.createdAt)));
  assert.deepEqual((await list(second)).messages, [message]);
  const restarted = createFamilyService({ store });
  assert.deepEqual((await restarted.handle({
    method: 'GET', action: 'messages', credential: second.credential
  })).messages, [message]);
});

test('chat rejects anonymous, forged and departed members and isolates families', async () => {
  const { service, first, second, send, list } = await setup();
  await send(first, '우리 가족만 볼 수 있어요');
  for (const [method, action] of [['GET', 'messages'], ['POST', 'message']]) {
    for (const credential of [undefined, `${first.credential.slice(0, -4)}fake`]) {
      await assert.rejects(service.handle({ method, action, credential, body: { text: 'test' } }),
        (error) => error.statusCode === 401);
    }
  }
  const other = await service.handle({ method: 'POST', action: 'create', body: { memberName: '다른 가족' } });
  assert.deepEqual(await list(other), { messages: [] });
  await service.handle({ method: 'POST', action: 'leave', credential: second.credential });
  await assert.rejects(list(second), (error) => error.statusCode === 401);
});

test('validates message length, type, blanks and controls without silently truncating', async () => {
  const { send, first } = await setup();
  for (const text of [undefined, null, 123, {}, [], '', ' \n\t ', 'a'.repeat(MAX_MESSAGE_LENGTH + 1), 'bad\u0000text']) {
    await assert.rejects(send(first, text), (error) => error.statusCode === 400 && error.code === 'INVALID_MESSAGE');
  }
  assert.equal((await send(first, 'a'.repeat(MAX_MESSAGE_LENGTH))).message.text.length, MAX_MESSAGE_LENGTH);
});

test('concurrent sends are stored in separate records without lost updates', async () => {
  const { first, second, send, list } = await setup();
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    send(index % 2 ? first : second, `message ${index}`)));
  const { messages } = await list(first);
  assert.equal(messages.length, 20);
  assert.equal(new Set(messages.map((message) => message.id)).size, 20);
  assert.deepEqual(new Set(messages.map((message) => message.id)), new Set(results.map(({ message }) => message.id)));
});

test('retains the latest 200 messages and removes chat records when the last member leaves', async () => {
  const { store, service, familyId, first, second, send, list } = await setup();
  const partition = `family:${familyId}`;
  for (let index = 0; index < MAX_MESSAGES + 3; index += 1) {
    const id = String(index).padStart(13, '0');
    await store.put(partition, `message_${id}`, { id, text: `old ${index}` });
  }
  assert.equal((await list(first)).messages.length, MAX_MESSAGES);
  const { message } = await send(first, 'newest');
  const { messages } = await list(second);
  assert.equal(messages.length, MAX_MESSAGES);
  assert.equal(messages.at(-1).id, message.id);
  assert.equal(messages[0].text, 'old 4');
  assert.equal((await store.list(partition, 'message_')).length, MAX_MESSAGES);
  await service.handle({ method: 'POST', action: 'leave', credential: first.credential });
  await service.handle({ method: 'POST', action: 'leave', credential: second.credential });
  assert.deepEqual(await store.list(partition, 'message_'), []);
});

test('limits message sending per authenticated member without blocking other members or reads', async () => {
  const { first, second, send, list } = await setup();
  for (let index = 0; index < 20; index += 1) await send(first, `message ${index}`);
  await assert.rejects(send(first, 'too many'), (error) => error.statusCode === 429);
  await send(second, '다른 가족은 보낼 수 있어요');
  assert.equal((await list(first)).messages.length, 21);
});
