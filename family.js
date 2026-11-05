// MapDule 가족방 채팅
(() => {
  const EMOJIS = [
    ['\u{1F600}', '웃음'], ['\u{1F602}', '크게 웃음'], ['\u{1F60D}', '반했어요'],
    ['\u{1F44D}', '좋아요'], ['\u{1F44F}', '박수'], ['\u{1F64F}', '고마워요'],
    ['\u2764\uFE0F', '하트'], ['\u{1F389}', '축하'], ['\u{1F44B}', '인사'],
    ['\u{1F3E0}', '집'], ['\u{1F697}', '자동차'], ['\u{1F35A}', '밥']
  ];
  let current = null;

  function dispose() {
    if (!current) return;
    clearTimeout(current.timer);
    current.node.remove();
    current = null;
  }

  function mount(slot, { api, familyId, me }) {
    if (!current || current.familyId !== familyId || current.me !== me) {
      dispose();
      const node = document.createElement('section');
      node.className = 'family-chat panel';
      node.setAttribute('aria-label', '가족 채팅');
      node.innerHTML = `
        <div class="family-chat-heading"><h2><span class="material-symbols-rounded">forum</span>가족 채팅</h2><small>최근 200개 메시지</small></div>
        <div class="family-chat-log" role="log" aria-label="가족 대화" aria-live="polite" aria-relevant="additions"></div>
        <div class="family-chat-status" role="status"></div>
        <button type="button" class="family-chat-retry" hidden>다시 불러오기</button>
        <form class="family-chat-form">
          <label class="family-chat-label"><span class="family-chat-label-row"><span>가족에게 메시지</span><small class="family-chat-count" aria-hidden="true">0 / 1,000자</small></span><textarea name="message" rows="2" maxlength="1000" required aria-describedby="family-chat-hint" placeholder="가족에게 메시지를 남겨 보세요"></textarea></label>
          <div class="family-chat-toolbar"><button type="button" class="family-chat-toggle" aria-expanded="false" aria-controls="family-chat-emoji-picker" aria-label="이모지 선택" title="이모지 선택 · 이스케이프 키로 닫기"><span class="family-chat-emoji">\u{1F600}</span> 이모지</button><small id="family-chat-hint">최대 1,000자 · 엔터로 전송 · 시프트+엔터로 줄바꿈</small><button type="submit" class="family-chat-send" disabled>보내기</button></div>
          <div class="family-chat-picker" id="family-chat-emoji-picker" role="group" aria-label="간단한 이모지" hidden>${EMOJIS.map(([emoji, label]) => `<button type="button" class="family-chat-emoji" data-chat-emoji="${emoji}" aria-label="${label}">${emoji}</button>`).join('')}</div>
        </form>`;
      const session = {
        node, api, familyId, me, messages: [], loaded: false, loading: false, sending: false,
        timer: null, signature: '', pollError: '', sendError: ''
      };
      current = session;
      const input = node.querySelector('textarea');
      const form = node.querySelector('form');
      const toggle = node.querySelector('.family-chat-toggle');
      const picker = node.querySelector('.family-chat-picker');
      toggle.addEventListener('click', () => {
        picker.hidden = !picker.hidden;
        toggle.setAttribute('aria-expanded', String(!picker.hidden));
      });
      picker.addEventListener('click', (event) => {
        const button = event.target.closest('[data-chat-emoji]');
        if (!button) return;
        const emoji = button.dataset.chatEmoji;
        if (input.value.length - (input.selectionEnd - input.selectionStart) + emoji.length > input.maxLength) {
          session.sendError = '메시지는 1,000자까지 입력할 수 있어요.';
          updateStatus(session);
          return;
        }
        input.setRangeText(emoji, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      });
      input.addEventListener('input', () => {
        session.sendError = '';
        updateStatus(session);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          if (!session.sending && input.value.trim()) form.requestSubmit();
        }
      });
      node.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || picker.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        picker.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        send(session);
      });
      node.querySelector('.family-chat-retry').addEventListener('click', () => refresh(session));
    }
    slot.replaceWith(current.node);
    if (!current.timer && !current.loading) refresh(current);
  }

  function updateStatus(session) {
    const status = session.node.querySelector('.family-chat-status');
    const hasError = Boolean(session.sendError || session.pollError);
    const text = session.sendError || session.pollError
      || (session.sending ? '보내는 중…' : session.loaded ? '새 메시지를 자동으로 확인해요.' : '대화를 불러오는 중…');
    status.classList.toggle('is-error', hasError);
    status.setAttribute('role', hasError ? 'alert' : 'status');
    if (status.textContent !== text) status.textContent = text;
    session.node.querySelector('.family-chat-retry').hidden = !session.pollError;
    const input = session.node.querySelector('textarea');
    const button = session.node.querySelector('[type="submit"]');
    button.disabled = session.sending || !input.value.trim();
    button.textContent = session.sending ? '보내는 중…' : '보내기';
    session.node.querySelector('form').setAttribute('aria-busy', String(session.sending));
    session.node.querySelector('.family-chat-count').textContent = `${input.value.length.toLocaleString('ko-KR')} / 1,000자`;
  }

  function renderMessages(session) {
    const signature = JSON.stringify(session.messages);
    if (signature === session.signature) return;
    session.signature = signature;
    const log = session.node.querySelector('.family-chat-log');
    const atBottom = !session.loaded || log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const scrollTop = log.scrollTop;
    const fragment = document.createDocumentFragment();
    if (!session.messages.length) {
      const empty = document.createElement('p');
      empty.className = 'family-chat-empty';
      empty.textContent = '아직 대화가 없어요. 첫 인사를 남겨 보세요!';
      fragment.append(empty);
    }
    for (const message of session.messages) {
      const item = document.createElement('article');
      item.className = `family-chat-message${message.senderId === session.me ? ' is-mine' : ''}`;
      const name = document.createElement('b');
      name.textContent = message.senderId === session.me ? '나' : message.senderName;
      const text = document.createElement('div');
      text.className = 'family-chat-text';
      text.textContent = message.text;
      const time = document.createElement('time');
      time.dateTime = message.createdAt;
      time.textContent = new Date(message.createdAt).toLocaleString('ko-KR', {
        month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
      });
      item.append(name, text, time);
      fragment.append(item);
    }
    log.replaceChildren(fragment);
    log.scrollTop = atBottom ? log.scrollHeight : scrollTop;
  }

  function schedule(session) {
    clearTimeout(session.timer);
    if (current !== session) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      if (document.visibilityState === 'visible' && session.node.closest('.view.active')) refresh(session);
      else schedule(session);
    }, 5000);
  }

  async function refresh(session) {
    if (current !== session || session.loading) return;
    clearTimeout(session.timer);
    session.timer = null;
    session.loading = true;
    const previousMessages = session.messages;
    updateStatus(session);
    try {
      const result = await session.api('messages', { method: 'GET' });
      if (current !== session) return;
      // 이전 조회 도중 전송이 끝난 메시지는 유지한다.
      const addedWhileLoading = session.messages.filter((message) => !previousMessages.some((old) => old.id === message.id));
      const messages = new Map(result.messages.map((message) => [message.id, message]));
      for (const message of addedWhileLoading) messages.set(message.id, message);
      session.messages = [...messages.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(-200);
      renderMessages(session);
      session.loaded = true;
      session.pollError = '';
    } catch (error) {
      if (current === session) session.pollError = `대화를 갱신하지 못했어요. ${error.message}`;
    } finally {
      session.loading = false;
      if (current === session) {
        updateStatus(session);
        schedule(session);
      }
    }
  }

  async function send(session) {
    if (current !== session || session.sending) return;
    const input = session.node.querySelector('textarea');
    const text = input.value;
    if (!text.trim()) {
      session.sendError = '메시지를 입력해 주세요.';
      updateStatus(session);
      input.focus();
      return;
    }
    session.sending = true;
    session.sendError = '';
    updateStatus(session);
    try {
      const { message } = await session.api('message', { body: { text } });
      if (current !== session) return;
      session.messages = [...session.messages.filter((item) => item.id !== message.id), message]
        .sort((a, b) => a.id.localeCompare(b.id)).slice(-200);
      renderMessages(session);
      if (input.value === text) input.value = '';
      const log = session.node.querySelector('.family-chat-log');
      log.scrollTop = log.scrollHeight;
    } catch (error) {
      if (current === session) session.sendError = `메시지를 보내지 못했어요. ${error.message}`;
    } finally {
      session.sending = false;
      if (current === session) {
        updateStatus(session);
      }
    }
  }

  window.MapDuleFamilyChat = { mount, dispose };
})();

// MapDule 가족 공유 기능
// - 초대 코드로 가족 그룹 참여, 가족 공유 일정
// - '출발' 버튼을 누른 동안에만 위치를 공유하고, 도착하면 자동으로 공유를 끝낸다
// - 카카오 지도에 가족 구성원의 지나온 길, 현재 위치, 목적지를 표시한다
// app.js 다음에 불러오며 app.js의 전역 함수(showToast, escapeHtml, showView 등)를 사용한다.
(() => {
  const CREDENTIAL_KEY = 'mapdule-family-credential';
  const STATE_CACHE_KEY = 'mapdule-family-state';
  const ACTIVE_TRIP_KEY = 'mapdule-active-trip';
  const ACTIVITY_KEY = 'mapdule-family-activity';
  const COMPLETED_KEY = 'mapdule-family-completed';
  const GEOCODE_CACHE_KEY = 'mapdule-geocode-cache';
  const POLL_INTERVAL_MS = 60000;
  const SEND_INTERVAL_MS = 20000;
  const HEARTBEAT_MS = 60000;
  const MAX_TRACKING_ACCURACY_METERS = 100;
  const MAX_LOCATION_SPEED_METERS_PER_SECOND = 60;
  const MIN_MOVE_METERS = 25;
  const STALE_LOCATION_MS = 5 * 60 * 1000;
  // [처음 10km 속도, 그 이후 속도] — 시내 구간은 느리고 장거리는 고속버스·고속도로 속도에 가깝다.
  const SPEED_KMH = { walk: [4.5, 4.5], transit: [20, 70], car: [25, 85] };
  const MODE_LABELS = { walk: '도보', transit: '대중교통', car: '자동차' };
  const MODE_ICONS = { walk: 'directions_walk', transit: 'directions_subway', car: 'directions_car' };
  const ACTIVITY_ICONS = { departed: 'near_me', arrived: 'where_to_vote', completed: 'task_alt', dayDone: 'celebration' };

  let credential = readText(CREDENTIAL_KEY);
  let state = credential ? readJson(STATE_CACHE_KEY, null) : null;
  let serverStatus = null;
  let pollTimer = null;
  let refreshing = null;
  let tracking = null;
  let familyMap = null;
  let familyMapContainer = null;
  let familyMapOverlays = [];
  let dayMapOverlays = [];
  let focusedMemberId = null;
  let mapFittedOnce = false;
  let busy = false;
  const pendingJoinCode = new URLSearchParams(location.search).get('join')?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';

  function readText(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch {
      // 저장 공간을 쓸 수 없어도 화면은 계속 동작한다.
    }
  }

  // ---------- 공통 계산 ----------

  function distanceMeters(first, second) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const dLat = toRadians(second.lat - first.lat);
    const dLng = toRadians(second.lng - first.lng);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRadians(first.lat)) * Math.cos(toRadians(second.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }

  function formatClock(value) {
    const date = value instanceof Date ? value : new Date(value);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function formatAgo(value) {
    const minutes = Math.floor((Date.now() - Date.parse(value)) / 60000);
    if (!Number.isFinite(minutes) || minutes < 1) return '방금';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    return `${Math.floor(hours / 24)}일 전`;
  }

  function formatDistance(meters) {
    if (meters < 1000) return `${Math.max(1, Math.round(meters))}m`;
    return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)}km`;
  }

  function eventStart(event) {
    if (!event || event.allDay) return null;
    return new Date(`${event.date}T${event.startTime}:00`);
  }

  function eventEnd(event) {
    if (!event || event.allDay) return null;
    return new Date(`${event.date}T${event.endTime}:00`);
  }

  // 직선거리에 우회 계수를 곱한 대략적인 예상 시간. 실제 길찾기 API가 아니므로 화면에 '약'으로 표시한다.
  function estimateTrip(trip) {
    const last = trip.points?.at(-1);
    if (!last || !trip.destination) return null;
    const meters = distanceMeters(last, trip.destination);
    const [citySpeed, longSpeed] = SPEED_KMH[trip.mode] || SPEED_KMH.transit;
    const km = meters / 1000;
    const hours = Math.min(km, 10) * 1.3 / citySpeed + Math.max(km - 10, 0) * 1.15 / longSpeed;
    const minutes = Math.max(1, Math.round(hours * 60 + (trip.mode === 'transit' && meters > 1500 ? 5 : 0)));
    const arrival = new Date(Date.now() + minutes * 60000);
    const linkedEvent = trip.eventId ? familyEvents().find((event) => event.id === trip.eventId) : null;
    const start = eventStart(linkedEvent);
    const lateMinutes = start ? Math.round((arrival - start) / 60000) : 0;
    return { minutes, arrival, meters, lateMinutes: lateMinutes > 0 ? lateMinutes : 0 };
  }

  // ---------- 서버 통신 ----------

  async function api(action, { method = 'POST', body, query } = {}) {
    const search = query ? `?${new URLSearchParams(query)}` : '';
    let response;
    try {
      response = await fetch(`/api/family/${action}${search}`, {
        method,
        headers: {
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(credential ? { 'x-mapdule-member': credential } : {})
        },
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined
      });
    } catch {
      throw Object.assign(new Error('인터넷 연결을 확인해 주세요.'), { network: true });
    }
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (response.status === 401 && data.code === 'NOT_MEMBER') {
      disconnect(false);
      showToast('가족 연결이 끊어졌어요. 초대 코드로 다시 참여해 주세요.', 'info');
    }
    if (!response.ok) {
      throw Object.assign(new Error(data.error || '가족 서버에 연결하지 못했어요.'), { status: response.status, code: data.code });
    }
    return data;
  }

  async function checkServer() {
    try {
      const response = await fetch('/api/family/status');
      serverStatus = response.ok ? await response.json() : { available: false };
    } catch {
      serverStatus = { available: false, offline: true };
    }
    renderFamilyView();
  }

  function isJoined() {
    return Boolean(credential && state?.family);
  }

  function me() {
    return isJoined() ? state.me : null;
  }

  function members() {
    return isJoined() ? state.members || [] : [];
  }

  function memberById(id) {
    return members().find((member) => member.id === id) || null;
  }

  function familyEvents() {
    if (!isJoined() || !Array.isArray(state.events)) return [];
    return state.events.map((event) => ({ ...event, calendarId: 'family', category: '가족', source: 'family' }));
  }

  function trips() {
    return isJoined() ? state.trips || [] : [];
  }

  function myTrip() {
    return trips().find((trip) => trip.memberId === me()) || null;
  }

  function saveCredential(value) {
    credential = value;
    writeJson(CREDENTIAL_KEY, value || null);
  }

  function disconnect(callServer = true) {
    window.MapDuleFamilyChat?.dispose();
    const previous = credential;
    stopTracking();
    saveCredential('');
    state = null;
    writeJson(STATE_CACHE_KEY, null);
    writeJson(ACTIVE_TRIP_KEY, null);
    writeJson(ACTIVITY_KEY, null);
    writeJson(COMPLETED_KEY, null);
    if (callServer && previous) {
      fetch('/api/family/leave', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mapdule-member': previous }, body: '{}' }).catch(() => {});
    }
    afterStateChange(true);
  }

  // ---------- 상태 갱신과 알림 ----------

  function recordActivity(entries) {
    if (!entries.length) return;
    const activity = [...entries, ...readJson(ACTIVITY_KEY, [])].slice(0, 30);
    writeJson(ACTIVITY_KEY, activity);
    for (const entry of entries) {
      showToast(entry.text, entry.type === 'departed' ? 'info' : 'success');
      if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        try {
          new Notification('MapDule 가족', { body: entry.text, tag: `${entry.memberId}-${entry.type}` });
        } catch {
          // 일부 모바일 브라우저는 페이지에서 직접 알림을 만들 수 없다.
        }
      }
    }
  }

  function detectTripChanges(previousTrips, nextTrips, nextMembers) {
    if (!previousTrips) return [];
    const before = new Map(previousTrips.map((trip) => [trip.memberId, trip]));
    const entries = [];
    for (const trip of nextTrips) {
      if (trip.memberId === state?.me) continue;
      const name = nextMembers.find((member) => member.id === trip.memberId)?.name || '가족';
      const previous = before.get(trip.memberId);
      const place = trip.destination?.name && trip.destination.name !== trip.title ? ` → ${trip.destination.name}` : '';
      if ((!previous || previous.id !== trip.id) && trip.status === 'moving') {
        entries.push({ type: 'departed', memberId: trip.memberId, at: trip.startedAt, text: `${name}님이 출발했어요 · ${trip.title}${place}` });
      }
      if (trip.status === 'arrived' && (!previous || previous.id !== trip.id || previous.status !== 'arrived')) {
        entries.push({ type: 'arrived', memberId: trip.memberId, at: trip.endedAt || trip.updatedAt, text: `${name}님이 도착했어요 · ${trip.destination?.name || trip.title}` });
      }
    }
    return entries;
  }

  function eventProgress(event) {
    if (event.source !== 'family') return [];
    const ids = event.participants?.length ? event.participants : Object.keys(event.arrivals || {});
    const end = eventEnd(event);
    const now = new Date();
    return ids.map((id) => {
      const member = memberById(id);
      if (!member) return null;
      const arrivedAt = event.arrivals?.[id] || null;
      const trip = trips().find((item) => item.memberId === id && item.eventId === event.id);
      let status = 'waiting';
      if (arrivedAt && end && now >= end) status = 'done';
      else if (arrivedAt) status = 'arrived';
      else if (trip?.status === 'moving') status = 'moving';
      else if (end && now >= end) status = 'nodata';
      return { member, status, arrivedAt };
    }).filter(Boolean);
  }

  function checkCompletions() {
    if (!isJoined()) return;
    const saved = readJson(COMPLETED_KEY, []);
    const notified = new Set(Array.isArray(saved) ? saved : []);
    const today = localDateString(new Date());
    const oldest = Date.now() - 12 * 60 * 60 * 1000;
    const finished = [];
    for (const event of familyEvents()) {
      const end = eventEnd(event);
      if (!end || end.getTime() < oldest || end > new Date()) continue;
      for (const progress of eventProgress(event)) {
        const key = `${event.id}:${progress.member.id}`;
        if (progress.status !== 'done' || progress.member.id === me() || notified.has(key)) continue;
        notified.add(key);
        finished.push({
          type: 'completed',
          memberId: progress.member.id,
          at: end.toISOString(),
          text: `${progress.member.name}님이 ${event.title} 일정을 마쳤어요 · ${formatClock(progress.arrivedAt)} 도착, ${event.endTime} 끝`
        });
      }
    }
    const dayDone = [];
    const todays = familyEvents().filter((event) => event.date === today && !event.allDay);
    for (const member of members()) {
      const key = `day:${today}:${member.id}`;
      const theirs = todays.filter((event) => event.participants?.includes(member.id));
      if (member.id === me() || !theirs.length || notified.has(key)) continue;
      const allDone = theirs.every((event) => eventProgress(event).find((item) => item.member.id === member.id)?.status === 'done');
      if (!allDone) continue;
      notified.add(key);
      dayDone.push({ type: 'dayDone', memberId: member.id, at: new Date().toISOString(), text: `${member.name}님이 오늘 일정 ${theirs.length}개를 모두 마쳤어요` });
    }
    writeJson(COMPLETED_KEY, [...notified].slice(-300));
    recordActivity([...dayDone, ...finished]);
  }

  async function refresh({ quiet = true } = {}) {
    if (!credential) return null;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const query = state?.eventsRev && Array.isArray(state.events) ? { rev: state.eventsRev } : undefined;
        const next = await api('state', { method: 'GET', query });
        if (!credential) return null;
        const eventsChanged = next.events !== null;
        const changes = detectTripChanges(state?.trips, next.trips, next.members);
        state = { ...next, events: eventsChanged ? next.events : state?.events || [] };
        writeJson(STATE_CACHE_KEY, state);
        recordActivity(changes);
        syncTrackingWithServer();
        checkCompletions();
        afterStateChange(eventsChanged);
        return state;
      } catch (error) {
        if (!quiet) showToast(error.message, 'info');
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function currentViewId() {
    return document.querySelector('.view.active')?.id || 'today';
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!credential) return;
    pollTimer = setTimeout(async () => {
      if (document.visibilityState === 'visible') await refresh();
      schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  function afterStateChange(eventsChanged) {
    if (eventsChanged) {
      if (typeof renderMonthCalendar === 'function') renderMonthCalendar();
      if (typeof renderCalendar === 'function') renderCalendar();
    } else if (typeof renderCalendar === 'function' && currentViewId() === 'day-detail') {
      renderCalendar();
    }
    updateStatusPill();
    renderFamilyView();
    updateDayMap();
    schedulePoll();
  }

  function updateStatusPill() {
    const pill = document.querySelector('.status-pill');
    if (!pill) return;
    if (tracking) {
      pill.className = 'status-pill sharing';
      pill.innerHTML = '<i></i>위치 공유 중';
    } else if (isJoined()) {
      pill.className = 'status-pill';
      pill.innerHTML = `<i></i>${escapeHtml(state.family.name)} ${members().length}명`;
    } else if (pill.classList.contains('sharing')) {
      pill.className = 'status-pill';
      pill.innerHTML = '<i></i>위치 미연결';
    }
  }

  // ---------- 가족 일정 ----------

  async function saveEvent(event) {
    if (!isJoined()) throw new Error('먼저 가족에 참여해 주세요.');
    const payload = { ...event };
    delete payload.calendarId;
    delete payload.category;
    delete payload.source;
    if (!payload.location || (payload.place && payload.place.name !== payload.location)) payload.place = null;
    const { event: saved } = await api('event', { body: { event: payload } });
    state.events = [...(state.events || []).filter((item) => item.id !== saved.id), saved];
    writeJson(STATE_CACHE_KEY, state);
    afterStateChange(true);
    refresh();
    return saved;
  }

  async function deleteEvent(id) {
    await api('event-delete', { body: { id } });
    state.events = (state.events || []).filter((item) => item.id !== id);
    writeJson(STATE_CACHE_KEY, state);
    afterStateChange(true);
    refresh();
  }

  // ---------- 위치(장소) 검색 ----------

  function whenKakaoReady(timeoutMs = 12000) {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (window.kakao?.maps?.LatLng) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(check, 250);
      };
      check();
    });
  }

  async function searchPlaces(query) {
    const text = String(query || '').trim();
    if (!text || !(await whenKakaoReady(6000)) || !window.kakao.maps.services) return [];
    const services = window.kakao.maps.services;
    const placeResults = await new Promise((resolve) => {
      new services.Places().keywordSearch(text, (result, status) => {
        resolve(status === services.Status.OK ? result || [] : []);
      });
    });
    const candidates = placeResults.slice(0, 5).map((result) => ({
      lat: Number(result.y),
      lng: Number(result.x),
      name: result.place_name || text,
      address: result.road_address_name || result.address_name || ''
    })).filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng));
    if (candidates.length) return candidates;
    const addressResults = await new Promise((resolve) => {
      new services.Geocoder().addressSearch(text, (result, status) => {
        resolve(status === services.Status.OK ? result || [] : []);
      });
    });
    return addressResults.slice(0, 5).map((result) => ({
      lat: Number(result.y),
      lng: Number(result.x),
      name: text,
      address: result.road_address?.address_name || result.address?.address_name || text
    })).filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng));
  }

  async function geocode(query) {
    const text = String(query || '').trim();
    if (!text) return null;
    const cache = readJson(GEOCODE_CACHE_KEY, {});
    if (cache[text]) return cache[text];
    const found = (await searchPlaces(text))[0] || null;
    if (found) {
      const keys = Object.keys(cache);
      if (keys.length > 200) delete cache[keys[0]];
      cache[text] = found;
      writeJson(GEOCODE_CACHE_KEY, cache);
    }
    return found;
  }

  // ---------- 출발~도착 위치 공유 ----------

  function getPosition() {
    if (typeof window.requestLocationWithConsent !== 'function') {
      return Promise.reject(new Error('위치 권한 요청을 시작할 수 없습니다. 페이지를 새로고침해 주세요.'));
    }
    return window.requestLocationWithConsent({
      title: '가족에게 이동을 공유할까요?',
      description: '현재 위치를 공유하면 가족이 지도에서 이동 경로와 목적지까지의 거리를 확인할 수 있어요.',
      actionLabel: '위치 공유 시작'
    }).then((position) => {
      const accuracy = position.coords.accuracy;
      if (!Number.isFinite(accuracy) || accuracy > MAX_TRACKING_ACCURACY_METERS) {
        throw new Error(`위치 정확도가 낮아요${Number.isFinite(accuracy) ? ` (약 ${Math.round(accuracy)}m)` : ''}. 위치 신호가 더 좋은 곳에서 다시 시도해 주세요.`);
      }
      return position;
    });
  }

  function toPoint(position) {
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      at: new Date(position.timestamp || Date.now()).toISOString()
    };
  }

  async function requestWakeLock() {
    if (!tracking || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      tracking.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      tracking.wakeLock = null;
    }
  }

  function startWatching(tripId) {
    stopWatching();
    tracking = { tripId, watchId: null, timer: null, pending: [], lastQueued: myTrip()?.points?.at(-1) || null, lastSentAt: Date.now(), sending: false, sendPromise: null, wakeLock: null };
    tracking.timer = setInterval(() => {
      if (!tracking) return;
      const last = tracking.lastQueued;
      if (!tracking.pending.length && last && Date.now() - Date.parse(last.at) >= HEARTBEAT_MS) {
        const heartbeat = { ...last, at: new Date().toISOString() };
        tracking.pending.push(heartbeat);
        tracking.lastQueued = heartbeat;
      }
      if (Date.now() - tracking.lastSentAt >= SEND_INTERVAL_MS) flushPoints();
    }, 5000);
    tracking.watchId = navigator.geolocation.watchPosition((position) => {
      if (!tracking) return;
      const point = toPoint(position);
      if (!Number.isFinite(point.accuracy) || point.accuracy > MAX_TRACKING_ACCURACY_METERS) return;
      const last = tracking.lastQueued;
      const moved = last ? distanceMeters(last, point) : Infinity;
      const elapsed = last ? Date.parse(point.at) - Date.parse(last.at) : Infinity;
      if (last && elapsed <= 0) return;
      if (last && moved > elapsed / 1000 * MAX_LOCATION_SPEED_METERS_PER_SECOND + point.accuracy + (last.accuracy || 0)) return;
      if (moved >= MIN_MOVE_METERS || elapsed >= SEND_INTERVAL_MS) {
        tracking.pending.push(point);
        tracking.pending = tracking.pending.slice(-30);
        tracking.lastQueued = point;
      }
      if (Date.now() - tracking.lastSentAt >= SEND_INTERVAL_MS || tracking.pending.length >= 10) flushPoints();
    }, () => {
      // 일시적인 GPS 오류는 다음 위치를 기다린다.
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    requestWakeLock();
    updateStatusPill();
  }

  function stopWatching() {
    if (!tracking) return;
    if (tracking.watchId !== null) navigator.geolocation.clearWatch(tracking.watchId);
    clearInterval(tracking.timer);
    tracking.wakeLock?.release?.().catch(() => {});
    tracking = null;
    updateStatusPill();
  }

  function stopTracking() {
    stopWatching();
    writeJson(ACTIVE_TRIP_KEY, null);
  }

  function replaceMyTrip(trip) {
    if (!state) return;
    state.trips = [...(state.trips || []).filter((item) => item.memberId !== trip.memberId), trip];
    writeJson(STATE_CACHE_KEY, state);
  }

  function flushPoints() {
    const activeTracking = tracking;
    if (!activeTracking || !activeTracking.pending.length) return Promise.resolve();
    if (activeTracking.sending) return activeTracking.sendPromise;
    activeTracking.sending = true;
    const batch = activeTracking.pending.slice();
    activeTracking.sendPromise = (async () => {
      try {
        const { trip } = await api('trip-point', { body: { tripId: activeTracking.tripId, points: batch } });
        if (tracking !== activeTracking) return;
        activeTracking.pending = activeTracking.pending.slice(batch.length);
        activeTracking.lastSentAt = Date.now();
        replaceMyTrip(trip);
        if (trip.status !== 'moving') {
          stopTracking();
          showToast(`도착했어요! 가족에게 ${trip.destination?.name || '도착'} 소식을 알렸어요.`, 'success');
        }
        afterStateChange(false);
      } catch (error) {
        if (error.code === 'TRIP_NOT_FOUND' && tracking === activeTracking) stopTracking();
        // 네트워크 오류면 모아 둔 위치를 다음에 다시 보낸다.
      } finally {
        activeTracking.sending = false;
        activeTracking.sendPromise = null;
      }
    })();
    return activeTracking.sendPromise;
  }

  // 서버 상태와 이 기기의 추적 상태를 맞춘다 (다른 기기에서 끝냈거나, 새로고침 후 이어서 공유).
  function syncTrackingWithServer() {
    const trip = myTrip();
    const saved = readJson(ACTIVE_TRIP_KEY, null);
    if (tracking && (!trip || trip.id !== tracking.tripId || trip.status !== 'moving')) {
      stopTracking();
      return;
    }
    if (!tracking && trip?.status === 'moving' && saved?.tripId === trip.id && navigator.geolocation) {
      startWatching(trip.id);
    }
  }

  async function startTrip({ eventId = null, title, destination = null, destinationText = '', mode }) {
    if (!isJoined()) {
      showToast('먼저 가족을 만들거나 초대 코드로 참여해 주세요.', 'info');
      showView('family');
      return;
    }
    if (busy) return;
    busy = true;
    renderFamilyView();
    try {
      const profile = readJson('mapdule-profile', {});
      const travelMode = mode || (['walk', 'transit', 'car'].includes(profile.transportMode) ? profile.transportMode : 'transit');
      const [position, place] = await Promise.all([
        getPosition(),
        destination ? Promise.resolve(destination) : geocode(destinationText)
      ]);
      if (myTrip()?.status === 'moving') await endTrip('stopped', { silent: true });
      if (destinationText && !place) showToast('목적지 위치를 찾지 못해 도착 자동 확인 없이 공유해요.', 'info');
      const { trip } = await api('trip-start', {
        body: {
          eventId,
          title: title || destinationText || '이동 중',
          destination: place ? { ...place, name: destinationText || place.name } : null,
          mode: travelMode,
          points: [toPoint(position)]
        }
      });
      replaceMyTrip(trip);
      writeJson(ACTIVE_TRIP_KEY, { tripId: trip.id });
      if (trip.status === 'moving') {
        startWatching(trip.id);
        showToast('출발을 알렸어요. 도착할 때까지 가족이 이동 경로를 볼 수 있어요.', 'success');
      } else {
        writeJson(ACTIVE_TRIP_KEY, null);
        showToast('이미 목적지 근처예요. 도착으로 표시했어요.', 'success');
      }
      mapFittedOnce = false;
      afterStateChange(false);
    } catch (error) {
      if (error.code !== 'LOCATION_CANCELLED') showToast(error.message || '출발을 알리지 못했어요.', 'info');
    } finally {
      busy = false;
      renderFamilyView();
    }
  }

  async function endTrip(reason, { silent = false } = {}) {
    const trip = myTrip();
    if (!trip) return;
    const activeTracking = tracking;
    if (activeTracking?.sending) await activeTracking.sendPromise;
    if (tracking === activeTracking && activeTracking) await flushPoints();
    try {
      const { trip: ended } = await api('trip-end', { body: { tripId: trip.id, reason } });
      if (ended.status === 'stopped') {
        state.trips = (state.trips || []).filter((item) => item.memberId !== ended.memberId);
        writeJson(STATE_CACHE_KEY, state);
      } else {
        replaceMyTrip(ended);
      }
      stopTracking();
      if (!silent) showToast(reason === 'arrived' ? '도착을 가족에게 알렸어요.' : '위치 공유를 멈췄어요. 지나온 경로도 지웠어요.', 'success');
      afterStateChange(false);
    } catch (error) {
      if (!silent) showToast(error.message, 'info');
    }
  }

  async function startTripForEvent(eventId) {
    const event = typeof allEvents === 'function' ? allEvents().find((item) => item.id === eventId) : null;
    if (!event) return;
    const destination = event.place || (event.location ? await geocode(event.location) : null);
    await startTrip({
      eventId: event.source === 'family' ? event.id : null,
      title: event.title,
      destination: destination ? { ...destination, name: event.location || destination.name } : null,
      destinationText: destination ? '' : event.location
    });
  }

  function canDepartFor(event) {
    if (!isJoined() || !event || event.allDay || !event.location) return false;
    if (event.date !== localDateString(new Date())) return false;
    if (event.source === 'family' && event.participants?.length && !event.participants.includes(me())) return false;
    const end = eventEnd(event);
    if (end && end < new Date()) return false;
    const trip = myTrip();
    return !(trip?.status === 'moving' && trip.eventId && trip.eventId === event.id);
  }

  function describeTrip(trip) {
    const member = memberById(trip.memberId);
    const name = trip.memberId === me() ? '나' : member?.name || '가족';
    if (trip.status === 'arrived') {
      return { tone: 'arrived', icon: 'where_to_vote', text: `${name} · ${formatClock(trip.endedAt || trip.updatedAt)} 도착` };
    }
    if (trip.status !== 'moving') return null;
    const estimate = estimateTrip(trip);
    const last = trip.points?.at(-1);
    const stale = last && Date.now() - Date.parse(last.at) > STALE_LOCATION_MS;
    let text = `${name} · 이동 중`;
    if (estimate) text += ` · 약 ${estimate.minutes}분 남음 (${formatClock(estimate.arrival)} 도착 예상)`;
    if (estimate?.meters <= 1000) text += ` · 목적지까지 약 ${formatDistance(estimate.meters)}`;
    if (stale) text += ` · 위치 ${formatAgo(last.at)}`;
    return {
      tone: estimate?.lateMinutes ? 'late' : stale ? 'stale' : 'moving',
      icon: MODE_ICONS[trip.mode] || 'near_me',
      text: estimate?.lateMinutes ? `${text} · ${estimate.lateMinutes}분 늦을 수 있어요` : text
    };
  }

  // 일정 카드(타임라인)에 붙일 참여자와 이동 상태
  function eventExtrasHtml(event) {
    if (!isJoined()) return '';
    let html = '';
    if (event.source === 'family' && event.participants?.length) {
      html += `<div class="participant-row">${event.participants.map((id) => {
        const member = memberById(id);
        if (!member) return '';
        return `<span class="participant-pill" style="--member-color:${member.color}">${escapeHtml(member.name)}${id === me() ? ' (나)' : ''}</span>`;
      }).join('')}</div>`;
    }
    for (const progress of eventProgress(event)) {
      const who = progress.member.id === me() ? '나' : progress.member.name;
      if (progress.status === 'done') {
        html += `<p class="trip-status done"><span class="material-symbols-rounded">task_alt</span>${escapeHtml(`${who} · ${formatClock(progress.arrivedAt)} 도착, ${event.endTime} 일정 완료`)}</p>`;
      } else if (progress.status === 'arrived') {
        html += `<p class="trip-status arrived"><span class="material-symbols-rounded">where_to_vote</span>${escapeHtml(`${who} · ${formatClock(progress.arrivedAt)} 도착 · ${event.endTime}까지 일정 진행 중`)}</p>`;
      }
    }
    const related = trips().filter((trip) => (trip.eventId && trip.eventId === event.id)
      || (trip.memberId === me() && !trip.eventId && trip.title === event.title && trip.startedAt?.slice(0, 10) === event.date));
    for (const trip of related) {
      if (trip.status === 'arrived' && event.arrivals?.[trip.memberId]) continue;
      const info = describeTrip(trip);
      if (info) html += `<p class="trip-status ${info.tone}"><span class="material-symbols-rounded">${info.icon}</span>${escapeHtml(info.text)}</p>`;
    }
    const mine = myTrip();
    if (mine?.status === 'moving' && related.includes(mine)) {
      html += '<div class="trip-actions"><button type="button" class="trip-arrive-button" data-trip-arrive>도착했어요</button><button type="button" class="trip-stop-button" data-trip-stop>공유 멈추기</button></div>';
    } else if (canDepartFor(event)) {
      html += `<button type="button" class="depart-button" data-depart-event="${escapeHtml(event.id)}"><span class="material-symbols-rounded">near_me</span>출발 알리기</button>`;
    }
    return html;
  }

  // ---------- 지도 ----------

  function clearOverlays(list) {
    list.forEach((overlay) => overlay.setMap(null));
    list.length = 0;
  }

  function latLng(point) {
    return new window.kakao.maps.LatLng(point.lat, point.lng);
  }

  function drawTrips(map, overlays, tripList, bounds) {
    const maps = window.kakao.maps;
    for (const trip of tripList) {
      const member = memberById(trip.memberId);
      const color = member?.color || '#4f46e5';
      const path = (trip.points || []).map(latLng);
      const hasDestination = Number.isFinite(trip.destination?.lat) && Number.isFinite(trip.destination?.lng);
      if (path.length > 1) {
        const line = new maps.Polyline({ path, strokeWeight: 5, strokeColor: color, strokeOpacity: 0.85, strokeStyle: 'solid' });
        line.setMap(map);
        overlays.push(line);
      }
      const last = trip.points?.at(-1);
      if (last && trip.status === 'moving' && Number.isFinite(last.accuracy)) {
        const accuracyCircle = new maps.Circle({
          center: latLng(last),
          radius: Math.max(20, Math.min(last.accuracy, MAX_TRACKING_ACCURACY_METERS)),
          strokeWeight: 1,
          strokeColor: color,
          strokeOpacity: 0.55,
          fillColor: color,
          fillOpacity: 0.12
        });
        accuracyCircle.setMap(map);
        overlays.push(accuracyCircle);
      }
      if (hasDestination) {
        if (trip.status === 'moving' && last) {
          const rest = new maps.Polyline({ path: [latLng(last), latLng(trip.destination)], strokeWeight: 3, strokeColor: color, strokeOpacity: 0.55, strokeStyle: 'shortdash' });
          rest.setMap(map);
          overlays.push(rest);
        }
        const flag = new maps.CustomOverlay({
          position: latLng(trip.destination),
          yAnchor: 1.15,
          content: `<div class="map-destination" style="--member-color:${color}"><span class="material-symbols-rounded">flag</span>${escapeHtml(trip.destination.name || '목적지')}</div>`
        });
        flag.setMap(map);
        overlays.push(flag);
        bounds?.extend(latLng(trip.destination));
      }
      if (last && trip.status !== 'stopped') {
        const label = trip.memberId === me() ? '나' : (member?.name || '가족').slice(0, 2);
        const pin = new maps.CustomOverlay({
          position: latLng(last),
          yAnchor: 0.5,
          zIndex: 5,
          content: `<div class="map-member-pin ${trip.status}" style="--member-color:${color}" title="${escapeHtml(member?.name || '')}">${escapeHtml(label)}</div>`
        });
        pin.setMap(map);
        overlays.push(pin);
      }
      path.forEach((point) => bounds?.extend(point));
    }
  }

  function fitBounds(map, bounds, fallbackLevel = 6) {
    if (bounds.isEmpty()) return;
    const southWest = bounds.getSouthWest();
    const northEast = bounds.getNorthEast();
    if (southWest.equals?.(northEast) || (southWest.getLat() === northEast.getLat() && southWest.getLng() === northEast.getLng())) {
      map.setLevel(Math.min(map.getLevel(), 4));
      map.setCenter(southWest);
      return;
    }
    map.setBounds(bounds, 48, 32, 48, 32);
    if (map.getLevel() < 3) map.setLevel(3);
    if (fallbackLevel && map.getLevel() > 11) map.setLevel(11);
  }

  async function renderFamilyMap() {
    const container = document.querySelector('#family-map');
    if (!container || !isJoined()) return;
    const hint = document.querySelector('.family-map-hint');
    if (!(await whenKakaoReady(15000))) {
      if (hint) hint.textContent = '지도를 불러오지 못했어요. 카카오 지도 설정을 확인해 주세요.';
      return;
    }
    if (!document.body.contains(container)) return;
    if (!familyMap || familyMapContainer !== container) {
      familyMap = new window.kakao.maps.Map(container, { center: new window.kakao.maps.LatLng(36.5, 127.8), level: 12 });
      familyMapContainer = container;
      familyMapOverlays = [];
      mapFittedOnce = false;
    }
    familyMap.relayout();
    clearOverlays(familyMapOverlays);
    const visible = trips().filter((trip) => trip.status !== 'stopped');
    const bounds = new window.kakao.maps.LatLngBounds();
    drawTrips(familyMap, familyMapOverlays, visible, bounds);
    if (hint) {
      hint.textContent = visible.length ? '' : '지금 이동 중인 가족이 없어요. 출발하면 여기에 경로가 표시돼요.';
      hint.hidden = Boolean(visible.length);
    }
    const focused = focusedMemberId ? visible.find((trip) => trip.memberId === focusedMemberId)?.points?.at(-1) : null;
    if (focused) {
      familyMap.setLevel(4);
      familyMap.panTo(latLng(focused));
    } else if (!mapFittedOnce && !bounds.isEmpty()) {
      fitBounds(familyMap, bounds);
      mapFittedOnce = true;
    }
  }

  // 날짜 상세 화면 지도: 그날 일정 장소를 번호 순서대로 잇고, 오늘이면 가족 이동도 함께 표시
  let dayMapRun = 0;
  async function updateDayMap() {
    if (currentViewId() !== 'day-detail' || typeof allEvents !== 'function') return;
    const run = ++dayMapRun;
    if (!(await whenKakaoReady(15000)) || typeof kakaoMap === 'undefined' || !kakaoMap || run !== dayMapRun) return;
    kakaoMap.relayout();
    const iso = localDateString(selectedDate);
    const dayEvents = allEvents()
      .filter((event) => event.date === iso && event.location && (typeof visibleCalendars === 'undefined' || visibleCalendars.has(calendarIdForEvent(event))))
      .sort((first, second) => (first.allDay ? '' : first.startTime).localeCompare(second.allDay ? '' : second.startTime));
    const places = [];
    for (const event of dayEvents) {
      const place = event.place || await geocode(event.location);
      if (run !== dayMapRun) return;
      if (place) places.push({ event, place });
    }
    clearOverlays(dayMapOverlays);
    const maps = window.kakao.maps;
    const bounds = new maps.LatLngBounds();
    places.forEach(({ event, place }, index) => {
      const marker = new maps.CustomOverlay({
        position: latLng(place),
        yAnchor: 1.1,
        content: `<div class="map-stop"><b>${index + 1}</b>${escapeHtml(event.title)}</div>`
      });
      marker.setMap(kakaoMap);
      dayMapOverlays.push(marker);
      bounds.extend(latLng(place));
    });
    if (places.length > 1) {
      const route = new maps.Polyline({ path: places.map(({ place }) => latLng(place)), strokeWeight: 4, strokeColor: '#4f46e5', strokeOpacity: 0.7, strokeStyle: 'shortdash' });
      route.setMap(kakaoMap);
      dayMapOverlays.push(route);
    }
    if (iso === localDateString(new Date())) {
      drawTrips(kakaoMap, dayMapOverlays, trips().filter((trip) => trip.status === 'moving'), bounds);
    }
    const label = document.querySelector('.map-top > span');
    if (label) {
      const skipped = dayEvents.length - places.length;
      label.innerHTML = `<i></i>${places.length ? `일정 장소 ${places.length}곳${skipped ? ` · ${skipped}곳은 위치를 못 찾음` : ''}` : dayEvents.length ? '장소 위치를 찾지 못했어요' : '장소가 있는 일정이 없어요'}`;
    }
    if (!bounds.isEmpty()) fitBounds(kakaoMap, bounds);
  }

  // ---------- 가족 화면 ----------

  function familySection() {
    return document.querySelector('#family');
  }

  function heading(title, subtitle) {
    return `<div class="section-heading"><div class="section-icon family-bg"><span class="material-symbols-rounded">family_restroom</span></div><div><h1 id="family-title">${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></div>`;
  }

  function renderOnboarding(section) {
    const profile = readJson('mapdule-profile', {});
    const name = escapeHtml(profile.name || '');
    const unavailable = serverStatus && !serverStatus.available;
    section.innerHTML = `
      ${heading('우리 가족', '가족 일정을 함께 보고, 이동할 때 위치를 공유해요')}
      ${unavailable ? `<div class="family-notice panel"><span class="material-symbols-rounded">cloud_off</span><div><b>${serverStatus.offline ? '서버에 연결할 수 없어요' : '가족 공유 서버가 아직 준비되지 않았어요'}</b><small>${serverStatus.offline ? '인터넷 연결을 확인해 주세요.' : '관리자가 저장소 연결 설정(DEPLOYMENT.md)을 마치면 사용할 수 있어요.'}</small></div></div>` : ''}
      <form class="family-card panel" id="family-join-form">
        <h2><span class="material-symbols-rounded">group_add</span>초대 코드로 참여하기</h2>
        <p>새 초대 코드는 6자리예요. 기존 10자리 코드도 사용할 수 있어요.</p>
        <label class="modal-field">내 이름<input name="memberName" maxlength="20" value="${name}" placeholder="예: 엄마, 준기" required></label>
        <label class="modal-field">초대 코드<input name="inviteCode" maxlength="10" value="${escapeHtml(pendingJoinCode)}" placeholder="예: K7M2QX" autocapitalize="characters" autocomplete="off" required class="invite-input"></label>
        <button class="primary-cta" type="submit" ${busy || unavailable ? 'disabled' : ''}>가족에 참여하기</button>
      </form>
      <form class="family-card panel" id="family-create-form">
        <h2><span class="material-symbols-rounded">home</span>새 가족 만들기</h2>
        <p>가족을 만들면 초대 링크를 보낼 수 있어요.</p>
        <label class="modal-field">가족 이름<input name="familyName" maxlength="30" placeholder="예: 백씨네 가족"></label>
        <label class="modal-field">내 이름<input name="memberName" maxlength="20" value="${name}" placeholder="예: 아빠" required></label>
        <button class="secondary-cta" type="submit" ${busy || unavailable ? 'disabled' : ''}>가족 만들기</button>
      </form>
      <p class="family-privacy"><span class="material-symbols-rounded">lock</span>위치는 '출발 알리기'를 누른 뒤 도착할 때까지만 가족에게 보여요. 언제든 공유를 멈출 수 있어요.</p>
    `;
  }

  function memberStatus(member) {
    const trip = trips().find((item) => item.memberId === member.id);
    const info = trip ? describeTrip(trip) : null;
    if (info) return info;
    return { tone: 'idle', icon: 'schedule', text: `대기 중 · ${formatAgo(member.lastSeenAt)} 접속` };
  }

  function todaysDepartures() {
    if (typeof allEvents !== 'function') return [];
    return allEvents()
      .filter((event) => canDepartFor(event))
      .sort((first, second) => first.startTime.localeCompare(second.startTime))
      .slice(0, 4);
  }

  const PROGRESS_LABELS = { waiting: '예정', moving: '이동 중', arrived: '도착', done: '완료', nodata: '기록 없음' };

  function todayBoardHtml() {
    const today = localDateString(new Date());
    const list = familyEvents()
      .filter((event) => event.date === today)
      .sort((first, second) => (first.allDay ? '' : first.startTime).localeCompare(second.allDay ? '' : second.startTime));
    if (!list.length) return '';
    const tracked = list.filter((event) => eventProgress(event).length);
    const done = tracked.filter((event) => eventProgress(event).every((item) => item.status === 'done')).length;
    const allDone = tracked.length > 0 && done === tracked.length;
    const summary = allDone ? '오늘 가족 일정을 모두 마쳤어요' : `오늘 가족 일정 ${list.length}개${tracked.length ? ` · ${done}개 완료` : ''}`;
    return `<section class="family-today panel ${allDone ? 'all-done' : ''}">
      <h2><span class="material-symbols-rounded">${allDone ? 'celebration' : 'today'}</span>${escapeHtml(summary)}</h2>
      ${list.map((event) => `<div class="today-row">
        <time>${event.allDay ? '종일' : escapeHtml(event.startTime)}</time>
        <div><b>${escapeHtml(event.title)}</b>${event.location ? `<small>${escapeHtml(event.location)}</small>` : ''}
          <div class="progress-chips">${eventProgress(event).map((item) => `<span class="progress-chip ${item.status}" style="--member-color:${item.member.color}">${escapeHtml(item.member.id === me() ? '나' : item.member.name)} · ${item.status === 'arrived' || item.status === 'done' ? `${formatClock(item.arrivedAt)} 도착${item.status === 'done' ? ' · 완료' : ''}` : PROGRESS_LABELS[item.status]}</span>`).join('')}</div>
        </div>
      </div>`).join('')}
    </section>`;
  }

  function renderJoined(section) {
    const chatFocus = section.querySelector('.family-chat :focus');
    const mine = myTrip();
    const sharing = mine?.status === 'moving';
    const estimate = sharing ? estimateTrip(mine) : null;
    const locationAccuracy = Number(mine?.points?.at(-1)?.accuracy);
    const accuracyLabel = Number.isFinite(locationAccuracy) ? `위치 정확도 ±${Math.round(locationAccuracy)}m` : '위치 정확도 확인 중';
    const departures = todaysDepartures();
    const activity = readJson(ACTIVITY_KEY, []).slice(0, 6);
    const canNotify = 'Notification' in window && Notification.permission === 'default';
    const mapCard = section.querySelector('.family-map-card');
    section.dataset.mode = 'joined';
    section.innerHTML = `
      ${heading(state.family.name, `가족 ${members().length}명 · 서로의 일정과 이동을 함께 봐요`)}
      ${todayBoardHtml()}
      <section class="family-share panel ${sharing ? 'is-sharing' : ''}">
        ${sharing ? `
          <div class="share-live"><span class="live-dot"></span><b>내 위치 공유 중</b><small>${escapeHtml(mine.title)}${mine.destination ? ` → ${escapeHtml(mine.destination.name)}` : ''}</small></div>
          ${estimate ? `<p class="share-eta">약 <b>${estimate.minutes}분</b> 남음 · ${formatClock(estimate.arrival)} 도착 예상${estimate.meters <= 1000 ? ` · 목적지까지 약 ${formatDistance(estimate.meters)}` : ''}${estimate.lateMinutes ? ` <em>${estimate.lateMinutes}분 늦을 수 있어요</em>` : ''}</p>` : '<p class="share-eta">목적지가 없어 도착은 직접 눌러 주세요.</p>'}
          <p class="share-note">${accuracyLabel} · ${tracking ? '화면을 켜 두면 위치가 더 정확하게 전달돼요.' : '이 기기에서 위치를 보내고 있지 않아요. 아래 버튼으로 다시 시작하세요.'}</p>
          <div class="trip-actions">
            ${tracking ? '' : '<button type="button" class="trip-resume-button" data-trip-resume>이 기기에서 계속 공유</button>'}
            <button type="button" class="trip-arrive-button" data-trip-arrive>도착했어요</button>
            <button type="button" class="trip-stop-button" data-trip-stop>공유 멈추기</button>
          </div>` : `
          <h2><span class="material-symbols-rounded">near_me</span>나갈 때 '출발 알리기'</h2>
          <p>도착할 때까지 가족이 내 이동 경로와 도착 예상 시간을 볼 수 있어요.</p>
          ${departures.length ? `<div class="departure-list">${departures.map((event) => `
            <button type="button" class="departure-item" data-depart-event="${escapeHtml(event.id)}" ${busy ? 'disabled' : ''}>
              <time>${escapeHtml(event.startTime)}</time><span><b>${escapeHtml(event.title)}</b><small>${escapeHtml(event.location)}</small></span><em>출발</em>
            </button>`).join('')}</div>` : ''}
          <button type="button" class="secondary-cta" data-free-depart ${busy ? 'disabled' : ''}><span class="material-symbols-rounded">add_location_alt</span>${departures.length ? '다른 곳으로 출발' : '지금 출발 알리기'}</button>`}
      </section>
      <div class="family-chat-slot"></div>
      <div class="family-map-slot"></div>
      <section class="family-members panel" aria-label="가족 구성원">
        <h2>가족 구성원</h2>
        ${members().map((member) => {
          const status = memberStatus(member);
          return `<button type="button" class="member-row ${focusedMemberId === member.id ? 'focused' : ''}" data-focus-member="${escapeHtml(member.id)}">
            <span class="member-avatar" style="--member-color:${member.color}">${escapeHtml(member.name.slice(0, 1))}</span>
            <span class="member-info"><b>${escapeHtml(member.name)}${member.id === me() ? ' <small>나</small>' : ''}</b><small class="member-status ${status.tone}"><span class="material-symbols-rounded">${status.icon}</span>${escapeHtml(status.text.replace(/^[^·]+· /, ''))}</small></span>
          </button>`;
        }).join('')}
      </section>
      <section class="family-invite panel">
        <div><span>초대 코드</span><strong>${escapeHtml(state.family.inviteCode)}</strong></div>
        <button type="button" class="secondary-cta" data-share-invite><span class="material-symbols-rounded">share</span>초대 링크 보내기</button>
      </section>
      ${activity.length ? `<section class="family-activity panel"><h2>최근 소식</h2>${activity.map((entry) => `<p><span class="material-symbols-rounded">${ACTIVITY_ICONS[entry.type] || 'near_me'}</span>${escapeHtml(entry.text)}<small>${formatAgo(entry.at)}</small></p>`).join('')}</section>` : ''}
      <div class="family-footer">
        ${canNotify ? '<button type="button" class="link-button" data-enable-notifications><span class="material-symbols-rounded">notifications_active</span>출발·도착 알림 받기</button>' : ''}
        <button type="button" class="link-button danger" data-leave-family><span class="material-symbols-rounded">logout</span>가족에서 나가기</button>
      </div>
    `;
    window.MapDuleFamilyChat?.mount(section.querySelector('.family-chat-slot'), { api, familyId: state.family.id, me: me() });
    if (chatFocus?.isConnected) chatFocus.focus({ preventScroll: true });
    const slot = section.querySelector('.family-map-slot');
    if (mapCard) {
      slot.replaceWith(mapCard);
    } else {
      slot.outerHTML = '<section class="family-map-card panel" aria-label="가족 이동 지도"><div id="family-map" class="family-map-canvas"></div><p class="family-map-hint">지도를 불러오는 중이에요.</p></section>';
    }
    renderFamilyMap();
  }

  function renderFamilyView() {
    const section = familySection();
    if (!section || currentViewId() !== 'family') return;
    if (isJoined()) {
      renderJoined(section);
      return;
    }
    const mode = `onboarding-${serverStatus?.available ?? 'unknown'}-${busy}`;
    if (section.dataset.mode === mode) return;
    section.dataset.mode = mode;
    renderOnboarding(section);
  }

  async function submitFamilyForm(form, action) {
    if (!form.reportValidity() || busy) return;
    const data = Object.fromEntries(new FormData(form).entries());
    busy = true;
    form.querySelector('[type="submit"]').disabled = true;
    try {
      const result = await api(action, { body: data });
      saveCredential(result.credential);
      const profile = readJson('mapdule-profile', {});
      if (!profile.name && data.memberName) writeJson('mapdule-profile', { ...profile, name: data.memberName.trim() });
      if (pendingJoinCode) history.replaceState(null, '', location.pathname + location.hash);
      state = null;
      await refresh({ quiet: false });
      showToast(action === 'create' ? '가족을 만들었어요. 초대 링크를 보내 보세요!' : '가족에 참여했어요.', 'success');
    } catch (error) {
      showToast(error.message, 'info');
    } finally {
      busy = false;
      renderFamilyView();
    }
  }

  async function shareInvite() {
    const url = `${location.origin}${location.pathname}?join=${state.family.inviteCode}#family`;
    const text = `MapDule '${state.family.name}'에 초대해요. 링크를 열고 내 이름만 입력하면 돼요. (초대 코드 ${state.family.inviteCode})`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'MapDule 가족 초대', text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      showToast('초대 링크를 복사했어요. 카카오톡에 붙여 넣어 보내 주세요.', 'success');
    } catch (error) {
      if (error?.name !== 'AbortError') showModal('초대 링크', `<p class="invite-link-text">${escapeHtml(url)}</p><p class="modal-note">위 주소를 길게 눌러 복사해 보내 주세요.</p>`, '닫기');
    }
  }

  function openFreeDeparture() {
    showModal('어디로 출발하나요?', `
      <form id="free-depart-form" class="profile-form">
        <label class="modal-field">목적지<input name="destination" maxlength="120" placeholder="예: 강남역, 학교, 청주 할머니 댁" autocomplete="off"></label>
        <label class="modal-field">이동 수단<select name="mode"><option value="transit">대중교통</option><option value="car">자동차</option><option value="walk">도보</option></select></label>
        <p class="modal-note">목적지를 적으면 도착했을 때 자동으로 가족에게 알려요.</p>
      </form>`, '출발 알리기', (modal) => {
      const form = modal.querySelector('#free-depart-form');
      const destination = form.elements.destination.value.trim();
      startTrip({ title: destination ? `${destination}(으)로 이동` : '이동 중', destinationText: destination, mode: form.elements.mode.value });
      return true;
    });
    const profile = readJson('mapdule-profile', {});
    const select = document.querySelector('#free-depart-form [name="mode"]');
    if (select && ['walk', 'transit', 'car'].includes(profile.transportMode)) select.value = profile.transportMode;
  }

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'family-join-form') {
      event.preventDefault();
      submitFamilyForm(event.target, 'join');
    } else if (event.target.id === 'family-create-form') {
      event.preventDefault();
      submitFamilyForm(event.target, 'create');
    }
  });

  document.addEventListener('click', (event) => {
    const depart = event.target.closest('[data-depart-event]');
    if (depart) {
      event.stopPropagation();
      startTripForEvent(depart.dataset.departEvent);
      return;
    }
    if (event.target.closest('[data-trip-arrive]')) {
      endTrip('arrived');
    } else if (event.target.closest('[data-trip-stop]')) {
      if (confirm('위치 공유를 멈출까요? 지금까지 지나온 경로도 지워져요.')) endTrip('stopped');
    } else if (event.target.closest('[data-trip-resume]')) {
      const trip = myTrip();
      if (trip?.status === 'moving') {
        writeJson(ACTIVE_TRIP_KEY, { tripId: trip.id });
        startWatching(trip.id);
        renderFamilyView();
      }
    } else if (event.target.closest('[data-free-depart]')) {
      openFreeDeparture();
    } else if (event.target.closest('[data-share-invite]')) {
      shareInvite();
    } else if (event.target.closest('[data-leave-family]')) {
      if (confirm(`'${state?.family?.name || '가족'}'에서 나갈까요? 가족 일정은 이 기기에서 더 이상 보이지 않아요.`)) {
        disconnect(true);
        showToast('가족에서 나왔어요.');
      }
    } else if (event.target.closest('[data-enable-notifications]')) {
      Notification.requestPermission().then(() => renderFamilyView());
    } else {
      const memberButton = event.target.closest('[data-focus-member]');
      if (memberButton) {
        focusedMemberId = focusedMemberId === memberButton.dataset.focusMember ? null : memberButton.dataset.focusMember;
        if (!focusedMemberId) mapFittedOnce = false;
        renderFamilyView();
      }
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.matches?.('.invite-input')) {
      event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refresh();
      if (tracking && !tracking.wakeLock) requestWakeLock();
    } else if (tracking) {
      flushPoints();
    }
  });

  // app.js의 화면 전환에서 호출
  function onViewShown(id) {
    if (id === 'family') {
      mapFittedOnce = false;
      renderFamilyView();
      refresh();
    }
    if (id === 'day-detail') {
      if (typeof renderCalendar === 'function') renderCalendar();
      else updateDayMap();
    }
    schedulePoll();
  }

  function notificationsHtml() {
    const activity = readJson(ACTIVITY_KEY, []).slice(0, 10);
    if (!activity.length) return '';
    return `<ul class="notification-list">${activity.map((entry) => `<li><span class="material-symbols-rounded">${ACTIVITY_ICONS[entry.type] || 'near_me'}</span><span>${escapeHtml(entry.text)}<small>${formatAgo(entry.at)}</small></span></li>`).join('')}</ul>`;
  }

  window.MapDuleFamily = {
    isJoined,
    me,
    members,
    memberById,
    events: familyEvents,
    saveEvent,
    deleteEvent,
    refresh,
    onViewShown,
    eventExtrasHtml,
    notificationsHtml,
    startTripForEvent,
    geocode,
    searchPlaces,
    updateDayMap
  };

  // ---------- 시작 ----------
  checkServer();
  if (credential) {
    afterStateChange(true);
    refresh().then(() => {
      if (location.hash === '#family') showView('family');
    });
  } else if (pendingJoinCode || location.hash === '#family') {
    showView('family');
  }
})();
