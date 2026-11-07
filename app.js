let views = [...document.querySelectorAll('.view')];
let navItems = [...document.querySelectorAll('.nav-item')];
const EVENTS_STORAGE_KEY = 'mapdule-events';
const PROFILE_STORAGE_KEY = 'mapdule-profile';
let editingEventId = null;
let kakaoMap = null;
let kakaoSdkReady = false;
let kakaoSdkLoading = false;
let kakaoMapCreating = false;
let currentLocationMarker = null;
let displayedMonth = new Date();
let calendarViewMode = 'month';
let analyzedScheduleEvents = [];
let aiPromptRevision = 0;
const visibleCalendars = new Set(['family', 'personal', 'work', 'health', 'other']);
const calendarGroups = [
  { id: 'family', name: '우리 가족', color: '#ef7d57', categories: ['가족'] },
  { id: 'personal', name: '개인', color: '#6f70d7', categories: ['개인', '약속'] },
  { id: 'work', name: '업무', color: '#e4a13b', categories: ['업무'] },
  { id: 'health', name: '운동', color: '#38a77c', categories: ['운동'] },
  { id: 'other', name: '기타', color: '#c16fc3', categories: ['기타'] }
];

async function fetchWithTimeout(url, options = {}, timeoutMs = 40000) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw Object.assign(new Error(timedOut
      ? '서버 응답이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.'
      : '서버에 연결할 수 없어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'), { code: timedOut ? 'AI_TIMEOUT' : 'AI_NETWORK' });
  }
}

async function readAiResponse(response) {
  const authPage = response.redirected && /\/\.auth\//.test(new URL(response.url).pathname);
  if (response.status === 401 || response.status === 403 || authPage) {
    throw Object.assign(new Error('AI 기능을 사용하려면 Microsoft 계정으로 로그인해 주세요.'), { code: 'AI_LOGIN_REQUIRED' });
  }
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/(?:json|[\w.-]+\+json)(?:\s*;|$)/i.test(contentType)) {
    throw Object.assign(new Error('AI 서버가 올바른 응답을 보내지 않았어요. 잠시 후 다시 시도해 주세요.'), { code: 'AI_INVALID_RESPONSE' });
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(new Error('AI 서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.'), { code: 'AI_INVALID_RESPONSE' });
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw Object.assign(new Error('AI 서버 응답 형식이 올바르지 않아요. 잠시 후 다시 시도해 주세요.'), { code: 'AI_INVALID_RESPONSE' });
  }
  if (!response.ok) {
    throw Object.assign(new Error(typeof result.error === 'string' ? result.error : 'AI 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'), {
      code: typeof result.code === 'string' ? result.code : 'AI_REQUEST_FAILED'
    });
  }
  return result;
}

function appendAiSignInLink(container, view = 'ai') {
  if (!container) return;
  const link = document.createElement('a');
  link.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(`${location.pathname}#${view}`)}`;
  link.textContent = 'Microsoft 계정으로 로그인';
  container.append(' ', link);
}

function readStoredValue(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function parseCalendarBackup(text) {
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    throw new Error('올바른 MapDule 백업 JSON 파일이 아닙니다.');
  }
  if (!backup || backup.format !== 'mapdule-backup' || (backup.version !== undefined && backup.version !== 1)
    || !Array.isArray(backup.events)
    || (backup.profile !== undefined && (!backup.profile || typeof backup.profile !== 'object' || Array.isArray(backup.profile)))) {
    throw new Error('지원하는 MapDule 백업 파일이 아닙니다.');
  }
  const ids = new Set();
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  backup.events.forEach((item, index) => {
    const date = typeof item?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date)
      ? new Date(`${item.date}T12:00:00`) : null;
    const validDate = date && date.getFullYear() === Number(item.date.slice(0, 4))
      && date.getMonth() + 1 === Number(item.date.slice(5, 7)) && date.getDate() === Number(item.date.slice(8, 10));
    const validPlace = item?.place == null || (typeof item.place === 'object'
      && Number.isFinite(item.place.lat) && Math.abs(item.place.lat) <= 90
      && Number.isFinite(item.place.lng) && Math.abs(item.place.lng) <= 180
      && ['name', 'address'].every((key) => item.place[key] === undefined || typeof item.place[key] === 'string'));
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 80
      || !validDate || !timePattern.test(item.startTime) || !timePattern.test(item.endTime)
      || (item.allDay !== undefined && typeof item.allDay !== 'boolean')
      || (!item.allDay && item.endTime <= item.startTime) || !validPlace
      || !['calendarId', 'category', 'location', 'notes'].every((key) => item[key] === undefined || typeof item[key] === 'string')) {
      throw new Error(`백업의 ${index + 1}번째 일정이 올바르지 않습니다. 날짜·시간·제목과 중복 ID를 확인해 주세요. 기존 데이터는 변경하지 않았습니다.`);
    }
    ids.add(item.id);
  });
  return backup;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function renderProfileAvatar(profile = {}) {
  const button = document.querySelector('.avatar');
  if (!button) return;
  const avatar = typeof profile.avatar === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/i.test(profile.avatar)
    ? profile.avatar
    : '';
  button.replaceChildren();
  button.classList.toggle('has-photo', Boolean(avatar));
  if (avatar) {
    const image = document.createElement('img');
    image.src = avatar;
    image.alt = '';
    button.append(image);
  } else {
    button.textContent = String(profile.name || '').trim().slice(0, 1) || 'P';
  }
  button.setAttribute('aria-label', `${profile.name || '프로필'} 수정`);
}

function decodeProfileImage(file) {
  if (window.createImageBitmap) return window.createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('사진 파일을 열 수 없습니다.'));
    };
    image.src = url;
  });
}

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clearDemoContent() {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  const weekButtons = [...document.querySelectorAll('.week-strip button')];
  const weekdayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const weekDates = weekButtons.map((button, index) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + index);
    button.innerHTML = `${weekdayNames[index]}<strong>${date.getDate()}</strong>`;
    button.classList.toggle('selected', date.toDateString() === today.toDateString());
    return {
      day: weekdayNames[index],
      date: date.getDate(),
      iso: localDateString(date),
      selected: date.toDateString() === today.toDateString()
    };
  });

  const month = today.getMonth() + 1;
  const todayName = weekdayNames[today.getDay()];
  document.querySelector('#today-title').innerHTML = `오늘, ${month}월 ${today.getDate()}일 <em>(${todayName})</em>`;
  document.querySelector('.status-pill').innerHTML = '<i></i>위치 미연결';
  const profile = readStoredValue(PROFILE_STORAGE_KEY, {});
  renderProfileAvatar(profile);

  document.querySelector('.map-card').innerHTML = `
    <div class="map-grid"></div>
    <div id="kakao-map" class="kakao-map-canvas" aria-label="카카오 지도"></div>
    <div class="map-empty"><span class="material-symbols-rounded">map</span><b>카카오 지도 키를 설정해 주세요</b><small>index.html의 kakao-javascript-key 항목에 JavaScript 키를 입력합니다.</small></div>
    <div class="map-top"><span><i></i>경로 대기 중</span><button class="map-location-button" type="button" aria-label="현재 위치 표시"><span class="material-symbols-rounded">my_location</span>내 위치</button></div>
  `;
  document.querySelector('.timeline').innerHTML = `
    <div class="empty-state panel">
      <span class="material-symbols-rounded">calendar_add_on</span>
      <h2>아직 등록된 일정이 없어요</h2>
      <p>첫 일정을 추가하면 하루 타임라인과 이동 경로를 만들어 드릴게요.</p>
      <button class="primary-cta" data-view="ai"><span class="material-symbols-rounded">add</span>첫 일정 등록</button>
    </div>
  `;

  document.querySelector('.prompt-card').innerHTML = `
    <div class="card-meta"><label class="eyebrow" for="schedule-prompt">일정 문장 입력</label><span id="azure-ai-status" class="tag slate">AI 설정 확인 중</span></div>
    <textarea id="schedule-prompt" class="prompt-input" rows="4" maxlength="4000" placeholder="예: 내일 오후 3시에 강남역에서 민수 만나고 저녁 7시에 집에서 운동할 거야"></textarea>
    <div class="prompt-actions"><span class="voice-pill"><span class="material-symbols-rounded">info</span>분석 결과를 확인한 뒤 캘린더에 등록합니다</span><button class="link-button" id="analyze-prompt" type="button"><span class="material-symbols-rounded">auto_awesome</span>AI로 일정 분석</button></div>
    <p id="ai-analysis-message" class="ai-analysis-message" role="status" aria-live="polite"></p>
  `;
  document.querySelector('.prompt-card').insertAdjacentHTML('afterend', `
    <section class="ai-plan-launch panel">
      <div><h2><span class="material-symbols-rounded">calculate</span>저장된 일정 계산</h2><p>선택한 날짜의 일정 간격, 위치 기반 이동 예상과 휴식 여유를 분석합니다.</p></div>
      <button id="analyze-day-plan" type="button"><span class="material-symbols-rounded">auto_awesome</span>일정 계산</button>
    </section>
    <section id="ai-plan-result" class="ai-plan-result panel" role="status" aria-live="polite" hidden></section>
  `);
  document.querySelector('#analyze-day-plan')?.addEventListener('click', analyzeSelectedDayPlan);
  document.querySelector('.section-title small').textContent = '일정 분석 후 표시됩니다';
  document.querySelector('.ai-stack').innerHTML = `
    <div class="empty-state panel"><span class="material-symbols-rounded">event_note</span><h2>분석된 일정이 없습니다</h2><p>일정 문장을 입력해 주세요. AI 연동 후 구조화된 일정과 이동 시간을 이곳에서 확인할 수 있습니다.</p></div>
  `;
  document.querySelector('.suggestion').hidden = true;
  document.querySelector('.preview').hidden = true;
  const aiCta = document.querySelector('#ai .primary-cta');
  aiCta.disabled = true;
  aiCta.textContent = '분석된 일정이 없습니다';
  document.querySelector('.manual-link').textContent = '오늘 화면으로 돌아가기';

  initializeMidpoint();

  const manualView = document.createElement('section');
  manualView.id = 'manual';
  manualView.className = 'view compact-view';
  manualView.setAttribute('aria-labelledby', 'manual-title');
  manualView.innerHTML = `
    <div class="section-heading">
      <div class="section-icon indigo-bg"><span class="material-symbols-rounded">event</span></div>
      <div><h1 id="manual-title">일정 직접 등록</h1><p>입력한 일정은 이 브라우저에 저장됩니다.</p></div>
    </div>
    <form id="manual-event-form" class="manual-form panel">
      <label class="form-field form-wide">일정 이름<input name="title" type="text" maxlength="80" placeholder="일정 이름" required></label>
      <label class="form-field">날짜<input name="date" type="date" required></label>
      <label class="form-field">분류<select name="category"><option>약속</option><option>업무</option><option>운동</option><option>개인</option><option>기타</option></select></label>
      <label class="form-field">시작 시간<input name="startTime" type="time" required></label>
      <label class="form-field">종료 시간<input name="endTime" type="time" required></label>
      <label class="form-field form-wide">장소<input name="location" type="text" maxlength="120" placeholder="장소 (선택)"></label>
      <label class="form-field form-wide">메모<textarea name="notes" rows="3" maxlength="300" placeholder="메모 (선택)"></textarea></label>
      <button class="primary-cta form-wide" type="submit"><span class="material-symbols-rounded">calendar_add_on</span>캘린더에 추가</button>
      <button class="secondary-cta form-wide cancel-edit hidden" type="button">수정 취소</button>
    </form>
    <section class="calendar-tools panel" aria-label="캘린더 데이터 관리">
      <h2>캘린더 관리</h2>
      <div class="calendar-tool-actions">
        <button type="button" id="export-ics"><span class="material-symbols-rounded">calendar_month</span>캘린더 파일 내보내기</button>
        <button type="button" id="export-backup"><span class="material-symbols-rounded">download</span>JSON 백업</button>
        <button type="button" id="import-backup"><span class="material-symbols-rounded">upload</span>백업 복원</button>
        <button type="button" id="clear-local-data"><span class="material-symbols-rounded">delete_sweep</span>모든 데이터 삭제</button>
        <input id="backup-file" type="file" accept="application/json,.json" hidden>
      </div>
    </section>
  `;
  document.querySelector('.bottom-nav').before(manualView);

  views = [...document.querySelectorAll('.view')];
  navItems = [...document.querySelectorAll('.nav-item')];

  return weekDates;
}

let weekDates = clearDemoContent();

async function requestMobility(action, body) {
  const response = await fetchWithTimeout(`/api/mobility/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!/^application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('이동 서버 응답을 확인하지 못했어요.');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '이동 요청에 실패했어요.');
  return result;
}

function initializeMidpoint() {
  const section = document.querySelector('#midpoint');
  section.innerHTML = `
    <div class="section-heading"><div class="section-icon green-bg"><span class="material-symbols-rounded">groups</span></div><div><h1 id="midpoint-title">약속 지점</h1><p>비교한 후보 중 이동 시간 차이가 작은 순서</p></div></div>
    <form id="midpoint-form" class="midpoint-form">
      <div class="midpoint-settings"><label class="form-field">이동 수단<select name="mode"><option value="transit">대중교통</option><option value="walk">도보</option><option value="car">자동차</option></select></label><label class="form-field">장소 종류<select name="category"><option value="cafe">카페</option><option value="restaurant">식당</option><option value="station">지하철역</option></select></label></div>
      <div class="midpoint-heading"><h2>참가자 출발지</h2><button type="button" data-add="participant" title="참가자 추가" aria-label="참가자 추가"><span class="material-symbols-rounded">person_add</span></button></div>
      <div id="midpoint-participants"></div>
      <div class="midpoint-heading"><h2>후보 장소</h2><div><button type="button" id="midpoint-nearby"><span class="material-symbols-rounded">near_me</span>주변 후보</button><button type="button" data-add="candidate" title="후보 추가" aria-label="후보 추가"><span class="material-symbols-rounded">add_location_alt</span></button></div></div>
      <div id="midpoint-candidates"></div>
      <button type="submit" class="primary-cta"><span class="material-symbols-rounded">route</span>이동 시간 비교</button>
    </form>
    <p id="midpoint-status" role="status" aria-live="polite"></p><div id="midpoint-results"></div>`;
  const form = section.querySelector('form');
  const status = section.querySelector('#midpoint-status');
  const results = section.querySelector('#midpoint-results');
  const participants = section.querySelector('#midpoint-participants');
  const candidates = section.querySelector('#midpoint-candidates');
  let compared = [];
  let busy = false;
  const invalidate = () => { compared = []; results.replaceChildren(); status.textContent = ''; };
  const limits = () => form.querySelectorAll('[data-add]').forEach((button) => {
    button.disabled = busy || (button.dataset.add === 'participant' ? participants.children.length >= 6 : candidates.children.length >= 5);
  });
  const addRow = (type, seed = null) => {
    const container = type === 'participant' ? participants : candidates;
    if (container.children.length >= (type === 'participant' ? 6 : 5)) return;
    const row = document.createElement('fieldset');
    row.className = 'midpoint-place';
    row.innerHTML = `<legend>${type === 'participant' ? '참가자' : '후보'}</legend>
      ${type === 'participant' ? '<label class="form-field">이름<input data-name maxlength="80" required placeholder="이름"></label>' : ''}
      <label class="form-field">${type === 'participant' ? '출발 장소' : '장소'}<div class="midpoint-search"><input data-query maxlength="120" required placeholder="장소명 또는 주소"><button type="button" data-search title="장소 검색" aria-label="장소 검색"><span class="material-symbols-rounded">search</span></button><button type="button" data-remove title="삭제" aria-label="삭제"><span class="material-symbols-rounded">close</span></button></div></label>
      <div data-search-results class="midpoint-search-results"></div>
      <details><summary>위도·경도</summary><div class="midpoint-coordinates"><label class="form-field">위도<input data-lat type="number" min="-90" max="90" step="any"></label><label class="form-field">경도<input data-lng type="number" min="-180" max="180" step="any"></label></div></details>`;
    container.append(row);
    const query = row.querySelector('[data-query]');
    const latitude = row.querySelector('[data-lat]');
    const longitude = row.querySelector('[data-lng]');
    const matches = row.querySelector('[data-search-results]');
    const select = (place) => { query.value = place.name; latitude.value = place.place.lat; longitude.value = place.place.lng; matches.textContent = place.address || '위치 선택됨'; invalidate(); };
    query.addEventListener('input', () => { latitude.value = ''; longitude.value = ''; matches.replaceChildren(); });
    row.querySelector('[data-search]').addEventListener('click', async (event) => {
      if (!query.value.trim()) return query.focus();
      const button = event.currentTarget;
      const searched = query.value;
      button.disabled = true;
      matches.textContent = '검색 중';
      try {
        const { places } = await requestMobility('search', { query: searched });
        if (query.value !== searched || !row.isConnected) return;
        matches.replaceChildren();
        if (!places.length) matches.textContent = '검색 결과가 없어요.';
        places.forEach((place) => {
          const choice = document.createElement('button');
          choice.type = 'button';
          choice.textContent = `${place.name} · ${place.address}`;
          choice.addEventListener('click', () => select(place));
          matches.append(choice);
        });
      } catch (error) { if (query.value === searched) matches.textContent = error.message; }
      finally { button.disabled = busy; }
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (container.children.length <= (type === 'participant' ? 2 : 1)) return;
      row.remove(); invalidate(); limits();
    });
    if (seed) select(seed);
    limits();
  };
  const readRows = (container) => [...container.children].map((row) => {
    const latitude = row.querySelector('[data-lat]').value;
    const longitude = row.querySelector('[data-lng]').value;
    const name = (row.querySelector('[data-name]') || row.querySelector('[data-query]')).value.trim();
    if (!name || !row.querySelector('[data-query]').value.trim() || latitude === '' || longitude === '') throw new Error('이름과 장소를 입력하고 검색 결과를 선택하거나 좌표를 입력해 주세요.');
    return { name, place: { lat: Number(latitude), lng: Number(longitude) } };
  });
  const setBusy = (value) => { busy = value; form.querySelectorAll('input, select, button').forEach((control) => { control.disabled = value; }); limits(); form.setAttribute('aria-busy', String(value)); };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  form.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => { addRow(button.dataset.add); invalidate(); }));
  form.querySelector('#midpoint-nearby').addEventListener('click', async () => {
    try {
      const origins = readRows(participants);
      setBusy(true); invalidate(); status.textContent = '주변 후보를 찾고 있어요.';
      const { places } = await requestMobility('nearby', { participants: origins, category: form.elements.category.value });
      if (!places.length) throw new Error('주변 후보가 없어요. 다른 종류나 직접 입력한 장소를 선택해 주세요.');
      candidates.replaceChildren(); places.forEach((place) => addRow('candidate', place));
      status.textContent = `${places.length}곳을 찾았어요.`;
    } catch (error) { status.textContent = error.message; }
    finally { setBusy(false); }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    try {
      const body = { mode: form.elements.mode.value, participants: readRows(participants), candidates: readRows(candidates) };
      invalidate(); setBusy(true); status.textContent = '이동 시간을 비교하고 있어요.';
      const response = await requestMobility('midpoint', body);
      compared = response.candidates;
      status.textContent = `${response.estimated ? '추정 경로가 포함되어 있어요. 실제 시간과 다를 수 있어요. ' : ''}조회 ${new Date(response.comparedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
      results.innerHTML = compared.map((candidate, index) => `<article class="midpoint-result"><header><h2>${index + 1}. ${escapeHtml(candidate.name)}</h2><span class="tag ${candidate.estimated ? 'amber' : 'green'}">${candidate.estimated ? '추정 포함' : '경로 조회'}</span></header><dl><div><dt>평균</dt><dd>${candidate.averageMinutes}분</dd></div><div><dt>최대</dt><dd>${candidate.maximumMinutes}분</dd></div><div><dt>차이</dt><dd>${candidate.spreadMinutes}분</dd></div></dl><ul>${candidate.travels.map((travel) => `<li><span>${escapeHtml(travel.name)}</span><b>${travel.travelMinutes}분</b><small>${travel.method === 'estimate' ? '직선거리 추정' : escapeHtml(travel.detail)}${travel.walkingMinutes ? ` · 도보 ${travel.walkingMinutes}분` : ''}${travel.transferCount ? ` · 환승 ${travel.transferCount}회` : ''}</small></li>`).join('')}</ul><footer><a href="https://map.kakao.com/link/map/${encodeURIComponent(candidate.name)},${candidate.place.lat},${candidate.place.lng}" target="_blank" rel="noopener noreferrer"><span class="material-symbols-rounded">map</span>지도</a><button type="button" data-use="${index}"><span class="material-symbols-rounded">event_available</span>이 장소로 일정 만들기</button></footer></article>`).join('');
    } catch (error) { status.textContent = error.message; }
    finally { setBusy(false); }
  });
  results.addEventListener('click', (event) => {
    const button = event.target.closest('[data-use]');
    const candidate = button && compared[Number(button.dataset.use)];
    if (candidate) openEventFormModal('create', { title: '약속', location: candidate.name, place: { ...candidate.place, name: candidate.name } });
  });
  addRow('participant'); addRow('participant'); addRow('candidate');
}

function initializeKakaoMap() {
  const key = document.querySelector('meta[name="kakao-javascript-key"]')?.content.trim();
  const mapCanvas = document.querySelector('#kakao-map');
  const fallback = document.querySelector('.map-empty');
  if (!mapCanvas || !fallback) return;

  const showError = (message) => {
    fallback.hidden = false;
    fallback.innerHTML = `<span class="material-symbols-rounded">error</span><b>카카오 지도를 불러오지 못했어요</b><small>${escapeHtml(message)}</small>`;
  };
  const createMapWhenVisible = () => {
    if (!kakaoSdkReady || kakaoMap || kakaoMapCreating
      || document.querySelector('.view.active')?.id !== 'day-detail'
      || !mapCanvas.clientWidth || !mapCanvas.clientHeight) return;
    kakaoMapCreating = true;
    try {
      window.kakao.maps.load(() => {
        kakaoMapCreating = false;
        if (kakaoMap || document.querySelector('.view.active')?.id !== 'day-detail'
          || !mapCanvas.clientWidth || !mapCanvas.clientHeight) return;
        try {
          kakaoMap = new window.kakao.maps.Map(mapCanvas, {
            center: new window.kakao.maps.LatLng(37.5665, 126.978),
            level: 8
          });
          fallback.hidden = true;
          window.MapDuleFamily?.updateDayMap();
        } catch {
          showError('화면을 새로 열고, Kakao Developers의 JavaScript 키와 허용 도메인을 확인해 주세요.');
        }
      });
    } catch {
      kakaoMapCreating = false;
      showError('화면을 새로 열고, Kakao Developers의 JavaScript 키와 허용 도메인을 확인해 주세요.');
    }
  };

  if (!key) {
    showError('Kakao Developers의 JavaScript 키가 설정되지 않았어요.');
    return;
  }
  if (kakaoSdkReady) {
    createMapWhenVisible();
    return;
  }
  if (kakaoSdkLoading) return;

  const script = document.createElement('script');
  script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
  script.async = true;
  kakaoSdkLoading = true;
  fallback.hidden = false;
  fallback.innerHTML = '<span class="material-symbols-rounded">progress_activity</span><b>지도를 불러오는 중이에요</b><small>잠시만 기다려 주세요.</small>';
  script.onload = () => {
    kakaoSdkLoading = false;
    if (!window.kakao?.maps?.load) {
      showError('Kakao Maps SDK가 초기화되지 않았어요. JavaScript 키와 허용 도메인을 확인해 주세요.');
      return;
    }
    try {
      window.kakao.maps.load(() => {
        kakaoSdkReady = true;
        createMapWhenVisible();
      });
    } catch {
      showError('Kakao Maps SDK가 초기화되지 않았어요. JavaScript 키와 허용 도메인을 확인해 주세요.');
    }
  };
  script.onerror = () => {
    kakaoSdkLoading = false;
    showError('Kakao Maps SDK 연결에 실패했어요. 네트워크와 허용 도메인을 확인해 주세요.');
  };
  document.head.append(script);
}

initializeKakaoMap();

function showLocationPermissionDialog({ title, description, details, actionLabel, onContinue, onCancel }) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop location-permission-backdrop';
  modal.innerHTML = `
    <section class="modal location-permission-modal" role="dialog" aria-modal="true" aria-labelledby="location-permission-title">
      <button class="modal-close" type="button" aria-label="닫기"><span class="material-symbols-rounded">close</span></button>
      <div class="location-permission-icon"><span class="material-symbols-rounded">location_on</span></div>
      <h2 id="location-permission-title">${escapeHtml(title)}</h2>
      <div class="location-permission-copy"><p>${escapeHtml(description)}</p>${details?.length ? `<ul>${details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}<small>위치 정보 접근 권한 · 선택</small></div>
      <footer class="location-permission-actions"><button class="location-permission-cancel" type="button">지금은 괜찮아요</button><button class="location-permission-continue" type="button">${escapeHtml(actionLabel)}</button></footer>
    </section>`;
  document.body.append(modal);
  let closed = false;
  const close = (cancelled) => {
    if (closed) return;
    closed = true;
    modal.remove();
    if (cancelled) onCancel?.();
  };
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.closest('.modal-close, .location-permission-cancel')) {
      close(true);
      return;
    }
    if (event.target.closest('.location-permission-continue')) {
      onContinue?.();
      close(false);
    }
  });
  modal.querySelector('.modal-close').focus();
}

function requestLocationWithConsent({ title, description, actionLabel }) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(Object.assign(new Error('위치 확인을 취소했어요.'), { code: 'LOCATION_CANCELLED' }));
    const settingsDetails = /iPhone|iPad|iPod/i.test(navigator.userAgent)
      ? ['Safari 주소창의 aA > 웹 사이트 설정 > 위치에서 허용해 주세요.', '설정을 바꾼 뒤 돌아와 다시 확인을 눌러 주세요.']
      : ['주소창 왼쪽의 사이트 정보 아이콘 > 위치 > 허용을 선택해 주세요.', '설정을 바꾼 뒤 돌아와 다시 확인을 눌러 주세요.'];
    const requestPosition = () => {
      if (!navigator.geolocation) {
        reject(new Error('이 브라우저에서는 위치 기능을 사용할 수 없습니다.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, (error) => {
        if (error.code === 1) {
          showLocationPermissionDialog({
            title: '위치 권한이 꺼져 있어요',
            description: '정확한 일정 위치와 이동 거리를 보려면 브라우저 설정에서 위치 권한을 허용해 주세요.',
            details: settingsDetails,
            actionLabel: '설정 변경 후 다시 확인',
            onContinue: requestPosition,
            onCancel: cancel
          });
          return;
        }
        reject(new Error(error.code === 2
          ? '현재 위치를 찾지 못했어요. GPS 신호가 더 좋은 곳에서 다시 시도해 주세요.'
          : error.code === 3 ? '위치 확인 시간이 초과됐어요. 다시 시도해 주세요.' : '현재 위치를 가져오지 못했어요.'));
      }, { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
    };
    const showPrepermission = () => showLocationPermissionDialog({
      title,
      description,
      details: ['위치 정보는 선택 권한이에요.', '이동 공유는 직접 출발을 누른 경우에만 가족에게 전송돼요.'],
      actionLabel,
      onContinue: requestPosition,
      onCancel: cancel
    });
    let permissionQuery = Promise.resolve('prompt');
    try {
      if (navigator.permissions?.query) {
        permissionQuery = navigator.permissions.query({ name: 'geolocation' }).then((permission) => permission.state).catch(() => 'prompt');
      }
    } catch {
      permissionQuery = Promise.resolve('prompt');
    }
    permissionQuery.then((permission) => {
      if (permission === 'granted') requestPosition();
      else if (permission === 'denied') {
        showLocationPermissionDialog({
          title: '위치 권한이 꺼져 있어요',
          description: '브라우저 설정에서 위치 권한을 허용해야 현재 위치와 이동 거리를 확인할 수 있어요.',
          details: settingsDetails,
          actionLabel: '설정 변경 후 다시 확인',
          onContinue: requestPosition,
          onCancel: cancel
        });
      } else showPrepermission();
    });
  });
}

async function showCurrentLocation() {
  if (!kakaoMap || !window.kakao?.maps) {
    showToast('카카오 지도가 아직 준비되지 않았습니다.', 'info');
    return;
  }
  const locationButton = document.querySelector('.map-location-button');
  if (locationButton) locationButton.disabled = true;
  try {
    const position = await requestLocationWithConsent({
      title: '내 위치를 지도에서 확인할까요?',
      description: '현재 위치를 지도에 표시해 가까운 일정 장소와의 거리를 확인할 수 있어요.',
      actionLabel: '내 위치 확인하기'
    });
    const coords = new window.kakao.maps.LatLng(position.coords.latitude, position.coords.longitude);
    if (!currentLocationMarker) {
      currentLocationMarker = new window.kakao.maps.Marker({ position: coords, title: '현재 위치' });
    } else {
      currentLocationMarker.setPosition(coords);
    }
    currentLocationMarker.setMap(kakaoMap);
    kakaoMap.setLevel(4);
    kakaoMap.panTo(coords);
    document.querySelector('.status-pill').innerHTML = '<i></i>현재 위치 표시됨';
    showToast('현재 위치를 지도에 표시했습니다.', 'success');
  } catch (error) {
    if (error.code !== 'LOCATION_CANCELLED') showToast(error.message || '현재 위치를 가져오지 못했습니다.', 'info');
  } finally {
    if (locationButton) locationButton.disabled = false;
  }
}

function showToast(message, tone = 'default') {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.append(toast);
  }
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  clearTimeout(showToast.timeout);
  requestAnimationFrame(() => toast.classList.add('visible'));
  showToast.timeout = setTimeout(() => toast.classList.remove('visible'), 2600);
}

function showModal(title, content, actionText = '확인', onAction) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <button class="modal-close" aria-label="닫기"><span class="material-symbols-rounded">close</span></button>
      <span class="modal-spark"><span class="material-symbols-rounded">auto_awesome</span></span>
      <h2 id="modal-title">${title}</h2>
      <div class="modal-content">${content}</div>
      <button class="modal-action">${actionText}</button>
    </section>`;
  document.body.append(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.closest('.modal-close')) close();
    if (event.target.closest('.modal-action')) {
      if (onAction?.(modal) === false) return;
      close();
    }
  });
  modal.querySelector('.modal-close').focus();
}

function showView(id) {
  views.forEach((view) => view.classList.toggle('active', view.id === id));
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === id));
  document.body.classList.toggle('calendar-visible', id === 'today');
  document.body.classList.remove('sidebar-open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // 숨겨진 상태에서 만든 카카오 지도는 크기가 0이라, 화면이 보일 때 다시 계산해야 한다.
  if (id === 'day-detail') requestAnimationFrame(() => {
    initializeKakaoMap();
    kakaoMap?.relayout();
    window.MapDuleFamily?.updateDayMap();
  });
  window.MapDuleFamily?.onViewShown(id);
}

document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-view]');
  if (control && document.body.contains(control)) showView(control.dataset.view);
});

document.querySelector('.brand')?.addEventListener('click', (event) => {
  event.preventDefault();
  showView('today');
});

document.querySelector('[aria-label="알림"]')?.addEventListener('click', () => {
  const familyNotifications = window.MapDuleFamily?.notificationsHtml() || '';
  showModal('알림 센터', `${familyNotifications || '<p>새로운 알림이 없습니다.</p>'}<button class="link-button" id="stop-all-departure-reminders" type="button"><span class="material-symbols-rounded">notifications_off</span>이 기기의 출발 알림 끄기</button><p id="stop-reminders-status" role="status"></p>`, '닫기');
  document.querySelector('#stop-all-departure-reminders')?.addEventListener('click', () => disableDepartureReminders(document.querySelector('#stop-reminders-status')));
});

function openProfileEditor() {
  const stored = readStoredValue(PROFILE_STORAGE_KEY, {});
  const profile = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const textValue = (value) => typeof value === 'string' ? value : '';
  const validAvatar = typeof profile.avatar === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/i.test(profile.avatar)
    ? profile.avatar
    : '';
  const initial = {
    name: textValue(profile.name).trim(),
    bio: textValue(profile.bio).trim(),
    home: textValue(profile.home).trim(),
    transportMode: ['walk', 'transit', 'car'].includes(profile.transportMode) ? profile.transportMode : 'transit',
    avatar: validAvatar
  };
  let draftAvatar = initial.avatar;
  let cropImage = null;
  let cropBaseScale = 1;
  let cropZoom = 1;
  let cropOffsetX = 0;
  let cropOffsetY = 0;
  let cropDrag = null;

  document.querySelector('.profile-editor-backdrop')?.remove();
  const modal = document.createElement('div');
  modal.className = 'profile-editor-backdrop';
  modal.innerHTML = `
    <section class="profile-editor" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
      <header class="profile-editor-header">
        <button class="profile-back-button" type="button" aria-label="뒤로가기"><span class="material-symbols-rounded">arrow_back</span></button>
        <h2 id="profile-editor-title">프로필 수정</h2>
        <button class="profile-save-button" type="button">완료</button>
      </header>
      <div class="profile-editor-scroll">
        <section class="profile-photo-section" aria-label="프로필 사진">
          <button class="profile-photo-button" type="button" aria-label="프로필 사진 변경">
            <img class="profile-photo-preview" alt="" ${draftAvatar ? `src="${escapeHtml(draftAvatar)}"` : 'hidden'}>
            <span class="profile-photo-placeholder material-symbols-rounded" ${draftAvatar ? 'hidden' : ''}>person</span>
            <span class="profile-photo-camera material-symbols-rounded">photo_camera</span>
          </button>
          <div class="profile-photo-actions">
            <span>프로필 사진</span>
            <button type="button" class="profile-photo-remove" ${draftAvatar ? '' : 'hidden'}>사진 삭제</button>
          </div>
          <input class="profile-image-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
        </section>
        <section class="profile-crop-panel" hidden aria-label="사진 자르기">
          <h3>사진 자르기</h3>
          <canvas class="profile-crop-canvas" width="320" height="320" aria-label="사진 위치 조정"></canvas>
          <p>사진을 끌어 위치를 맞추고 확대 정도를 조정하세요.</p>
          <label class="profile-crop-zoom">확대<input class="profile-crop-zoom-input" type="range" min="1" max="2.5" step="0.01" value="1"></label>
          <div class="profile-crop-actions"><button class="profile-crop-cancel" type="button">취소</button><button class="profile-crop-apply" type="button">사진 적용</button></div>
        </section>
        <form class="profile-editor-form">
          <label class="profile-field profile-name-field"><span>닉네임</span><span class="profile-input-wrap"><input name="name" type="text" maxlength="10" inputmode="text" autocomplete="nickname" enterkeyhint="next" value="${escapeHtml(initial.name)}" placeholder="예: 홍길동" aria-describedby="profile-name-help profile-name-count" required><small id="profile-name-count">${[...initial.name].length}/10</small></span><small class="profile-field-help" id="profile-name-help">한글, 영문, 숫자만 10자까지 사용할 수 있어요.</small></label>
          <label class="profile-field"><span>한 줄 소개</span><textarea name="bio" maxlength="50" rows="2" enterkeyhint="done" placeholder="나를 소개해 주세요">${escapeHtml(initial.bio)}</textarea><small class="profile-char-count"><span class="profile-bio-count">${[...initial.bio].length}</span>/50</small></label>
          <label class="profile-field"><span>집 위치</span><input name="home" type="text" maxlength="120" value="${escapeHtml(initial.home)}" placeholder="집 위치 (선택)"></label>
          <label class="profile-field"><span>기본 이동 수단</span><select name="transportMode"><option value="transit" ${initial.transportMode === 'transit' ? 'selected' : ''}>대중교통</option><option value="walk" ${initial.transportMode === 'walk' ? 'selected' : ''}>도보</option><option value="car" ${initial.transportMode === 'car' ? 'selected' : ''}>자동차</option></select></label>
          <p class="profile-storage-note">프로필은 이 브라우저에 저장됩니다.</p>
        </form>
        <section class="profile-data-tools" aria-label="일정 데이터 관리">
          <div><h3>내 일정 데이터</h3><p>이 브라우저의 일정을 백업하거나 다른 캘린더로 내보낼 수 있어요.</p></div>
          <div class="profile-data-actions">
            <button type="button" data-profile-export><span class="material-symbols-rounded">download</span>JSON 백업</button>
            <button type="button" data-profile-import><span class="material-symbols-rounded">upload</span>백업 복원</button>
            <button type="button" data-profile-calendar-export><span class="material-symbols-rounded">calendar_month</span>캘린더 파일</button>
          </div>
        </section>
      </div>
    </section>`;
  document.body.append(modal);

  const profileButton = document.querySelector('.avatar');
  const editor = modal.querySelector('.profile-editor');
  const scrollArea = modal.querySelector('.profile-editor-scroll');
  const form = modal.querySelector('.profile-editor-form');
  const nameInput = form.elements.name;
  const bioInput = form.elements.bio;
  const nameField = modal.querySelector('.profile-name-field');
  const nameHelp = modal.querySelector('#profile-name-help');
  const nameCount = modal.querySelector('#profile-name-count');
  const bioCount = modal.querySelector('.profile-bio-count');
  const saveButton = modal.querySelector('.profile-save-button');
  const photoInput = modal.querySelector('.profile-image-input');
  const photoPreview = modal.querySelector('.profile-photo-preview');
  const photoPlaceholder = modal.querySelector('.profile-photo-placeholder');
  const removePhotoButton = modal.querySelector('.profile-photo-remove');
  const cropPanel = modal.querySelector('.profile-crop-panel');
  const cropCanvas = modal.querySelector('.profile-crop-canvas');
  const cropContext = cropCanvas.getContext('2d');
  const cropZoomInput = modal.querySelector('.profile-crop-zoom-input');
  const cropSize = cropCanvas.width;
  const namePattern = /^[가-힣A-Za-z0-9]{1,10}$/u;

  const currentDraft = () => ({
    name: nameInput.value.trim(),
    bio: bioInput.value.trim(),
    home: form.elements.home.value.trim(),
    transportMode: form.elements.transportMode.value,
    avatar: draftAvatar
  });
  const hasChanges = () => JSON.stringify(currentDraft()) !== JSON.stringify(initial) || Boolean(cropImage);
  const validateName = () => {
    const value = nameInput.value.trim();
    const valid = namePattern.test(value);
    nameField.classList.toggle('is-invalid', !valid);
    nameInput.setAttribute('aria-invalid', String(!valid));
    nameHelp.textContent = valid
      ? '한글, 영문, 숫자만 사용할 수 있어요.'
      : value ? '특수문자와 공백은 사용할 수 없어요. 10자까지 입력해 주세요.' : '닉네임을 입력해 주세요.';
    nameCount.textContent = `${[...nameInput.value].length}/10`;
    saveButton.disabled = !valid || !hasChanges() || !cropPanel.hidden;
  };
  const updateDirtyState = () => {
    const valid = namePattern.test(nameInput.value.trim());
    saveButton.disabled = !valid || !hasChanges() || !cropPanel.hidden;
    removePhotoButton.hidden = !draftAvatar;
  };
  const updatePhotoPreview = () => {
    if (draftAvatar) {
      photoPreview.src = draftAvatar;
      photoPreview.hidden = false;
      photoPlaceholder.hidden = true;
    } else {
      photoPreview.removeAttribute('src');
      photoPreview.hidden = true;
      photoPlaceholder.hidden = false;
    }
    removePhotoButton.hidden = !draftAvatar;
  };
  const closeCropImage = () => {
    if (typeof cropImage?.close === 'function') cropImage.close();
    cropImage = null;
    cropDrag = null;
  };
  const closeEditor = () => {
    closeCropImage();
    document.removeEventListener('keydown', handleKeydown);
    modal.remove();
    profileButton?.focus();
  };
  const cancelEditor = () => {
    if (hasChanges() && !confirm('저장하지 않은 변경사항이 있어요. 닫을까요?')) return;
    closeEditor();
  };
  const drawCrop = () => {
    if (!cropImage || !cropContext) return;
    const width = cropImage.width || cropImage.naturalWidth;
    const height = cropImage.height || cropImage.naturalHeight;
    const drawWidth = width * cropBaseScale * cropZoom;
    const drawHeight = height * cropBaseScale * cropZoom;
    const maxX = Math.max(0, (drawWidth - cropSize) / 2);
    const maxY = Math.max(0, (drawHeight - cropSize) / 2);
    cropOffsetX = Math.max(-maxX, Math.min(maxX, cropOffsetX));
    cropOffsetY = Math.max(-maxY, Math.min(maxY, cropOffsetY));
    cropContext.fillStyle = '#fff';
    cropContext.fillRect(0, 0, cropSize, cropSize);
    cropContext.drawImage(cropImage, (cropSize - drawWidth) / 2 + cropOffsetX, (cropSize - drawHeight) / 2 + cropOffsetY, drawWidth, drawHeight);
  };
  const saveProfile = () => {
    validateName();
    if (saveButton.disabled) {
      nameInput.focus();
      return;
    }
    const updatedProfile = {
      ...profile,
      ...currentDraft()
    };
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(updatedProfile));
    } catch {
      showToast('사진이 너무 크거나 브라우저 저장 공간이 부족해요.', 'info');
      return;
    }
    renderProfileAvatar(updatedProfile);
    closeEditor();
    showToast('프로필을 저장했습니다.', 'success');
  };
  const handleKeydown = (event) => {
    if (event.key === 'Escape') cancelEditor();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target === bioInput) saveProfile();
  };

  nameInput.addEventListener('input', validateName);
  bioInput.addEventListener('input', () => {
    bioCount.textContent = String([...bioInput.value].length);
    updateDirtyState();
  });
  form.elements.home.addEventListener('input', updateDirtyState);
  form.elements.transportMode.addEventListener('change', updateDirtyState);
  form.addEventListener('focusin', (event) => {
    if (!event.target.matches('input, textarea, select')) return;
    setTimeout(() => event.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 200);
  });
  modal.querySelector('.profile-back-button').addEventListener('click', cancelEditor);
  modal.querySelector('.profile-save-button').addEventListener('click', saveProfile);
  modal.querySelector('[data-profile-export]').addEventListener('click', () => {
    if (hasChanges()) {
      showToast('먼저 프로필 변경사항을 저장해 주세요.', 'info');
      return;
    }
    document.querySelector('#export-backup')?.click();
  });
  modal.querySelector('[data-profile-import]').addEventListener('click', () => {
    if (hasChanges()) {
      showToast('먼저 프로필 변경사항을 저장해 주세요.', 'info');
      return;
    }
    closeEditor();
    document.querySelector('#backup-file')?.click();
  });
  modal.querySelector('[data-profile-calendar-export]').addEventListener('click', () => {
    document.querySelector('#export-ics')?.click();
  });
  modal.querySelector('.profile-photo-button').addEventListener('click', () => photoInput.click());
  removePhotoButton.addEventListener('click', () => {
    draftAvatar = '';
    updatePhotoPreview();
    updateDirtyState();
  });
  modal.querySelector('.profile-crop-cancel').addEventListener('click', () => {
    closeCropImage();
    cropPanel.hidden = true;
    photoInput.value = '';
    updateDirtyState();
  });
  modal.querySelector('.profile-crop-apply').addEventListener('click', () => {
    try {
      draftAvatar = cropCanvas.toDataURL('image/jpeg', 0.88);
      closeCropImage();
      cropPanel.hidden = true;
      photoInput.value = '';
      updatePhotoPreview();
      updateDirtyState();
    } catch {
      showToast('사진을 자르지 못했어요. 다른 이미지로 다시 시도해 주세요.', 'info');
    }
  });
  cropZoomInput.addEventListener('input', () => {
    cropZoom = Number(cropZoomInput.value);
    drawCrop();
  });
  cropCanvas.addEventListener('pointerdown', (event) => {
    if (!cropImage) return;
    cropDrag = { x: event.clientX, y: event.clientY, offsetX: cropOffsetX, offsetY: cropOffsetY };
    cropCanvas.setPointerCapture(event.pointerId);
  });
  cropCanvas.addEventListener('pointermove', (event) => {
    if (!cropDrag) return;
    const bounds = cropCanvas.getBoundingClientRect();
    cropOffsetX = cropDrag.offsetX + (event.clientX - cropDrag.x) * cropSize / bounds.width;
    cropOffsetY = cropDrag.offsetY + (event.clientY - cropDrag.y) * cropSize / bounds.height;
    drawCrop();
  });
  cropCanvas.addEventListener('pointerup', () => { cropDrag = null; });
  cropCanvas.addEventListener('pointercancel', () => { cropDrag = null; });
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      showToast('JPG, PNG, WEBP 또는 GIF 사진을 선택해 주세요.', 'info');
      photoInput.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast('사진은 8MB 이하로 선택해 주세요.', 'info');
      photoInput.value = '';
      return;
    }
    try {
      const image = await decodeProfileImage(file);
      const width = image.width || image.naturalWidth;
      const height = image.height || image.naturalHeight;
      if (!width || !height || width * height > 40000000) {
        if (typeof image.close === 'function') image.close();
        showToast('사진 크기가 너무 커요. 더 작은 이미지를 선택해 주세요.', 'info');
        photoInput.value = '';
        return;
      }
      closeCropImage();
      cropImage = image;
      cropBaseScale = Math.max(cropSize / width, cropSize / height);
      cropZoom = 1;
      cropOffsetX = 0;
      cropOffsetY = 0;
      cropZoomInput.value = '1';
      cropPanel.hidden = false;
      drawCrop();
      updateDirtyState();
      cropPanel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      showToast('사진 파일을 열 수 없습니다.', 'info');
      photoInput.value = '';
    }
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) cancelEditor();
  });
  document.addEventListener('keydown', handleKeydown);
  validateName();
  updatePhotoPreview();
  requestAnimationFrame(() => nameInput.focus());
}

document.querySelector('.avatar')?.addEventListener('click', openProfileEditor);

const dateTitle = document.querySelector('#today-title');
const dateButtons = [...document.querySelectorAll('.week-strip button')];
let selectedDate = new Date();

function setSelectedDate(date, announce = false) {
  selectedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const day = ['일', '월', '화', '수', '목', '금', '토'][selectedDate.getDay()];
  const isToday = selectedDate.toDateString() === new Date().toDateString();
  dateTitle.innerHTML = `${isToday ? '오늘, ' : ''}${selectedDate.getMonth() + 1}월 ${selectedDate.getDate()}일 <em>(${day})</em>`;
  displayedMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  const weekStart = new Date(selectedDate);
  weekStart.setDate(selectedDate.getDate() - selectedDate.getDay());
  weekDates = dateButtons.map((button, index) => {
    const dateForButton = new Date(weekStart);
    dateForButton.setDate(weekStart.getDate() + index);
    const iso = localDateString(dateForButton);
    const weekday = ['일', '월', '화', '수', '목', '금', '토'][index];
    const hasEvents = allEvents().some((item) => item.date === iso);
    button.innerHTML = `${weekday}<strong>${dateForButton.getDate()}</strong>${hasEvents ? '<i></i>' : ''}`;
    button.classList.toggle('selected', iso === localDateString(selectedDate));
    return { day: weekday, date: dateForButton.getDate(), iso, selected: iso === localDateString(selectedDate) };
  });
  renderCalendar();
  renderMonthCalendar();
  const dateField = document.querySelector('#manual-event-form [name="date"]');
  if (dateField) dateField.value = localDateString(selectedDate);
  if (announce) showToast(`${selectedDate.getMonth() + 1}월 ${selectedDate.getDate()}일 일정을 표시합니다.`);
}

dateButtons.forEach((button, index) => {
  button.addEventListener('click', () => {
    const selected = weekDates[index];
    setSelectedDate(new Date(`${selected.iso}T12:00:00`), true);
    showView('day-detail');
  });
});

function moveSelectedDate(days) {
  const date = new Date(selectedDate);
  date.setDate(date.getDate() + days);
  setSelectedDate(date, true);
}

document.querySelector('[aria-label="이전 날짜"]')?.addEventListener('click', () => moveSelectedDate(-1));
document.querySelector('[aria-label="다음 날짜"]')?.addEventListener('click', () => moveSelectedDate(1));

function calendarIdForEvent(item) {
  if (calendarGroups.some((group) => group.id === item.calendarId)) return item.calendarId;
  return calendarGroups.find((group) => group.categories.includes(item.category))?.id || 'other';
}

function openEventFormModal(mode = 'create', existingEvent = null, initialDate = localDateString(selectedDate)) {
  document.querySelector('.event-modal-backdrop')?.remove();
  const isEditing = mode === 'edit' && existingEvent;
  const family = window.MapDuleFamily;
  const familyJoined = Boolean(family?.isJoined());
  const selectedCalendar = isEditing ? calendarIdForEvent(existingEvent) : 'personal';
  const todayDate = localDateString(new Date());
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = localDateString(tomorrow);
  const now = new Date();
  const roundedNow = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  const defaultStartMinutes = initialDate === todayDate ? Math.min(roundedNow, 23 * 60) : 9 * 60;
  const formatTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const initialStartTime = isEditing ? existingEvent.startTime || '09:00' : formatTime(defaultStartMinutes);
  const initialEndTime = isEditing ? existingEvent.endTime || '10:00' : formatTime(Math.min(defaultStartMinutes + 60, 23 * 60 + 59));
  let selectedPlace = existingEvent?.place ? { ...existingEvent.place } : null;
  const selectableCalendars = calendarGroups.filter((group) => group.id !== 'family' || familyJoined || selectedCalendar === 'family');
  const participantIds = new Set(isEditing && existingEvent.participants ? existingEvent.participants : [family?.me()].filter(Boolean));
  const participantOptions = familyJoined
    ? family.members().map((member) => `<label class="participant-option" style="--member-color:${member.color}"><input type="checkbox" name="participants" value="${escapeHtml(member.id)}" ${participantIds.has(member.id) ? 'checked' : ''}><span>${escapeHtml(member.name)}${member.id === family.me() ? ' (나)' : ''}</span></label>`).join('')
    : '';
  const modal = document.createElement('div');
  modal.className = 'event-modal-backdrop';
  modal.innerHTML = `
    <section class="event-form-modal" role="dialog" aria-modal="true" aria-labelledby="event-modal-title">
      <header class="event-modal-header">
        <div><span class="event-modal-eyebrow">${isEditing ? '수정하기' : '새로 만들기'}</span><h2 id="event-modal-title">${isEditing ? '일정 수정' : '새 일정'}</h2></div>
        <button type="button" class="event-modal-close" aria-label="닫기"><span class="material-symbols-rounded">close</span></button>
      </header>
      <form class="event-modal-form">
        <label class="event-form-field event-title-field"><span>제목</span><input name="title" type="text" maxlength="80" placeholder="일정 제목을 입력하세요" value="${escapeHtml(existingEvent?.title || '')}" required autofocus></label>
        <div class="event-form-field event-date-field"><label for="event-date-input"><span>날짜</span></label><input id="event-date-input" name="date" type="date" value="${escapeHtml(isEditing ? existingEvent.date : initialDate)}" required><span class="event-date-shortcuts"><button type="button" data-event-date="${todayDate}">오늘</button><button type="button" data-event-date="${tomorrowDate}">내일</button></span></div>
        <label class="event-all-day-field"><input name="allDay" type="checkbox" ${isEditing && existingEvent.allDay ? 'checked' : ''}><span class="event-checkmark"></span><span>종일</span></label>
        <div class="event-time-fields">
          <div class="event-duration-presets" role="group" aria-label="일정 길이 빠른 설정"><span>일정 길이</span><button type="button" data-event-duration="30" aria-pressed="false">30분</button><button type="button" data-event-duration="60" aria-pressed="false">1시간</button><button type="button" data-event-duration="120" aria-pressed="false">2시간</button></div>
          <label class="event-form-field"><span>시작</span><input name="startTime" type="time" value="${escapeHtml(initialStartTime)}"></label>
          <span class="event-time-separator">—</span>
          <label class="event-form-field"><span>종료</span><input name="endTime" type="time" value="${escapeHtml(initialEndTime)}"></label>
        </div>
        <label class="event-form-field"><span>캘린더</span><select name="calendarId">${selectableCalendars.map((group) => `<option value="${group.id}" ${selectedCalendar === group.id ? 'selected' : ''}>${group.name}</option>`).join('')}</select></label>
        ${familyJoined ? `<fieldset class="event-participants-field" ${selectedCalendar === 'family' ? '' : 'hidden'}><legend>누가 가나요?</legend><div class="participant-options">${participantOptions}</div></fieldset>` : ''}
        ${familyJoined ? `<label class="event-form-field event-family-option" ${selectedCalendar === 'family' ? '' : 'hidden'}><span>출발 확인</span><select name="departNotice">${[[0, '사용 안 함'], [10, '10분 전까지 출발'], [20, '20분 전까지 출발'], [30, '30분 전까지 출발'], [45, '45분 전까지 출발'], [60, '1시간 전까지 출발'], [90, '1시간 30분 전까지 출발']].map(([value, label]) => `<option value="${value}" ${Number(isEditing ? existingEvent.departNotice || 0 : 30) === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <fieldset class="event-repeat-field event-family-option" ${selectedCalendar === 'family' ? '' : 'hidden'}><legend>매주 반복</legend><div class="repeat-days">${['일', '월', '화', '수', '목', '금', '토'].map((label, day) => `<label><input type="checkbox" name="repeatDays" value="${day}" ${isEditing && existingEvent.repeatDays?.includes(day) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div><label class="repeat-until">반복 종료일<input name="repeatUntil" type="date" value="${escapeHtml(isEditing ? existingEvent.repeatUntil || '' : '')}"></label></fieldset>
        <label class="event-return-field event-family-option" ${selectedCalendar === 'family' ? '' : 'hidden'}><input type="checkbox" name="returnHome" ${(isEditing ? existingEvent.returnHome : true) ? 'checked' : ''}><span>끝나면 집으로 귀가 알림</span></label>
        ${isEditing && existingEvent.seriesId ? '<fieldset class="event-scope-field"><legend>수정 범위</legend><label><input type="radio" name="scope" value="one" checked>이 날만</label><label><input type="radio" name="scope" value="series">이 날부터 이후 모두</label></fieldset>' : ''}` : ''}
        <div class="event-form-field event-location-field"><label for="event-location-input"><span>장소 <small>선택</small></span></label><div class="event-location-input-row"><input id="event-location-input" name="location" type="text" maxlength="120" placeholder="장소명이나 도로명 주소" value="${escapeHtml(existingEvent?.location || '')}"><button class="event-location-search" type="button" aria-label="장소 검색" title="지도에서 장소 검색"><span class="material-symbols-rounded">search</span></button></div><p class="event-location-status" aria-live="polite">${selectedPlace ? `선택한 위치 · ${escapeHtml(selectedPlace.name)}${selectedPlace.address ? ` · ${escapeHtml(selectedPlace.address)}` : ''}` : '검색 결과를 확인해 정확한 장소를 선택하세요.'}</p><div class="event-place-results" hidden></div></div>
        <label class="event-form-field"><span>설명</span><textarea name="notes" rows="3" maxlength="300" placeholder="메모를 남겨 보세요">${escapeHtml(isEditing ? existingEvent.notes || existingEvent.description || '' : '')}</textarea></label>
        <footer class="event-modal-footer">
          ${isEditing ? '<button class="event-delete-button" type="button"><span class="material-symbols-rounded">delete</span>삭제</button>' : '<span></span>'}
          <div><button class="event-cancel-button" type="button">취소</button><button class="event-save-button" type="submit">${isEditing ? '저장' : '등록'}</button></div>
        </footer>
      </form>
    </section>
  `;
  document.body.append(modal);
  const form = modal.querySelector('.event-modal-form');
  const titleInput = form.elements.title;
  const timeFields = [...form.querySelectorAll('[name="startTime"], [name="endTime"]')];
  const locationInput = form.elements.location;
  const locationStatus = form.querySelector('.event-location-status');
  const placeResults = form.querySelector('.event-place-results');
  const placeSearchButton = form.querySelector('.event-location-search');
  let placeCandidates = [];
  let placeSearchId = 0;
  const close = () => {
    modal.remove();
    document.removeEventListener('keydown', handleEscape);
  };
  const handleEscape = (event) => {
    if (event.key === 'Escape') close();
  };
  const updateAllDayFields = () => {
    form.elements.endTime.setCustomValidity('');
    timeFields.forEach((input) => {
      input.disabled = form.elements.allDay.checked;
      input.required = !form.elements.allDay.checked;
    });
    form.querySelectorAll('.event-family-option input, .event-family-option select').forEach((input) => {
      input.disabled = form.elements.allDay.checked;
    });
    updateDurationControls();
  };
  const updateDurationControls = () => {
    if (!form.elements.startTime || !form.elements.endTime) return;
    const [hours, minutes] = form.elements.startTime.value.split(':').map(Number);
    const startMinutes = hours * 60 + minutes;
    const duration = form.elements.endTime.value.split(':').map(Number);
    const currentDuration = duration[0] * 60 + duration[1] - startMinutes;
    form.querySelectorAll('[data-event-duration]').forEach((button) => {
      const minutesToAdd = Number(button.dataset.eventDuration);
      const active = currentDuration === minutesToAdd;
      button.disabled = form.elements.allDay.checked || !Number.isFinite(startMinutes) || startMinutes + minutesToAdd > 23 * 60 + 59;
      button.setAttribute('aria-pressed', String(active));
    });
  };
  updateAllDayFields();
  form.elements.allDay.addEventListener('change', updateAllDayFields);
  timeFields.forEach((input) => input.addEventListener('input', () => {
    form.elements.endTime.setCustomValidity('');
    updateDurationControls();
  }));
  titleInput.addEventListener('input', () => titleInput.setCustomValidity(''));
  form.querySelectorAll('[data-event-duration]').forEach((button) => {
    button.addEventListener('click', () => {
      const [hours, minutes] = form.elements.startTime.value.split(':').map(Number);
      const endMinutes = hours * 60 + minutes + Number(button.dataset.eventDuration);
      if (endMinutes > 23 * 60 + 59) return;
      form.elements.endTime.value = formatTime(endMinutes);
      form.elements.endTime.setCustomValidity('');
      updateDurationControls();
    });
  });
  form.querySelectorAll('[data-event-date]').forEach((button) => {
    button.addEventListener('click', () => {
      form.elements.date.value = button.dataset.eventDate;
      form.elements.date.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  placeSearchButton.addEventListener('click', async () => {
    const query = locationInput.value.trim();
    if (!query) {
      locationStatus.textContent = '장소명이나 주소를 먼저 입력해 주세요.';
      locationInput.focus();
      return;
    }
    const requestId = ++placeSearchId;
    placeSearchButton.disabled = true;
    locationStatus.textContent = '지도에서 장소를 찾고 있어요.';
    placeResults.hidden = true;
    try {
      placeCandidates = await family?.searchPlaces?.(query) || [];
      if (requestId !== placeSearchId) return;
      if (!placeCandidates.length) {
        locationStatus.textContent = '검색 결과가 없어요. 장소명이나 도로명 주소를 바꿔 검색해 주세요.';
        return;
      }
      placeResults.innerHTML = placeCandidates.map((place, index) => `<button type="button" class="event-place-option" data-place-index="${index}"><b>${escapeHtml(place.name)}</b><small>${escapeHtml(place.address || `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`)}</small></button>`).join('');
      placeResults.hidden = false;
      locationStatus.textContent = '목록에서 지도 위치가 맞는 장소를 선택하세요.';
    } catch {
      if (requestId === placeSearchId) locationStatus.textContent = '장소를 검색하지 못했어요. 인터넷 연결을 확인해 주세요.';
    } finally {
      if (requestId === placeSearchId) placeSearchButton.disabled = false;
    }
  });
  placeResults.addEventListener('click', (event) => {
    const option = event.target.closest('[data-place-index]');
    if (!option) return;
    selectedPlace = placeCandidates[Number(option.dataset.placeIndex)];
    locationInput.value = selectedPlace.name;
    locationStatus.textContent = `선택한 위치 · ${selectedPlace.name}${selectedPlace.address ? ` · ${selectedPlace.address}` : ''} (${selectedPlace.lat.toFixed(5)}, ${selectedPlace.lng.toFixed(5)})`;
    placeResults.hidden = true;
  });
  locationInput.addEventListener('input', () => {
    placeSearchId += 1;
    placeSearchButton.disabled = false;
    placeCandidates = [];
    placeResults.hidden = true;
    if (selectedPlace && locationInput.value.trim() !== selectedPlace.name) selectedPlace = null;
    if (!selectedPlace) locationStatus.textContent = locationInput.value.trim() ? '장소를 검색해 정확한 위치를 선택하세요.' : '장소는 선택사항입니다.';
  });
  form.elements.calendarId.addEventListener('change', () => {
    const participantsField = form.querySelector('.event-participants-field');
    if (participantsField) participantsField.hidden = form.elements.calendarId.value !== 'family';
    form.querySelectorAll('.event-family-option').forEach((field) => {
      field.hidden = form.elements.calendarId.value !== 'family';
    });
  });
  form.elements.repeatUntil?.addEventListener('input', () => form.elements.repeatUntil.setCustomValidity(''));
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.closest('.event-modal-close, .event-cancel-button')) close();
  });
  document.addEventListener('keydown', handleEscape);
  requestAnimationFrame(() => titleInput.focus());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    titleInput.setCustomValidity(titleInput.value.trim() ? '' : '일정 제목을 입력해 주세요.');
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const allDay = form.elements.allDay.checked;
    const startTime = allDay ? '00:00' : String(data.get('startTime'));
    const endTime = allDay ? '23:59' : String(data.get('endTime'));
    if (!allDay && endTime <= startTime) {
      form.elements.endTime.setCustomValidity('종료 시간은 시작 시간보다 늦어야 합니다.');
      form.elements.endTime.reportValidity();
      return;
    }
    form.elements.endTime.setCustomValidity('');
    const calendarId = String(data.get('calendarId'));
    const group = calendarGroups.find((candidate) => candidate.id === calendarId) || calendarGroups[0];
    const savedEvent = {
      id: isEditing ? existingEvent.id : globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: String(data.get('title')).trim(),
      date: String(data.get('date')),
      startTime,
      endTime,
      allDay,
      calendarId: group.id,
      category: group.categories[0],
      location: String(data.get('location')).trim(),
      notes: String(data.get('notes')).trim()
    };
    if (savedEvent.location && selectedPlace) savedEvent.place = { ...selectedPlace, name: savedEvent.location };
    const toFamily = group.id === 'family';
    const saveScope = isEditing && existingEvent.seriesId ? String(data.get('scope') || 'one') : 'series';
    if (toFamily) {
      savedEvent.participants = data.getAll('participants').map(String);
      savedEvent.departNotice = allDay ? 0 : Number(data.get('departNotice') || 0);
      savedEvent.returnHome = !allDay && form.elements.returnHome.checked;
      const days = allDay ? [] : data.getAll('repeatDays').map(Number);
      const until = String(data.get('repeatUntil') || '') || null;
      if (days.length && until && until < savedEvent.date) {
        form.elements.repeatUntil.setCustomValidity('반복 종료일은 일정 날짜보다 빠를 수 없어요.');
        form.elements.repeatUntil.reportValidity();
        return;
      }
      savedEvent.repeat = days.length && !(isEditing && existingEvent.seriesId && saveScope === 'one') ? { days, until } : null;
    }
    if (!savedEvent.place && isEditing && existingEvent.place?.name === savedEvent.location) savedEvent.place = existingEvent.place;
    const conflict = findTimeConflict(savedEvent, isEditing ? existingEvent.id : null);
    if (conflict && !confirm(`'${conflict.title}' 일정과 시간이 겹쳐요. 그래도 저장할까요?`)) return;

    const saveButton = form.querySelector('.event-save-button');
    saveButton.disabled = true;
    try {
      const wasFamily = isEditing && existingEvent.source === 'family';
      const savedEvents = loadSavedEvents();
      if (toFamily) {
        if (isEditing && !wasFamily && !saveEvents(savedEvents.filter((item) => item.id !== existingEvent.id))) return;
        try {
          await family.saveEvent(savedEvent, saveScope);
        } catch (error) {
          if (isEditing && !wasFamily) saveEvents(savedEvents);
          throw error;
        }
      } else {
        const updatedEvents = isEditing && !wasFamily
          ? savedEvents.map((item) => item.id === existingEvent.id ? savedEvent : item)
          : [...savedEvents, savedEvent];
        if (!saveEvents(updatedEvents)) return;
        if (wasFamily) {
          try {
            await family.deleteEvent(existingEvent.id);
          } catch (error) {
            saveEvents(savedEvents);
            throw error;
          }
        }
      }
    } catch (error) {
      showToast(error.message || '일정을 저장하지 못했습니다.', 'info');
      return;
    } finally {
      saveButton.disabled = false;
    }
    const [year, month, day] = savedEvent.date.split('-').map(Number);
    displayedMonth = new Date(year, month - 1, 1);
    close();
    setSelectedDate(new Date(year, month - 1, day, 12));
    if (document.querySelector('.view.active')?.id !== 'day-detail') showView('today');
    showToast(toFamily ? '가족 일정에 저장했어요. 가족 모두에게 보여요.' : isEditing ? '일정을 수정했습니다.' : '일정을 등록했습니다.', 'success');
  });

  modal.querySelector('.event-delete-button')?.addEventListener('click', () => deleteEventWithConfirm(existingEvent, close));
}

// 일정 삭제는 실수로 누르기 쉬워 항상 한 번 더 묻는다. 가족 일정은 모두에게서 사라진다는 점을 알린다.
async function deleteEventWithConfirm(item, onDone, scope = null) {
  const isFamily = item.source === 'family';
  if (isFamily && item.seriesId && scope === null) {
    showModal('반복 일정 삭제', `<p>${escapeHtml(item.title)}</p><fieldset class="event-scope-field"><legend>삭제 범위</legend><label><input type="radio" name="deleteScope" value="one" checked>이 날만</label><label><input type="radio" name="deleteScope" value="series">이 날부터 이후 모두</label></fieldset>`, '삭제', (modal) => {
      deleteEventWithConfirm(item, onDone, modal.querySelector('[name="deleteScope"]:checked').value);
      return true;
    });
    return;
  }
  const message = isFamily
    ? `'${item.title}' 일정을 삭제할까요?\n가족 모두의 캘린더에서 사라져요.`
    : `'${item.title}' 일정을 삭제할까요?`;
  if (scope === null && !confirm(message)) return;
  try {
    if (isFamily) await window.MapDuleFamily.deleteEvent(item.id, scope || 'one');
    else if (!saveEvents(loadSavedEvents().filter((saved) => saved.id !== item.id))) return;
  } catch (error) {
    showToast(error.message || '일정을 삭제하지 못했습니다.', 'info');
    return;
  }
  onDone?.();
  setSelectedDate(selectedDate);
  showToast('일정을 삭제했습니다.', 'success');
}

function eventsForDate(date) {
  return allEvents()
    .filter((item) => item.date === date && visibleCalendars.has(calendarIdForEvent(item)))
    .sort((first, second) => (first.allDay ? '' : first.startTime).localeCompare(second.allDay ? '' : second.startTime));
}

function renderCalendarSidebar() {
  const list = document.querySelector('.calendar-list');
  if (list) {
    const familyJoined = Boolean(window.MapDuleFamily?.isJoined());
    list.innerHTML = calendarGroups.filter((group) => group.id !== 'family' || familyJoined).map((group) => `
      <label class="calendar-list-item">
        <input type="checkbox" value="${group.id}" ${visibleCalendars.has(group.id) ? 'checked' : ''}>
        <span class="calendar-color-dot" style="--calendar-color:${group.color}"></span>
        <span>${group.name}</span>
      </label>
    `).join('');
  }

  const miniTitle = document.querySelector('.mini-calendar-title');
  const miniDays = document.querySelector('.mini-calendar-days');
  if (!miniTitle || !miniDays) return;
  miniTitle.textContent = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long' }).format(displayedMonth);
  const monthStart = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth(), 1);
  const gridStart = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth(), 1 - monthStart.getDay());
  const today = localDateString(new Date());
  miniDays.innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const iso = localDateString(date);
    const hasEvents = eventsForDate(iso).length > 0;
    const classes = [
      'mini-day',
      date.getMonth() !== displayedMonth.getMonth() ? 'outside-month' : '',
      iso === today ? 'is-today' : '',
      iso === localDateString(selectedDate) ? 'is-selected' : ''
    ].filter(Boolean).join(' ');
    return `<button class="${classes}" type="button" data-mini-date="${iso}" aria-label="${date.getMonth() + 1}월 ${date.getDate()}일">${date.getDate()}${hasEvents ? '<i></i>' : ''}</button>`;
  }).join('');
}

function eventHasEnded(item) {
  if (!item?.date) return false;
  const endTime = item.allDay ? '23:59:59' : `${item.endTime || '23:59'}:00`;
  const end = new Date(`${item.date}T${endTime}`);
  return Number.isFinite(end.valueOf()) && end <= new Date();
}

function renderEventBadge(item, compact = false) {
  const group = calendarGroups.find((candidate) => candidate.id === calendarIdForEvent(item));
  const time = item.allDay ? '종일' : item.startTime;
  const classes = ['event-badge', compact ? 'compact' : '', eventHasEnded(item) ? 'is-ended' : ''].filter(Boolean).join(' ');
  return `<button type="button" class="${classes}" style="--calendar-color:${group.color}" data-edit-event="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 수정">
    ${compact ? '' : `<span class="event-badge-time">${escapeHtml(time)}</span>`}<span class="event-badge-title">${escapeHtml(item.title)}</span>
  </button>`;
}

function renderDayCell(date, month) {
  const iso = localDateString(date);
  const isToday = iso === localDateString(new Date());
  const classes = [
    'calendar-day-cell',
    date.getMonth() !== month ? 'outside-month' : '',
    isToday ? 'is-today' : '',
    iso === localDateString(selectedDate) ? 'is-selected' : ''
  ].filter(Boolean).join(' ');
  const events = eventsForDate(iso);
  const badges = events.slice(0, 3).map((item) => renderEventBadge(item, true)).join('');
  const extraCount = events.length > 3 ? `<span class="calendar-more">+${events.length - 3}개</span>` : '';
  return `<div class="${classes}" data-calendar-date="${iso}" role="group" tabindex="0" aria-label="${date.getMonth() + 1}월 ${date.getDate()}일 일정 ${events.length}개">
    <button type="button" class="calendar-day-number" data-select-date="${iso}" aria-label="${date.getMonth() + 1}월 ${date.getDate()}일 선택">${date.getDate()}</button>
    <div class="calendar-day-events">${badges}${extraCount}</div>
  </div>`;
}

function renderMonthView() {
  const year = displayedMonth.getFullYear();
  const month = displayedMonth.getMonth();
  const monthStart = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - monthStart.getDay());
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const header = weekdays.map((day, index) => `<div class="month-weekday${index === 0 ? ' sunday' : ''}${index === 6 ? ' saturday' : ''}">${day}</div>`).join('');
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return renderDayCell(date, month);
  }).join('');
  return `<div class="month-grid" aria-label="날짜별 일정">${header}${cells}</div>`;
}

function renderWeekView() {
  const first = new Date(selectedDate);
  first.setDate(selectedDate.getDate() - selectedDate.getDay());
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(first);
    date.setDate(first.getDate() + index);
    return date;
  });
  const headings = dates.map((date) => {
    const iso = localDateString(date);
    const classes = ['week-day-heading', iso === localDateString(new Date()) ? 'is-today' : ''].filter(Boolean).join(' ');
    return `<button class="${classes}" type="button" data-select-date="${iso}"><span>${['일', '월', '화', '수', '목', '금', '토'][date.getDay()]}</span><strong>${date.getDate()}</strong></button>`;
  }).join('');
  const columns = dates.map((date) => {
    const events = eventsForDate(localDateString(date));
    return `<div class="week-day-column" data-calendar-date="${localDateString(date)}">${events.length ? events.map((item) => renderEventBadge(item)).join('') : '<span class="week-empty-label">일정 없음</span>'}</div>`;
  }).join('');
  return `<div class="week-view"><div class="week-view-header"><span></span>${headings}</div><div class="week-view-body"><span class="week-time-label">종일</span>${columns}</div></div>`;
}

function renderDayView() {
  const iso = localDateString(selectedDate);
  const events = eventsForDate(iso);
  const heading = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(selectedDate);
  return `<section class="single-day-view"><header><span>${escapeHtml(heading)}</span><button type="button" class="calendar-today-button" data-select-date="${iso}">날짜 선택</button></header>
    ${events.length ? events.map((item) => renderEventBadge(item)).join('') : `<button type="button" class="day-empty-state" data-create-date="${iso}"><span class="material-symbols-rounded">add_circle</span>일정을 추가해 보세요</button>`}
  </section>`;
}

function renderAgendaView() {
  const monthStart = localDateString(new Date(displayedMonth.getFullYear(), displayedMonth.getMonth(), 1));
  const monthEnd = localDateString(new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + 1, 0));
  const events = allEvents()
    .filter((item) => item.date >= monthStart && item.date <= monthEnd && visibleCalendars.has(calendarIdForEvent(item)))
    .sort((first, second) => `${first.date}${first.allDay ? '' : first.startTime}`.localeCompare(`${second.date}${second.allDay ? '' : second.startTime}`));
  if (!events.length) return '<div class="agenda-empty">이번 달에 등록된 일정이 없습니다.</div>';
  return `<div class="agenda-view">${events.map((item) => {
    const date = new Date(`${item.date}T12:00:00`);
    return `<article class="agenda-event-row"><time>${date.getDate()}일 <span>${['일', '월', '화', '수', '목', '금', '토'][date.getDay()]}</span></time>${renderEventBadge(item)}</article>`;
  }).join('')}</div>`;
}

function centerSelectedWeekDay(content) {
  const weekView = content.querySelector('.week-view');
  const heading = weekView?.querySelector(`.week-day-heading[data-select-date="${localDateString(selectedDate)}"]`);
  if (!weekView || !heading) return;
  const offset = heading.getBoundingClientRect().left - weekView.getBoundingClientRect().left + weekView.scrollLeft;
  weekView.scrollLeft = Math.max(0, offset - (weekView.clientWidth - heading.offsetWidth) / 2);
}

function renderCalendarView() {
  const content = document.querySelector('.calendar-view-content');
  if (!content) return;
  const renderers = { month: renderMonthView, week: renderWeekView, day: renderDayView, agenda: renderAgendaView };
  content.innerHTML = renderers[calendarViewMode]();
  if (calendarViewMode === 'week') centerSelectedWeekDay(content);
  renderMobileSelectedDay();
  const select = document.querySelector('.calendar-view-select');
  if (select) select.value = calendarViewMode;
  const title = document.querySelector('#calendar-title');
  const previousButton = document.querySelector('.main-month-prev');
  const nextButton = document.querySelector('.main-month-next');
  const periodLabel = calendarViewMode === 'week' ? '주' : calendarViewMode === 'day' ? '날짜' : '달';
  previousButton?.setAttribute('aria-label', `이전 ${periodLabel}`);
  nextButton?.setAttribute('aria-label', `다음 ${periodLabel}`);
  if (title) title.textContent = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long' }).format(displayedMonth);
}

function renderMobileSelectedDay() {
  const panel = document.querySelector('.mobile-selected-day');
  if (!panel) return;
  const events = eventsForDate(localDateString(selectedDate));
  const heading = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(selectedDate);
  panel.innerHTML = `
    <header class="mobile-selected-day-header">
      <div><span>선택한 날짜</span><h2>${escapeHtml(heading)}</h2></div>
      <button type="button" class="mobile-day-detail-button">자세히 보기<span class="material-symbols-rounded">arrow_forward</span></button>
    </header>
    ${events.length
      ? `<div class="mobile-event-list">${events.map((item) => renderEventBadge(item)).join('')}</div>`
      : '<p class="mobile-no-events">등록된 일정이 없습니다.</p>'}
    <button type="button" class="mobile-add-selected-event"><span class="material-symbols-rounded">add</span>이 날짜에 일정 추가</button>
  `;
}

function renderMonthCalendar() {
  renderCalendarSidebar();
  renderCalendarView();
}

function changeDisplayedMonth(offset) {
  displayedMonth = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + offset, 1);
  renderMonthCalendar();
}

function navigateCalendar(offset) {
  if (calendarViewMode === 'month' || calendarViewMode === 'agenda') {
    changeDisplayedMonth(offset);
    return;
  }
  const date = new Date(selectedDate);
  date.setDate(date.getDate() + offset * (calendarViewMode === 'week' ? 7 : 1));
  setSelectedDate(date);
}

document.querySelector('.main-month-prev')?.addEventListener('click', () => navigateCalendarWithMotion(-1));
document.querySelector('.main-month-next')?.addEventListener('click', () => navigateCalendarWithMotion(1));
function navigateCalendarWithMotion(offset) {
  const calendarContent = document.querySelector('.calendar-view-content');
  calendarContent?.classList.remove('calendar-enter-next', 'calendar-enter-previous');
  navigateCalendar(offset);
  if (!calendarContent) return;
  calendarContent.classList.add(offset > 0 ? 'calendar-enter-next' : 'calendar-enter-previous');
}

const calendarViewport = document.querySelector('.calendar-view-content');
let calendarSwipeStart = null;
let suppressCalendarClickUntil = 0;
calendarViewport?.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1 || event.target.closest('.week-view')) {
    calendarSwipeStart = null;
    return;
  }
  const touch = event.touches[0];
  calendarSwipeStart = { x: touch.clientX, y: touch.clientY };
}, { passive: true });

document.addEventListener('touchend', (event) => {
  if (!calendarSwipeStart) return;
  const touch = event.changedTouches[0];
  const deltaX = touch.clientX - calendarSwipeStart.x;
  const deltaY = touch.clientY - calendarSwipeStart.y;
  calendarSwipeStart = null;
  if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.3) return;
  suppressCalendarClickUntil = Date.now() + 400;
  navigateCalendarWithMotion(deltaX < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener('touchcancel', () => {
  calendarSwipeStart = null;
}, { passive: true });

calendarViewport?.addEventListener('animationend', (event) => {
  if (event.target === calendarViewport) {
    calendarViewport.classList.remove('calendar-enter-next', 'calendar-enter-previous');
  }
});

document.querySelector('.mini-month-prev')?.addEventListener('click', () => changeDisplayedMonth(-1));
document.querySelector('.mini-month-next')?.addEventListener('click', () => changeDisplayedMonth(1));
document.querySelector('.calendar-view-select')?.addEventListener('change', (event) => {
  calendarViewMode = event.currentTarget.value;
  renderCalendarView();
});
document.querySelector('.calendar-today-button')?.addEventListener('click', () => {
  const today = new Date();
  displayedMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  setSelectedDate(today);
});
document.querySelector('.sidebar-today-button')?.addEventListener('click', () => {
  const today = new Date();
  displayedMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  setSelectedDate(today);
});
document.querySelector('.calendar-list')?.addEventListener('change', (event) => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  if (checkbox.checked) visibleCalendars.add(checkbox.value);
  else visibleCalendars.delete(checkbox.value);
  renderMonthCalendar();
  renderCalendar();
});
document.querySelector('.mini-calendar-days')?.addEventListener('click', (event) => {
  const dayButton = event.target.closest('[data-mini-date]');
  if (!dayButton) return;
  const [year, month, day] = dayButton.dataset.miniDate.split('-').map(Number);
  displayedMonth = new Date(year, month - 1, 1);
  setSelectedDate(new Date(year, month - 1, day, 12));
  document.body.classList.remove('sidebar-open');
});
function openCalendarDate(date, createWhenEmpty = true) {
  const [year, month, day] = date.split('-').map(Number);
  const selected = new Date(year, month - 1, day, 12);
  setSelectedDate(selected);
  const hasEvents = eventsForDate(date).length > 0;
  if (hasEvents) {
    if (window.matchMedia('(max-width: 680px)').matches) {
      document.querySelector('.mobile-selected-day')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      showView('day-detail');
    }
    return;
  }
  if (createWhenEmpty) openEventFormModal('create', null, date);
}

document.querySelector('.calendar-view-content')?.addEventListener('click', (event) => {
  if (Date.now() < suppressCalendarClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const eventBadge = event.target.closest('[data-edit-event]');
  if (eventBadge) {
    event.stopPropagation();
    const item = allEvents().find((saved) => saved.id === eventBadge.dataset.editEvent);
    if (item) openEventFormModal('edit', item);
    return;
  }
  const dateButton = event.target.closest('[data-select-date]');
  if (dateButton) {
    const [year, month, day] = dateButton.dataset.selectDate.split('-').map(Number);
    setSelectedDate(new Date(year, month - 1, day, 12));
    if (!window.matchMedia('(max-width: 680px)').matches) showView('day-detail');
    return;
  }
  const createButton = event.target.closest('[data-create-date]');
  if (createButton) {
    openEventFormModal('create', null, createButton.dataset.createDate);
    return;
  }
  const dayCell = event.target.closest('[data-calendar-date]');
  if (dayCell) openCalendarDate(dayCell.dataset.calendarDate);
});
document.querySelector('.mobile-selected-day')?.addEventListener('click', (event) => {
  const badge = event.target.closest('[data-edit-event]');
  if (badge) {
    const item = allEvents().find((saved) => saved.id === badge.dataset.editEvent);
    if (item) openEventFormModal('edit', item);
    return;
  }
  if (event.target.closest('.mobile-add-selected-event')) {
    openEventFormModal('create', null, localDateString(selectedDate));
  } else if (event.target.closest('.mobile-day-detail-button')) {
    showView('day-detail');
  }
});
document.querySelector('.calendar-view-content')?.addEventListener('keydown', (event) => {
  const dayCell = event.target.closest('.calendar-day-cell');
  if (dayCell && event.target === dayCell && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openCalendarDate(dayCell.dataset.calendarDate);
  }
});
document.querySelector('.create-event-button')?.addEventListener('click', () => {
  document.body.classList.remove('sidebar-open');
  openEventFormModal('create');
});
document.querySelector('.mobile-create-event-button')?.addEventListener('click', () => {
  openEventFormModal('create', null, localDateString(selectedDate));
});
document.querySelector('.calendar-menu-button')?.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
document.querySelector('.sidebar-scrim')?.addEventListener('click', () => document.body.classList.remove('sidebar-open'));

  function loadSavedEvents() {
    const events = readStoredValue(EVENTS_STORAGE_KEY, []);
    return Array.isArray(events) ? events : [];
  }

  // 이 기기에 저장한 내 일정 + 가족 공유 일정
  function allEvents() {
    return [...loadSavedEvents(), ...(window.MapDuleFamily?.events() || [])];
  }

  function saveEvents(events) {
    try {
      localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(events));
      return true;
    } catch {
      showToast('일정을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.', 'info');
      return false;
    }
  }

  function involvesMe(item) {
    if (item.source !== 'family' && item.calendarId !== 'family') return true;
    const me = window.MapDuleFamily?.me();
    return !item.participants?.length || !me || item.participants.includes(me);
  }

  function findTimeConflictIn(list, candidate, ignoredId = null) {
    if (candidate.allDay || !involvesMe(candidate)) return null;
    return list.find((item) => item.id !== ignoredId
      && !item.allDay
      && involvesMe(item)
      && item.date === candidate.date
      && candidate.startTime < item.endTime
      && candidate.endTime > item.startTime) || null;
  }

  function findTimeConflict(candidate, ignoredId = null) {
    return findTimeConflictIn(allEvents(), candidate, ignoredId);
  }

  function downloadFile(filename, content, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function escapeICSText(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function toICSDate(date, time) {
    return `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
  }

  function renderCalendar() {
    void window.MapDulePush?.reconcile(allEvents());
    const timeline = document.querySelector('.timeline');
    if (!timeline) return;
    const date = localDateString(selectedDate);
    const events = allEvents()
      .filter((item) => item.date === date && visibleCalendars.has(calendarIdForEvent(item)))
      .sort((first, second) => (first.allDay ? '' : first.startTime).localeCompare(second.allDay ? '' : second.startTime));

    if (!events.length) {
      timeline.innerHTML = `
        <div class="empty-state panel">
          <span class="material-symbols-rounded">calendar_add_on</span>
          <h2>등록된 일정이 없어요</h2>
          <p>선택한 날짜에 일정을 추가해 보세요.</p>
          <button class="primary-cta add-event-button" type="button"><span class="material-symbols-rounded">add</span>일정 등록</button>
        </div>
      `;
      window.MapDuleFamily?.updateDayMap();
      return;
    }

    timeline.innerHTML = events.map((item) => {
      const group = calendarGroups.find((candidate) => candidate.id === calendarIdForEvent(item)) || calendarGroups[0];
      const ended = eventHasEnded(item);
      return `
      <article class="timeline-row saved-event ${ended ? 'is-ended' : ''}">
        <div class="time-node"><b style="--calendar-color:${group.color}"><span class="material-symbols-rounded">${item.source === 'family' ? 'family_restroom' : 'event'}</span></b><time>${item.allDay ? '종일' : escapeHtml(item.startTime)}</time></div>
        <div class="event-card panel">
          <div class="card-meta"><span class="tag calendar-tag" style="--calendar-color:${group.color}">${escapeHtml(group.name)}</span><div class="event-actions"><button class="event-edit" type="button" data-edit-event="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 수정"><span class="material-symbols-rounded">edit</span></button><button class="event-delete" type="button" data-delete-event="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 삭제"><span class="material-symbols-rounded">delete</span></button></div></div>
          <h2 class="${ended ? 'event-title-ended' : ''}">${escapeHtml(item.title)}</h2>
          <p class="event-time"><span class="material-symbols-rounded">schedule</span>${item.allDay ? '종일' : `${escapeHtml(item.startTime)} - ${escapeHtml(item.endTime)}`}</p>
          ${item.location ? `<p><span class="material-symbols-rounded">location_on</span>${escapeHtml(item.location)}</p>` : ''}
          ${item.notes ? `<p class="event-notes">${escapeHtml(item.notes)}</p>` : ''}
          ${window.MapDuleFamily?.eventExtrasHtml(item) || ''}
        </div>
      </article>
    `;
    }).join('');
    window.MapDuleFamily?.updateDayMap();
  }

  async function analyzeSelectedDayPlan(event) {
    const button = event.currentTarget;
    const panel = document.querySelector('#ai-plan-result');
    const date = localDateString(selectedDate);
    const events = eventsForDate(date);
    if (!events.length) {
      panel.hidden = false;
      panel.innerHTML = '<p class="ai-plan-empty">선택한 날짜에 분석할 일정이 없습니다. 먼저 일정을 등록해 주세요.</p>';
      return;
    }

    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    panel.hidden = false;
    panel.innerHTML = '<div class="ai-plan-loading"><span class="material-symbols-rounded">progress_activity</span><span>장소 위치를 확인하고 일정 간격과 이동 여유를 계산하고 있어요.</span></div>';
    try {
      const profile = readStoredValue(PROFILE_STORAGE_KEY, {});
      const planEvents = await fillMissingPlaces(events);
      const response = await fetchWithTimeout('/api/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          transportMode: ['walk', 'transit', 'car'].includes(profile.transportMode) ? profile.transportMode : 'transit',
          events: planEvents.map((item) => ({
            id: item.id,
            title: item.title,
            date: item.date,
            startTime: item.startTime,
            endTime: item.endTime,
            allDay: item.allDay === true,
            location: item.location || '',
            place: item.place || null
          }))
        })
      });
      const result = await readAiResponse(response);

      const statusLabels = { ok: '이동 여유 있음', 'short-buffer': '여유 15분 미만', tight: '이동 시간 부족', conflict: '일정 시간 겹침', unknown: '이동 거리 미계산' };
      const transitions = Array.isArray(result.transitions) ? result.transitions : [];
      const recommendations = Array.isArray(result.recommendations) ? result.recommendations : [];
      const assumptions = Array.isArray(result.assumptions) ? result.assumptions : [];
      const distanceLabel = (meters) => meters === null ? '좌표 미등록' : meters < 1000 ? `${Math.round(meters)}m 직선거리` : `${(meters / 1000).toFixed(1)}km 직선거리`;
      const transitionMarkup = transitions.map((item) => {
        const gapLabel = item.gapMinutes < 0 ? `일정이 ${Math.abs(item.gapMinutes)}분 겹쳐요` : `일정 사이 ${item.gapMinutes}분`;
        const travelLabel = item.travelMinutes === null
          ? '위치가 없어 이동 시간은 계산하지 않았어요. 일정 장소를 검색해 선택해 주세요.'
          : `이동 ${item.travelMinutes}분 ${escapeHtml(({ 'kakao-mobility': '카카오 자동차 경로', 'odsay-walk': 'ODsay 도보 경로', 'odsay-transit': 'ODsay 대중교통 경로' })[item.routeSource] || '추정')} · ${item.bufferMinutes < 0 ? `약 ${Math.abs(item.bufferMinutes)}분 부족` : `이동 후 ${item.bufferMinutes}분 여유`}${item.recommendedDepartureTime ? ` · 권장 출발 ${escapeHtml(item.recommendedDepartureTime)}` : ''}`;
        const details = [distanceLabel(item.straightLineDistanceMeters), item.reason];
        if (Number.isFinite(item.walkingMinutes)) details.push(`도보 ${item.walkingMinutes}분`);
        if (Number.isFinite(item.transferCount)) details.push(`환승 ${item.transferCount}회`);
        if (item.dataUpdatedAt && Number.isFinite(Date.parse(item.dataUpdatedAt))) details.push(`조회 ${new Date(item.dataUpdatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`);
        if (item.fallbackReason) details.push(item.fallbackReason === 'not-configured' ? '경로 API 미설정' : '경로 조회 실패·미지원 구간');
        return `<article class="ai-plan-transition ${escapeHtml(item.status)}"><header><b>${escapeHtml(item.fromTitle)} → ${escapeHtml(item.toTitle)}</b><span>${escapeHtml(statusLabels[item.status] || '확인 필요')}</span></header><p>${gapLabel} · ${travelLabel}</p><small>${details.map((detail) => escapeHtml(detail)).join(' · ')}</small></article>`;
      }).join('');
      const reminderTargets = upcomingDepartures(date, transitions);
      panel.innerHTML = `
        <header class="ai-plan-result-header"><div><span class="ai-plan-eyebrow">${result.aiSummary ? 'AZURE OPENAI 일정 분석' : '일정 계산'}</span><h2>${escapeHtml(date)} 일정 계산</h2></div><span class="material-symbols-rounded">task_alt</span></header>
        <p class="ai-plan-summary">${escapeHtml(result.summary || '계산 결과를 확인해 주세요.')}</p>
        ${result.aiNotice ? `<p class="ai-plan-assumptions">${escapeHtml(result.aiNotice)}</p>` : ''}
        ${transitions.length ? `<div class="ai-plan-transitions">${transitionMarkup}</div>` : '<p class="ai-plan-empty">시간이 정해진 일정이 2개 이상 있어야 일정 간 이동 여유를 계산할 수 있어요.</p>'}
        ${recommendations.length ? `<section class="ai-plan-recommendations"><h3>추천</h3><ul>${recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : ''}
        ${reminderTargets.length ? '<section class="ai-plan-recommendations"><h3>출발 알림</h3><button class="link-button" id="enable-departure-reminders" type="button"><span class="material-symbols-rounded">notifications_active</span>출발 시각에 알려 주세요</button><button class="link-button" id="disable-departure-reminders" type="button"><span class="material-symbols-rounded">notifications_off</span>알림 끄기</button><p class="ai-plan-assumptions" id="departure-reminder-status" role="status" aria-live="polite">알림 방식은 브라우저 권한과 서버 설정에 따라 달라집니다.</p></section>' : ''}
        ${assumptions.length ? `<p class="ai-plan-assumptions">${assumptions.map((item) => escapeHtml(item)).join(' · ')}</p>` : ''}
      `;
      panel.querySelector('#enable-departure-reminders')?.addEventListener('click', async (event) => {
        const control = event.currentTarget;
        control.disabled = true;
        try { await enableDepartureReminders(date, transitions, panel.querySelector('#departure-reminder-status')); }
        finally { control.disabled = false; }
      });
      panel.querySelector('#disable-departure-reminders')?.addEventListener('click', () => disableDepartureReminders(panel.querySelector('#departure-reminder-status')));
    } catch (error) {
      panel.innerHTML = `<div class="ai-plan-error"><b>일정을 계산하지 못했어요.</b><p>${escapeHtml(error.message || '서버 연결 상태를 확인해 주세요.')}</p><button class="link-button" id="retry-day-plan" type="button"><span class="material-symbols-rounded">refresh</span>다시 계산</button></div>`;
      panel.querySelector('#retry-day-plan')?.addEventListener('click', () => document.querySelector('#analyze-day-plan')?.click());
      if (error.code === 'AI_LOGIN_REQUIRED') appendAiSignInLink(panel.querySelector('.ai-plan-error'), 'day-detail');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function fillMissingPlaces(events) {
    const geocode = window.MapDuleFamily?.geocode;
    if (typeof geocode !== 'function') return events;
    const missing = events.filter((item) => !item.allDay && !item.place && item.location);
    const found = new Map();
    await Promise.all(missing.map(async (item) => {
      try {
        const place = await geocode(item.location);
        if (place) found.set(item.id, place);
      } catch {
        // 위치를 찾지 못한 일정은 이동 시간 없이 계산한다.
      }
    }));
    if (!found.size) return events;
    const saved = loadSavedEvents();
    if (saved.some((item) => found.has(item.id))) {
      saveEvents(saved.map((item) => found.has(item.id) && !item.place ? { ...item, place: found.get(item.id) } : item));
    }
    return events.map((item) => found.has(item.id) ? { ...item, place: found.get(item.id) } : item);
  }

  const DEPARTURE_REMINDER_KEY = 'mapdule-departure-reminders';

  function departureEventFingerprint(event) {
    return event ? JSON.stringify([event.date, event.startTime, event.endTime, event.title, event.location,
      event.place?.lat, event.place?.lng, event.allDay, event.participants]) : null;
  }

  async function disableDepartureReminders(statusElement) {
    try {
      localStorage.removeItem(DEPARTURE_REMINDER_KEY);
      await window.MapDulePush?.cancel();
      statusElement.textContent = '이 기기의 출발 알림을 껐어요.';
    } catch {
      statusElement.textContent = '탭 알림은 껐지만 서버 예약 취소에 실패했어요. 연결을 확인한 뒤 다시 눌러 주세요.';
    }
  }

  function clockToMinutes(value) {
    const [hours, minutes] = String(value).split(':').map(Number);
    return hours * 60 + minutes;
  }

  function notifyDeparture(title, body, tag) {
    if (document.visibilityState === 'visible') {
      showToast(`${title} ${body}`, 'info');
      return;
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, tag }); } catch {}
    }
  }

  function checkDepartureReminders() {
    const stored = readStoredValue(DEPARTURE_REMINDER_KEY, null);
    if (!stored || stored.date !== localDateString(new Date()) || !Array.isArray(stored.items) || stored.background) return;
    const events = allEvents();
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    let changed = false;
    for (const item of stored.items) {
      if (item.fingerprints?.some(([id, previous]) => previous !== departureEventFingerprint(events.find((event) => event.id === id)))) {
        item.departed = item.lateWarned = true;
        changed = true;
        continue;
      }
      const start = clockToMinutes(item.startTime);
      const latestDeparture = start - item.travelMinutes;
      if (minutes >= start) {
        if (!item.departed || !item.lateWarned) { item.departed = item.lateWarned = true; changed = true; }
      } else if (!item.lateWarned && minutes >= latestDeparture) {
        item.departed = item.lateWarned = true;
        changed = true;
        notifyDeparture('지금 출발해야 늦지 않아요.', `${item.title}까지 이동 약 ${item.travelMinutes}분, ${item.startTime} 시작이에요.`, `late-${item.id}`);
      } else if (!item.departed && minutes >= clockToMinutes(item.departAt)) {
        item.departed = true;
        changed = true;
        notifyDeparture('출발할 시간이에요.', `${item.title}까지 이동 약 ${item.travelMinutes}분, ${item.startTime} 시작이에요.`, `depart-${item.id}`);
      }
    }
    if (changed) {
      try { localStorage.setItem(DEPARTURE_REMINDER_KEY, JSON.stringify(stored)); } catch {}
    }
  }

  function upcomingDepartures(date, transitions) {
    if (date !== localDateString(new Date())) return [];
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return transitions.filter((item) => item.status !== 'conflict'
      && item.recommendedDepartureTime
      && clockToMinutes(item.nextStartTime) > minutes);
  }

  async function enableDepartureReminders(date, transitions, statusElement) {
    const targets = upcomingDepartures(date, transitions);
    if (!targets.length) {
      statusElement.textContent = '아직 지나지 않은 출발 시각이 없어요.';
      return;
    }
    const events = allEvents();
    const reminder = {
        date,
        items: targets.map((item) => ({
          id: item.toId,
          title: item.toTitle,
          startTime: item.nextStartTime,
          departAt: item.recommendedDepartureTime,
          travelMinutes: item.travelMinutes,
          fingerprints: [item.fromId, item.toId].map((id) => [id, departureEventFingerprint(events.find((event) => event.id === id))]),
          departed: false,
          lateWarned: false
        }))
    };
    try {
      localStorage.setItem(DEPARTURE_REMINDER_KEY, JSON.stringify(reminder));
    } catch {
      statusElement.textContent = '브라우저 저장 공간 문제로 출발 알림을 켜지 못했어요.';
      return;
    }
    let permission = 'unsupported';
    if ('Notification' in window) {
      permission = Notification.permission;
      if (permission === 'default') {
        try { permission = await Notification.requestPermission(); } catch { permission = 'default'; }
      }
    }
    const count = `출발 알림 ${targets.length}개를 켰어요.`;
    if (permission === 'granted' && window.MapDulePush) {
      statusElement.textContent = '닫힌 앱 알림을 연결하고 있어요.';
      try {
        if (await window.MapDulePush.schedule(date, targets, events)) {
          reminder.background = true;
          localStorage.setItem(DEPARTURE_REMINDER_KEY, JSON.stringify(reminder));
          statusElement.textContent = `${count} 서버에 푸시를 예약했어요. 네트워크·기기 절전 상태에 따라 늦거나 누락될 수 있어요.`;
          return;
        }
      } catch (error) {
        statusElement.textContent = `${count} 푸시 연결 실패: ${error.message || '서버 연결을 확인해 주세요.'} 이 탭이 열린 동안만 알려 드려요.`;
        checkDepartureReminders();
        return;
      }
    }
    statusElement.textContent = permission === 'granted'
      ? `${count} 이 탭이 열려 있는 동안 출발 시각에 알려 드려요. 탭을 닫으면 알림이 오지 않아요.`
      : `${count} 브라우저 알림이 꺼져 있어 앱 화면이 열려 있을 때만 알려 드려요. 알림을 받으려면 주소창의 사이트 정보에서 알림을 허용해 주세요.`;
    checkDepartureReminders();
  }

  setInterval(checkDepartureReminders, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkDepartureReminders();
      void window.MapDulePush?.reconcile(allEvents());
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === EVENTS_STORAGE_KEY) {
      checkDepartureReminders();
      void window.MapDulePush?.reconcile(allEvents());
    }
  });

  document.querySelector('.timeline')?.addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit-event]');
    if (editButton) {
      const existing = allEvents().find((item) => item.id === editButton.dataset.editEvent);
      if (!existing) return;
      openEventFormModal('edit', existing);
      return;
    }

    const deleteButton = event.target.closest('[data-delete-event]');
    if (!deleteButton) return;
    const item = allEvents().find((saved) => saved.id === deleteButton.dataset.deleteEvent);
    if (item) deleteEventWithConfirm(item);
  });

  const manualEventForm = document.querySelector('#manual-event-form');
  const endTimeInput = manualEventForm.elements.endTime;
  [manualEventForm.elements.startTime, endTimeInput].forEach((input) => {
    input.addEventListener('input', () => endTimeInput.setCustomValidity(''));
  });
  manualEventForm.elements.title.addEventListener('input', () => manualEventForm.elements.title.setCustomValidity(''));
  manualEventForm.elements.date.value = localDateString(selectedDate);
  document.querySelector('.detail-add-event-button')?.addEventListener('click', () => openEventFormModal('create'));
  document.querySelector('.timeline')?.addEventListener('click', (event) => {
    if (event.target.closest('.add-event-button')) openEventFormModal('create');
  });
  manualEventForm.querySelector('.cancel-edit').addEventListener('click', () => {
    editingEventId = null;
    manualEventForm.reset();
    manualEventForm.elements.date.value = localDateString(selectedDate);
    manualEventForm.querySelector('[type="submit"]').innerHTML = '<span class="material-symbols-rounded">calendar_add_on</span>캘린더에 추가';
    manualEventForm.querySelector('.cancel-edit').classList.add('hidden');
  });

  manualEventForm.addEventListener('submit', (event) => {
    event.preventDefault();
    manualEventForm.elements.title.setCustomValidity(manualEventForm.elements.title.value.trim() ? '' : '일정 제목을 입력해 주세요.');
    if (!manualEventForm.reportValidity()) return;

    const formData = new FormData(manualEventForm);
    const startTime = String(formData.get('startTime'));
    const endTime = String(formData.get('endTime'));
    if (endTime <= startTime) {
      endTimeInput.setCustomValidity('종료 시간은 시작 시간보다 늦어야 합니다.');
      endTimeInput.reportValidity();
      return;
    }

    const newEvent = {
      id: editingEventId || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: String(formData.get('title')).trim(),
      date: String(formData.get('date')),
      startTime,
      endTime,
      category: String(formData.get('category')),
      location: String(formData.get('location')).trim(),
      notes: String(formData.get('notes')).trim()
    };

    const conflict = findTimeConflict(newEvent, editingEventId);
    if (conflict && !confirm(`'${conflict.title}' 일정과 시간이 겹쳐요. 그래도 저장할까요?`)) return;

    const events = loadSavedEvents();
    const updatedEvents = editingEventId
      ? events.map((item) => item.id === editingEventId ? newEvent : item)
      : [...events, newEvent];
    if (!saveEvents(updatedEvents)) return;

    setSelectedDate(new Date(`${newEvent.date}T12:00:00`));
    const wasEditing = Boolean(editingEventId);
    editingEventId = null;
    manualEventForm.reset();
    manualEventForm.elements.date.value = newEvent.date;
    manualEventForm.querySelector('[type="submit"]').innerHTML = '<span class="material-symbols-rounded">calendar_add_on</span>캘린더에 추가';
    manualEventForm.querySelector('.cancel-edit').classList.add('hidden');
    showView('today');
    showToast(wasEditing ? '일정을 수정했습니다.' : '일정을 캘린더에 추가했습니다.', 'success');
  });

  setSelectedDate(selectedDate);

  document.querySelector('#export-ics').addEventListener('click', () => {
    const events = allEvents().sort((first, second) => `${first.date}${first.startTime}`.localeCompare(`${second.date}${second.startTime}`));
    if (!events.length) {
      showToast('내보낼 일정이 없습니다.');
      return;
    }
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//MapDule//Calendar Export//KO',
      'CALSCALE:GREGORIAN',
      'X-WR-TIMEZONE:Asia/Seoul'
    ];
    for (const item of events) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${escapeICSText(item.id)}@mapdule.local`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
        ...(item.allDay
          ? [`DTSTART;VALUE=DATE:${item.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${localDateString(new Date(new Date(`${item.date}T12:00:00`).getTime() + 86400000)).replace(/-/g, '')}`]
          : [`DTSTART;TZID=Asia/Seoul:${toICSDate(item.date, item.startTime)}`, `DTEND;TZID=Asia/Seoul:${toICSDate(item.date, item.endTime)}`]),
        `SUMMARY:${escapeICSText(item.title)}`
      );
      if (item.location) lines.push(`LOCATION:${escapeICSText(item.location)}`);
      if (item.notes) lines.push(`DESCRIPTION:${escapeICSText(item.notes)}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    downloadFile('mapdule-calendar.ics', `${lines.join('\r\n')}\r\n`, 'text/calendar;charset=utf-8');
    showToast('일정 파일을 내보냈습니다.', 'success');
  });

  document.querySelector('#export-backup').addEventListener('click', () => {
    const backup = {
      format: 'mapdule-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: readStoredValue(PROFILE_STORAGE_KEY, {}),
      events: loadSavedEvents()
    };
    downloadFile('mapdule-backup.json', JSON.stringify(backup, null, 2), 'application/json;charset=utf-8');
    showToast('프로필과 일정을 백업했습니다.', 'success');
  });

  document.querySelector('#import-backup').addEventListener('click', () => document.querySelector('#backup-file').click());
  document.querySelector('#backup-file').addEventListener('change', async (event) => {
    const fileInput = event.currentTarget;
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const backup = parseCalendarBackup(await file.text());
      const imported = backup.events;
      showModal('백업 복원', `<p>${imported.length}개 일정을 현재 일정에 합칩니다.</p><p class="modal-note">같은 일정 ID는 백업 데이터로 갱신됩니다.</p>`, '복원', () => {
        const merged = new Map(loadSavedEvents().map((item) => [item.id, item]));
        imported.forEach((item) => merged.set(item.id, item));
        if (!saveEvents([...merged.values()])) return false;
        let profileRestored = true;
        if (backup.profile && typeof backup.profile === 'object' && !Array.isArray(backup.profile)) {
          try {
            localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(backup.profile));
            renderProfileAvatar(backup.profile);
          } catch {
            profileRestored = false;
          }
        }
        setSelectedDate(selectedDate);
        showToast(profileRestored ? '백업을 복원했습니다.' : '일정은 복원했지만 프로필 저장에는 실패했습니다.', profileRestored ? 'success' : 'info');
        return true;
      });
    } catch (error) {
      showToast(error.message || '백업 파일을 읽지 못했습니다.', 'info');
    } finally {
      fileInput.value = '';
    }
  });

  document.querySelector('#clear-local-data').addEventListener('click', () => {
    showModal('저장 데이터 삭제', '<p>이 브라우저에 저장된 일정과 프로필을 모두 삭제할까요?</p><p class="modal-note">삭제한 데이터는 복구할 수 없습니다. 먼저 JSON 백업을 권장합니다.</p>', '모두 삭제', () => {
      try {
        localStorage.removeItem(EVENTS_STORAGE_KEY);
        localStorage.removeItem(PROFILE_STORAGE_KEY);
      } catch {
        showToast('저장 데이터를 삭제할 수 없습니다.', 'info');
        return false;
      }
      editingEventId = null;
      manualEventForm.reset();
      manualEventForm.elements.date.value = localDateString(selectedDate);
      manualEventForm.querySelector('[type="submit"]').innerHTML = '<span class="material-symbols-rounded">calendar_add_on</span>캘린더에 추가';
      manualEventForm.querySelector('.cancel-edit').classList.add('hidden');
      renderProfileAvatar({});
      setSelectedDate(selectedDate);
      showToast('일정과 프로필을 삭제했습니다.');
      return true;
    });
  });

  document.querySelector('.sync-button')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!window.MapDuleFamily?.isJoined()) {
    showToast('가족에 참여하면 가족 일정과 이동 상황을 새로 받아올 수 있어요.', 'info');
    showView('family');
    return;
  }
  button.disabled = true;
  button.innerHTML = '<span class="material-symbols-rounded">sync</span>받아오는 중';
  const result = await window.MapDuleFamily.refresh({ quiet: false });
  button.disabled = false;
  button.innerHTML = `<span class="material-symbols-rounded">${result ? 'check' : 'sync_problem'}</span>${result ? '새로고침 완료' : '연결 실패'}`;
  setTimeout(() => {
    button.innerHTML = '<span class="material-symbols-rounded">sync</span>가족 새로고침';
  }, 1800);
});

document.querySelector('.map-location-button')?.addEventListener('click', showCurrentLocation);

function setAiAnalysisMessage(message, tone = '') {
  const status = document.querySelector('#ai-analysis-message');
  if (!status) return;
  status.textContent = message;
  status.className = `ai-analysis-message${tone ? ` ${tone}` : ''}`;
}

async function refreshAzureOpenAiStatus() {
  const badge = document.querySelector('#azure-ai-status');
  if (!badge) return;
  try {
    const response = await fetch('/api/ai/status');
    const status = await readAiResponse(response);
    if (!status.configured) {
      badge.textContent = '서버 설정 필요';
      badge.className = 'tag slate';
      setAiAnalysisMessage('Azure OpenAI 서버 설정이 필요합니다. 로컬은 .env, 배포 사이트는 Azure Static Web Apps의 애플리케이션 설정에 endpoint, API key, deployment를 등록해 주세요.');
      return;
    }

    if (status.authRequired) {
      const identityResponse = await fetch('/.auth/me');
      const identity = await readAiResponse(identityResponse);
      const authenticated = identity?.clientPrincipal?.userRoles?.includes('authenticated');
      if (!authenticated) {
        badge.textContent = '로그인 필요';
        badge.className = 'tag slate';
        const message = document.querySelector('#ai-analysis-message');
        setAiAnalysisMessage('AI 일정 분석은 로그인한 사용자만 사용할 수 있습니다.');
        appendAiSignInLink(message);
        return;
      }

      const message = document.querySelector('#ai-analysis-message');
      setAiAnalysisMessage('로그인 상태입니다.');
      const signOutLink = document.createElement('a');
      signOutLink.href = '/.auth/logout?post_logout_redirect_uri=%2F';
      signOutLink.textContent = '로그아웃';
      message?.append(' ', signOutLink);
    }

    badge.textContent = 'Azure OpenAI 준비됨';
    badge.className = 'tag mint';
  } catch (error) {
    badge.textContent = 'AI 서버 연결 안 됨';
    badge.className = 'tag coral';
    setAiAnalysisMessage(error.message || 'AI 서버에 연결할 수 없습니다.', 'error');
    if (error.code === 'AI_LOGIN_REQUIRED') appendAiSignInLink(document.querySelector('#ai-analysis-message'));
  }
}

refreshAzureOpenAiStatus();

document.querySelector('#schedule-prompt')?.addEventListener('input', () => {
  aiPromptRevision += 1;
  analyzedScheduleEvents = [];
  const registerButton = document.querySelector('#ai .primary-cta');
  registerButton.disabled = true;
  registerButton.textContent = '다시 분석한 뒤 등록해 주세요';
  document.querySelector('.section-title small').textContent = '일정 분석 후 표시됩니다';
  document.querySelector('.ai-stack').innerHTML = '<div class="empty-state panel"><span class="material-symbols-rounded">event_note</span><h2>일정을 다시 분석해 주세요</h2><p>수정한 문장으로 분석하면 새 미리보기가 표시됩니다.</p></div>';
  setAiAnalysisMessage('문장을 수정했어요. 다시 분석한 뒤 등록해 주세요.');
});

document.querySelector('#analyze-prompt')?.addEventListener('click', async (event) => {
  const promptInput = document.querySelector('#schedule-prompt');
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setAiAnalysisMessage('먼저 분석할 일정 문장을 입력해 주세요.', 'error');
    promptInput.focus();
    return;
  }

  const button = event.currentTarget;
  const promptRevision = aiPromptRevision;
  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="material-symbols-rounded">progress_activity</span>일정 분석 중';
  setAiAnalysisMessage('AI가 문장에서 일정을 찾고 있습니다.');
  analyzedScheduleEvents = [];
  const registerButton = document.querySelector('#ai .primary-cta');
  registerButton.disabled = true;
  registerButton.textContent = '분석된 일정이 없습니다';
  document.querySelector('.ai-stack').innerHTML = '<div class="empty-state panel"><span class="material-symbols-rounded">hourglass_top</span><h2>일정을 분석하고 있어요</h2><p>잠시만 기다려 주세요.</p></div>';

  try {
    const response = await fetch('/api/ai/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const result = await readAiResponse(response);
    if (promptRevision !== aiPromptRevision) return;
    if (!Array.isArray(result.events) || result.events.length === 0) {
      throw new Error('문장에서 등록할 일정을 찾지 못했습니다. 날짜와 할 일을 포함해 다시 입력해 주세요.');
    }

    analyzedScheduleEvents = result.events;
    document.querySelector('.ai-stack').innerHTML = `
      ${result.events.map((item) => `
        <article class="ai-preview-event panel">
          <span class="ai-preview-dot" data-category="${escapeHtml(item.category)}"></span>
          <div><span class="ai-preview-date">${escapeHtml(item.date)} · ${item.allDay ? '종일' : `${escapeHtml(item.startTime)}-${escapeHtml(item.endTime)}`}</span><h3>${escapeHtml(item.title)}</h3>
          ${item.location ? `<p><span class="material-symbols-rounded">location_on</span>${escapeHtml(item.location)}</p>` : ''}
          ${item.notes ? `<small>${escapeHtml(item.notes)}</small>` : ''}</div>
          <span class="tag indigo">${escapeHtml(item.category)}</span>
        </article>
      `).join('')}
      ${result.assumptions?.length ? `<p class="ai-assumptions">분석 참고: ${result.assumptions.map(escapeHtml).join(' · ')}</p>` : ''}
    `;
    document.querySelector('.section-title small').textContent = `분석된 일정 ${result.events.length}개`;
    registerButton.disabled = false;
    registerButton.innerHTML = `<span class="material-symbols-rounded">calendar_add_on</span>분석된 일정 ${result.events.length}개 등록`;
    setAiAnalysisMessage('분석한 일정을 확인한 뒤 캘린더에 등록해 주세요.', 'success');
  } catch (error) {
    if (promptRevision !== aiPromptRevision) return;
    document.querySelector('.ai-stack').innerHTML = `
      <div class="empty-state panel"><span class="material-symbols-rounded">error_outline</span><h2>일정을 분석하지 못했어요</h2><p>${escapeHtml(error.message || 'Azure OpenAI 연결 상태를 확인해 주세요.')}</p><button class="link-button" type="button" data-manual-fallback><span class="material-symbols-rounded">edit_calendar</span>직접 입력으로 등록</button></div>
    `;
    document.querySelector('[data-manual-fallback]')?.addEventListener('click', () => openEventFormModal('create', null, localDateString(selectedDate)));
    document.querySelector('.section-title small').textContent = '분석 실패';
    setAiAnalysisMessage(error.message || '일정 분석에 실패했습니다.', 'error');
    if (error.code === 'AI_LOGIN_REQUIRED') {
      const badge = document.querySelector('#azure-ai-status');
      badge.textContent = '로그인 필요';
      badge.className = 'tag slate';
      appendAiSignInLink(document.querySelector('#ai-analysis-message'));
      appendAiSignInLink(document.querySelector('.ai-stack .empty-state p'));
    }
    showToast(error.message || '일정 분석에 실패했습니다.', 'info');
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
});

document.querySelector('#ai .primary-cta')?.addEventListener('click', () => {
  if (!analyzedScheduleEvents.length) {
    showToast('먼저 AI로 일정을 분석해 주세요.', 'info');
    return;
  }
  const categoryCalendars = { 약속: 'personal', 업무: 'work', 운동: 'health', 개인: 'personal', 기타: 'other' };
  const savedEvents = loadSavedEvents();
  const newEvents = analyzedScheduleEvents.map((item) => ({
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...item,
    calendarId: categoryCalendars[item.category] || 'other'
  }));
  const staged = [];
  for (const item of newEvents) {
    const conflict = findTimeConflictIn([...allEvents(), ...staged], item);
    if (conflict && !confirm(`'${item.title}' 일정이 '${conflict.title}' 일정과 겹쳐요. 그래도 등록할까요?`)) return;
    staged.push(item);
  }
  if (!saveEvents([...savedEvents, ...newEvents])) return;
  analyzedScheduleEvents = [];
  document.querySelector('#ai .primary-cta').disabled = true;
  document.querySelector('#ai .primary-cta').textContent = '분석된 일정이 없습니다';
  document.querySelector('.section-title small').textContent = '일정 분석 후 표시됩니다';
  document.querySelector('.ai-stack').innerHTML = `
    <div class="empty-state panel"><span class="material-symbols-rounded">event_note</span><h2>분석된 일정이 없습니다</h2><p>일정 문장을 입력해 주세요. 분석 결과를 확인하고 캘린더에 등록할 수 있습니다.</p></div>
  `;
  const firstDate = newEvents[0].date;
  const [year, month, day] = firstDate.split('-').map(Number);
  displayedMonth = new Date(year, month - 1, 1);
  setSelectedDate(new Date(year, month - 1, day, 12));
  showView('today');
  showToast(`${newEvents.length}개 일정을 캘린더에 등록했습니다.`, 'success');
});

document.querySelector('.manual-link')?.addEventListener('click', () => showView('today'));

function openLinkedView() {
  const id = location.hash.slice(1);
  if (views.some((view) => view.id === id)) showView(id);
}
openLinkedView();
window.addEventListener('hashchange', openLinkedView);

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  renderMonthCalendar();
  if (document.querySelector('.view.active')?.id === 'day-detail') renderCalendar();
}, 60000);
