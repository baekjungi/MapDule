const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const familySource = fs.readFileSync(path.join(__dirname, '..', 'family.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function departureHarness(selection, positionError) {
  const calls = [];
  const notices = [];
  let fixes = 0;
  const context = vm.createContext({
    busy: false, departureSelectionPending: false, mapFittedOnce: false,
    isJoined: () => true, selectDeparture: async () => selection,
    renderFamilyView() {}, getPosition: async (consentGiven) => {
      assert.equal(consentGiven, true);
      fixes += 1;
      if (positionError) throw positionError;
      return { coords: { latitude: 37.5, longitude: 127, accuracy: 20 } };
    },
    geocode: async () => ({ lat: 37.6, lng: 127.1 }),
    myTrip: () => null, toPoint: () => ({ lat: 37.5, lng: 127, accuracy: 20 }),
    api: async (action, options) => {
      calls.push({ action, body: options.body });
      return { trip: { id: 'trip', status: 'moving' } };
    },
    replaceMyTrip() {}, writeJson() {}, ACTIVE_TRIP_KEY: 'active',
    startWatching() {}, afterStateChange() {}, refresh() {}, showView() {},
    showToast: (text) => notices.push(text)
  });
  vm.runInContext(section(familySource, '  async function startTrip({', '  async function endTrip('), context);
  return { context, calls, notices, fixes: () => fixes, start: (options = {}) => context.startTrip(options) };
}

test('all three departure choices are sent to the API rather than the profile default', async () => {
  for (const mode of ['walk', 'car', 'transit']) {
    const harness = departureHarness({ mode, destinationText: '학교' });
    await harness.start({ eventId: 'event', title: '등교' });
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].action, 'trip-start');
    assert.equal(harness.calls[0].body.mode, mode);
    assert.equal(harness.calls[0].body.eventId, 'event');
    assert.equal(harness.fixes(), 1);
    assert.equal(harness.context.busy, false);
  }
});

test('cancelling departure never requests GPS or saves a departure', async () => {
  const harness = departureHarness(null);
  await harness.start();
  assert.equal(harness.fixes(), 0);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.context.departureSelectionPending, false);
});

test('repeated clicks cannot open concurrent transport selections', async () => {
  const harness = departureHarness(null);
  let finish;
  let selections = 0;
  harness.context.selectDeparture = () => {
    selections += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = harness.start();
  await harness.start();
  assert.equal(selections, 1);
  finish(null);
  await first;
  assert.equal(harness.calls.length, 0);
});

test('location failures do not save a trip and release the departure controls', async () => {
  for (const error of [new Error('GPS 시간 초과'), new Error('위치 정확도가 낮아요'),
    Object.assign(new Error('취소'), { code: 'LOCATION_CANCELLED' })]) {
    const harness = departureHarness({ mode: 'walk', destinationText: '' }, error);
    await harness.start();
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.context.busy, false);
    assert.equal(harness.notices.length, error.code === 'LOCATION_CANCELLED' ? 0 : 1);
  }
});

test('event departure defers geocoding until after transport selection', async () => {
  const event = { id: 'one', title: '학교', source: 'family', location: '서울 학교' };
  let options;
  const context = vm.createContext({
    allEvents: () => [event], startTrip: async (value) => { options = value; },
    geocode: () => { throw new Error('Premature geocoding'); }, showToast() {}
  });
  vm.runInContext(section(familySource, '  async function startTripForEvent(', '  function canDepartFor('), context);
  await context.startTripForEvent('one');
  assert.equal(options.eventId, 'one');
  assert.equal(options.destinationText, event.location);
});

test('return departures use the same selection flow and defer home geocoding', async () => {
  const event = { id: 'one', title: '학교' };
  let options;
  const context = vm.createContext({
    familyEvents: () => [event], canReturnFor: () => true,
    readJson: (key) => key === 'mapdule-profile' ? { home: '서울 집' } : null,
    HOME_PLACE_KEY: 'home', startTrip: async (value) => { options = value; },
    geocode: () => { throw new Error('Premature home geocoding'); }, showToast() {}
  });
  vm.runInContext(section(familySource, '  async function startReturnTrip(', '  function watchersHtml('), context);
  await context.startReturnTrip('one');
  assert.equal(options.returnFor, 'one');
  assert.equal(options.destinationText, '서울 집');
  assert.equal(options.destination, null);
});

function locationHarness(permission, consentGiven) {
  let dialog;
  let requests = 0;
  const context = vm.createContext({
    window: { isSecureContext: true },
    navigator: {
      userAgent: 'Chrome',
      permissions: { query: async () => ({ state: permission }) },
      geolocation: { getCurrentPosition: (resolve) => { requests += 1; resolve({ coords: {} }); } }
    },
    showLocationPermissionDialog: (options) => { dialog = options; }
  });
  vm.runInContext(section(appSource, 'function requestLocationWithConsent(', 'async function showCurrentLocation('), context);
  const promise = context.requestLocationWithConsent({ title: '위치', description: '확인', actionLabel: '허용', consentGiven });
  return { promise, dialog: () => dialog, requests: () => requests };
}

test('confirmed departure requests GPS without a second explanation; blocked permission still shows settings', async () => {
  const confirmed = locationHarness('prompt', true);
  await confirmed.promise;
  assert.equal(confirmed.requests(), 1);
  assert.equal(confirmed.dialog(), undefined);
  const blocked = locationHarness('denied', true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blocked.requests(), 0);
  assert.match(blocked.dialog().title, /권한이 꺼져/);
  blocked.dialog().onCancel();
  await assert.rejects(blocked.promise, (error) => error.code === 'LOCATION_CANCELLED');
  const unconfirmed = locationHarness('prompt', false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unconfirmed.requests(), 0);
  unconfirmed.dialog().onContinue();
  await unconfirmed.promise;
  assert.equal(unconfirmed.requests(), 1);
});
