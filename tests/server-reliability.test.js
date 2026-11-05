const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileStore, createMemoryStore } = require('../api/src/family-store');
const { createFamilyService } = require('../api/src/family-service');
const { parseSchedulePrompt } = require('../api/src/ai-schedule');

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mapdule-reliability-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a successful local write is durable before the request can be acknowledged', async (context) => {
  const file = path.join(temporaryDirectory(context), 'family.json');
  const store = createFileStore(file);
  await store.put('family:test', 'info', { name: 'saved' });
  assert.deepEqual(await createFileStore(file).get('family:test', 'info'), { name: 'saved' });
  await store.remove('family:test', 'info');
  assert.equal(await createFileStore(file).get('family:test', 'info'), null);
});

test('corrupted or invalid local data fails explicitly and is not overwritten', (context) => {
  const file = path.join(temporaryDirectory(context), 'family.json');
  for (const content of ['{broken', '{}', '[["invalid-key"]]', '[123]']) {
    fs.writeFileSync(file, content);
    assert.throws(() => createFileStore(file), /family data/i);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('failed local persistence rejects the operation and restores the in-memory value', async (context) => {
  const directory = temporaryDirectory(context);
  const file = path.join(directory, 'family.json');
  const store = createFileStore(file);
  await store.put('family:test', 'info', { name: 'original' });
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  await assert.rejects(store.put('family:test', 'info', { name: 'not saved' }));
  assert.deepEqual(await store.get('family:test', 'info'), { name: 'original' });
  await assert.rejects(store.remove('family:test', 'info'));
  assert.deepEqual(await store.get('family:test', 'info'), { name: 'original' });
  assert.deepEqual(fs.readdirSync(directory), ['family.json'], 'failed writes must not leave temporary files');
});

test('failed atomic replacement preserves the previous on-disk snapshot and cleans up', async (context) => {
  const directory = temporaryDirectory(context);
  const file = path.join(directory, 'family.json');
  const store = createFileStore(file);
  await store.put('family:test', 'info', { name: 'original' });
  const original = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === file) throw Object.assign(new Error('simulated replacement failure'), { code: 'EACCES' });
    return rename(source, destination);
  };
  context.after(() => { fs.renameSync = rename; });
  await assert.rejects(store.put('family:test', 'info', { name: 'replacement' }), (error) => error.code === 'EACCES');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(await store.get('family:test', 'info'), { name: 'original' });
  assert.deepEqual(fs.readdirSync(directory), ['family.json']);
});

test('rapid concurrent local mutations all survive reopening the store', async (context) => {
  const file = path.join(temporaryDirectory(context), 'family.json');
  const store = createFileStore(file);
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    store.put('family:test', `message_${index}`, { text: String(index) })));
  const restored = createFileStore(file);
  assert.deepEqual(await restored.list('family:test'), await store.list('family:test'));
  assert.equal((await restored.list('family:test')).length, 20);
});

test('malformed upstream AI envelopes produce a controlled gateway error, not a TypeError', async (context) => {
  const keys = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT'];
  const saved = keys.map((key) => process.env[key]);
  const originalFetch = global.fetch;
  context.after(() => {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    global.fetch = originalFetch;
  });
  process.env.AZURE_OPENAI_ENDPOINT = 'https://resource.example/openai/v1/responses';
  process.env.AZURE_OPENAI_API_KEY = 'test-key';
  process.env.AZURE_OPENAI_DEPLOYMENT = 'test-deployment';
  for (const envelope of [null, [], { output: {} }, { output: [null] }, { output: [{ content: [null] }] }]) {
    global.fetch = async () => new Response(JSON.stringify(envelope), { status: 200 });
    await assert.rejects(parseSchedulePrompt('내일 회의'),
      (error) => error.statusCode === 502 && error.code === 'AZURE_OPENAI_EMPTY_RESPONSE');
  }
});

test('location input does not convert missing coordinates to a real location at zero', async () => {
  const clock = Date.parse('2026-11-04T10:00:00Z');
  const service = createFamilyService({ store: createMemoryStore(), now: () => clock });
  const member = await service.handle({ method: 'POST', action: 'create', body: { memberName: 'test' } });
  const { trip } = await service.handle({
    method: 'POST', action: 'trip-start', credential: member.credential,
    body: { points: [{ lat: null, lng: '', at: new Date(clock).toISOString() }] }
  });
  assert.deepEqual(trip.points, []);
});

test('arrival uses the latest GPS fix even if a batch is out of order or duplicated', async () => {
  const clock = Date.parse('2026-11-04T10:00:00Z');
  const service = createFamilyService({ store: createMemoryStore(), now: () => clock });
  const member = await service.handle({ method: 'POST', action: 'create', body: { memberName: 'test' } });
  const latest = { lat: 38, lng: 127, at: new Date(clock).toISOString(), accuracy: null };
  const { trip } = await service.handle({
    method: 'POST', action: 'trip-start', credential: member.credential,
    body: {
      destination: { lat: 37, lng: 127, name: 'destination' },
      points: [latest, latest, { lat: 37, lng: 127, at: new Date(clock - 1000).toISOString() }]
    }
  });
  assert.equal(trip.status, 'moving');
  assert.equal(trip.points.length, 2);
  assert.equal(trip.points.at(-1).lat, 38);
  assert.equal(trip.points.at(-1).accuracy, null);
});
