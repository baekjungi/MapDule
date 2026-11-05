const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing browser source section: ${start}`);
  return source.slice(first, last);
}

function control(value = '') {
  const listeners = new Map();
  return {
    value, disabled: false, hidden: false, innerHTML: '', textContent: '', checked: false,
    addEventListener(type, handler) { listeners.set(type, handler); },
    emit(type, event = {}) { return listeners.get(type)?.(event); },
    setCustomValidity(message) { this.validationMessage = message; },
    setAttribute(name, value) { this[name] = value; }
  };
}

const parseCalendarBackup = vm.runInNewContext(
  `${section('function parseCalendarBackup(', 'function escapeHtml(')}; parseCalendarBackup`
);

function savedEvent(overrides = {}) {
  return {
    id: 'one', title: '회의', date: '2026-11-06', startTime: '15:00', endTime: '16:00',
    category: '업무', calendarId: 'work', location: '', notes: '', ...overrides
  };
}

function backup(events, extras = {}) {
  return JSON.stringify({ format: 'mapdule-backup', version: 1, events, ...extras });
}

test('calendar backups round-trip timed, all-day and leap-day events', () => {
  const events = [
    savedEvent({ place: { lat: 37.5, lng: 127, name: '회의실' } }),
    savedEvent({ id: 'two', date: '2024-02-29', allDay: true, startTime: '00:00', endTime: '23:59' })
  ];
  assert.equal(JSON.stringify(parseCalendarBackup(backup(events)).events), JSON.stringify(events));
  assert.equal(parseCalendarBackup(backup([], { profile: {} })).events.length, 0);
  assert.equal(parseCalendarBackup(JSON.stringify({ format: 'mapdule-backup', events })).events.length, 2);
});

test('invalid backups fail as a whole instead of silently importing partial or broken events', () => {
  for (const changes of [
    { date: '2026-99-99' }, { date: '2026-02-29' }, { startTime: '25:00' },
    { endTime: '14:00' }, { endTime: '15:00' }, { title: '   ' }, { title: 'x'.repeat(81) },
    { location: {} }, { allDay: 'false' }, { place: { lat: null, lng: 127 } },
    { place: { lat: 91, lng: 0 } }
  ]) {
    assert.throws(() => parseCalendarBackup(backup([savedEvent({ id: 'valid' }), savedEvent(changes)])),
      /2번째 일정.*기존 데이터는 변경하지 않았습니다/);
  }
  assert.throws(() => parseCalendarBackup(backup([savedEvent(), savedEvent()])), /중복 ID/);
  for (const input of ['broken', 'null', '[]', backup([], { version: 99 }), backup([], { profile: [] })]) {
    assert.throws(() => parseCalendarBackup(input), /백업/);
  }
});

function restoreHarness({ storageAvailable = true, profileAvailable = true } = {}) {
  const input = control();
  const original = savedEvent({ id: 'existing' });
  let events = [original];
  let restore;
  const notices = [];
  vm.runInNewContext(section(
    "  document.querySelector('#backup-file').addEventListener('change'",
    "  document.querySelector('#clear-local-data').addEventListener("
  ), {
    document: { querySelector: () => input }, parseCalendarBackup,
    loadSavedEvents: () => events,
    saveEvents: (next) => {
      if (!storageAvailable) return false;
      events = next;
      return true;
    },
    showModal: (_title, _content, _label, action) => { restore = action; },
    localStorage: { setItem: () => { if (!profileAvailable) throw new Error('Storage quota'); } },
    PROFILE_STORAGE_KEY: 'mapdule-profile',
    renderProfileAvatar: () => {}, selectedDate: new Date(), setSelectedDate: () => {},
    showToast: (message, tone) => notices.push({ message, tone })
  });
  input.files = [{ text: async () => backup([savedEvent()], { profile: { name: '테스터' } }) }];
  return {
    read: () => input.emit('change', { currentTarget: input }),
    restore: () => restore(), events: () => events, notices
  };
}

test('a failed restore save leaves existing events intact and keeps the confirmation open', async () => {
  const harness = restoreHarness({ storageAvailable: false });
  await harness.read();
  assert.equal(harness.restore(), false);
  assert.deepEqual(harness.events().map((item) => item.id), ['existing']);
  assert.equal(harness.notices.length, 0);
});

test('a partial profile restore reports failure without overwriting it with a success toast', async () => {
  const harness = restoreHarness({ profileAvailable: false });
  await harness.read();
  assert.equal(harness.restore(), true);
  assert.equal(harness.events().length, 2);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].tone, 'info');
  assert.match(harness.notices[0].message, /프로필 저장에는 실패/);
});

test('correcting either time or selecting all-day clears the previous blocking validation error', () => {
  const start = control('15:00');
  const end = control('14:00');
  const allDay = control();
  const title = control();
  const presets = [30, 60, 120].map((minutes) => ({ ...control(), dataset: { eventDuration: String(minutes) } }));
  const form = {
    elements: { startTime: start, endTime: end, allDay },
    querySelectorAll: (selector) => selector === '[data-event-duration]' ? presets : []
  };
  vm.runInNewContext(section('  const updateAllDayFields = () =>', "\n  form.querySelectorAll('[data-event-duration]').forEach"), {
    form, timeFields: [start, end], titleInput: title
  });
  for (const input of [start, end]) {
    end.setCustomValidity('종료 시간이 잘못됨');
    input.emit('input');
    assert.equal(end.validationMessage, '');
  }
  end.setCustomValidity('종료 시간이 잘못됨');
  allDay.checked = true;
  allDay.emit('change');
  assert.equal(end.validationMessage, '');
  assert.equal(end.disabled, true);
  allDay.checked = false;
  allDay.emit('change');
  start.value = '';
  start.emit('input');
  assert.ok(presets.every((button) => button.disabled));
  title.setCustomValidity('빈 제목');
  title.emit('input');
  assert.equal(title.validationMessage, '');
});

test('editing an in-flight place query permits a new search and ignores the obsolete result', async () => {
  const input = control('강남역');
  const button = control();
  const status = control();
  const results = control();
  const pending = [];
  vm.runInNewContext(`let placeCandidates = []; let placeSearchId = 0; let selectedPlace = null;\n${
    section("  placeSearchButton.addEventListener('click'", "  form.elements.calendarId.addEventListener(")
  }`, {
    locationInput: input, placeSearchButton: button, locationStatus: status, placeResults: results,
    family: { searchPlaces: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    escapeHtml: String
  });
  const first = button.emit('click');
  assert.equal(button.disabled, true);
  input.value = '서울역';
  input.emit('input');
  assert.equal(button.disabled, false);
  const second = button.emit('click');
  pending[0].reject(new Error('old search failure'));
  await first;
  assert.equal(status.textContent, '지도에서 장소를 찾고 있어요.');
  assert.equal(button.disabled, true);
  pending[1].resolve([{ name: '서울역', address: '서울', lat: 37.55, lng: 126.97 }]);
  await second;
  assert.equal(button.disabled, false);
  assert.match(results.innerHTML, /서울역/);
  assert.doesNotMatch(results.innerHTML, /강남역/);
});

test('calendar cell keyboard handling leaves nested event buttons to their native activation', () => {
  const viewport = control();
  const opened = [];
  vm.runInNewContext(section(
    "document.querySelector('.calendar-view-content')?.addEventListener('keydown'",
    "document.querySelector('.create-event-button')"
  ), {
    document: { querySelector: () => viewport },
    openCalendarDate: (date) => opened.push(date)
  });
  const cell = { dataset: { calendarDate: '2026-11-06' } };
  cell.closest = () => cell;
  let prevented = false;
  viewport.emit('keydown', { key: 'Enter', target: { closest: () => cell }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(opened.length, 0);
  viewport.emit('keydown', { key: 'Enter', target: cell, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(opened, ['2026-11-06']);
});

test('rendering an empty day also refreshes the map to remove stale markers', () => {
  const timeline = control();
  let mapUpdates = 0;
  vm.runInNewContext(`${section('  function renderCalendar() {', '  async function analyzeSelectedDayPlan(')}; renderCalendar();`, {
    document: { querySelector: () => timeline },
    selectedDate: new Date(), localDateString: () => '2026-11-06',
    allEvents: () => [], window: { MapDuleFamily: { updateDayMap: () => { mapUpdates += 1; } } }
  });
  assert.equal(mapUpdates, 1);
  assert.match(timeline.innerHTML, /등록된 일정이 없어요/);
});

function aiHarness() {
  const selectors = new Map();
  const get = (selector) => {
    if (!selectors.has(selector)) selectors.set(selector, control());
    return selectors.get(selector);
  };
  let complete;
  const context = vm.createContext({
    document: { querySelector: get },
    fetch: () => new Promise((resolve) => { complete = resolve; }),
    readAiResponse: async (response) => response,
    escapeHtml: String, setAiAnalysisMessage: () => {}, showToast: () => {}
  });
  vm.runInContext(`let analyzedScheduleEvents = []; let aiPromptRevision = 0;\n${
    section("document.querySelector('#schedule-prompt')?.addEventListener('input'", "document.querySelector('#ai .primary-cta')?.addEventListener(")
  }`, context);
  return {
    get, complete: (result) => complete(result),
    analyze: () => get('#analyze-prompt').emit('click', { currentTarget: get('#analyze-prompt') }),
    eventCount: () => vm.runInContext('analyzedScheduleEvents.length', context)
  };
}

test('editing an already analyzed prompt disables registration and removes the old preview', async () => {
  const harness = aiHarness();
  harness.get('#schedule-prompt').value = '회의';
  const pending = harness.analyze();
  harness.complete({ events: [savedEvent()], assumptions: [] });
  await pending;
  assert.equal(harness.eventCount(), 1);
  assert.equal(harness.get('#ai .primary-cta').disabled, false);
  harness.get('#schedule-prompt').emit('input');
  assert.equal(harness.eventCount(), 0);
  assert.equal(harness.get('#ai .primary-cta').disabled, true);
  assert.doesNotMatch(harness.get('.ai-stack').innerHTML, /ai-preview-event/);
});

test('an AI response for an edited prompt cannot re-enable stale registration', async () => {
  const harness = aiHarness();
  harness.get('#schedule-prompt').value = '이전 문장';
  const pending = harness.analyze();
  harness.get('#schedule-prompt').value = '새 문장';
  harness.get('#schedule-prompt').emit('input');
  harness.complete({ events: [savedEvent()], assumptions: [] });
  await pending;
  assert.equal(harness.eventCount(), 0);
  assert.equal(harness.get('#ai .primary-cta').disabled, true);
  assert.equal(harness.get('#analyze-prompt').disabled, false);
});
