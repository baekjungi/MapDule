let views = [...document.querySelectorAll('.view')];
let navItems = [...document.querySelectorAll('.nav-item')];
const EVENTS_STORAGE_KEY = 'mapdule-events';
const PROFILE_STORAGE_KEY = 'mapdule-profile';
let editingEventId = null;
let kakaoMap = null;
let currentLocationMarker = null;
let displayedMonth = new Date();
let calendarViewMode = 'month';
let analyzedScheduleEvents = [];
const visibleCalendars = new Set(['personal', 'work', 'health', 'other']);
const calendarGroups = [
  { id: 'personal', name: '개인', color: '#6f70d7', categories: ['개인', '약속'] },
  { id: 'work', name: '업무', color: '#e4a13b', categories: ['업무'] },
  { id: 'health', name: '운동', color: '#38a77c', categories: ['운동'] },
  { id: 'other', name: '기타', color: '#c16fc3', categories: ['기타'] }
];

function readStoredValue(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
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
  const avatar = document.querySelector('.avatar');
  avatar.textContent = profile.name?.trim() ? profile.name.trim().slice(0, 1) : 'P';

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

  document.querySelector('.midpoint-hero h2').innerHTML = '출발 위치를 입력하면<br>중간지점을 찾아드려요';
  document.querySelector('.midpoint-hero p').textContent = '참가자들의 위치를 추가하면 이동 시간 비교가 시작됩니다.';
  document.querySelector('.demo-result').outerHTML = `
    <div class="empty-state panel"><span class="material-symbols-rounded">group_add</span><h2>아직 참가 위치가 없어요</h2><p>참가자의 출발 위치를 추가해 주세요.</p></div>
  `;

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
  document.querySelector('.ai-brief').before(manualView);

  views = [...document.querySelectorAll('.view')];
  navItems = [...document.querySelectorAll('.nav-item')];

  document.querySelector('.ai-brief small').textContent = '일정을 추가하면 이동 안내를 표시합니다.';
  const quickRoute = document.querySelector('.ai-brief button');
  quickRoute.textContent = '일정 추가';
  quickRoute.dataset.view = 'ai';

  return weekDates;
}

let weekDates = clearDemoContent();

function initializeKakaoMap() {
  const key = document.querySelector('meta[name="kakao-javascript-key"]')?.content.trim();
  const mapCanvas = document.querySelector('#kakao-map');
  const fallback = document.querySelector('.map-empty');
  if (!key || !mapCanvas || !fallback) return;

  const script = document.createElement('script');
  script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
  script.async = true;
  script.onload = () => {
    if (!window.kakao?.maps?.load) {
      fallback.innerHTML = '<span class="material-symbols-rounded">error</span><b>카카오 지도를 불러오지 못했어요</b><small>JavaScript 키와 허용 도메인을 확인해 주세요.</small>';
      return;
    }
    window.kakao.maps.load(() => {
      kakaoMap = new window.kakao.maps.Map(mapCanvas, {
        center: new window.kakao.maps.LatLng(37.5665, 126.978),
        level: 8
      });
      fallback.hidden = true;
    });
  };
  script.onerror = () => {
    fallback.innerHTML = '<span class="material-symbols-rounded">error</span><b>카카오 지도를 불러오지 못했어요</b><small>JavaScript 키와 허용 도메인을 확인해 주세요.</small>';
  };
  document.head.append(script);
}

initializeKakaoMap();

function showCurrentLocation() {
  if (!kakaoMap || !window.kakao?.maps) {
    showToast('카카오 지도가 아직 준비되지 않았습니다.', 'info');
    return;
  }
  if (!navigator.geolocation) {
    showToast('이 브라우저에서는 위치 기능을 사용할 수 없습니다.', 'info');
    return;
  }

  const locationButton = document.querySelector('.map-location-button');
  if (locationButton) locationButton.disabled = true;
  showToast('현재 위치 권한을 확인하고 있습니다.', 'info');

  navigator.geolocation.getCurrentPosition((position) => {
    const coords = new window.kakao.maps.LatLng(position.coords.latitude, position.coords.longitude);
    if (!currentLocationMarker) {
      currentLocationMarker = new window.kakao.maps.Marker({ position: coords, title: '현재 위치' });
    } else {
      currentLocationMarker.setPosition(coords);
    }
    currentLocationMarker.setMap(kakaoMap);
    kakaoMap.setLevel(4);
    kakaoMap.panTo(coords);
    if (locationButton) locationButton.disabled = false;
    document.querySelector('.status-pill').innerHTML = '<i></i>현재 위치 표시됨';
    showToast('현재 위치를 지도에 표시했습니다.', 'success');
  }, (error) => {
    const messages = {
      1: '위치 권한이 거부되었습니다. 브라우저 사이트 설정에서 위치를 허용해 주세요.',
      2: '현재 위치를 확인할 수 없습니다. GPS 신호를 확인해 주세요.',
      3: '위치 확인 시간이 초과됐습니다. 다시 시도해 주세요.'
    };
    if (locationButton) locationButton.disabled = false;
    showToast(messages[error.code] || '현재 위치를 가져오지 못했습니다.', 'info');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
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
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === id || (id === 'day-detail' && item.dataset.view === 'today')));
  document.body.classList.toggle('calendar-visible', id === 'today');
  document.body.classList.remove('sidebar-open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  showModal('알림 센터', '<p>새로운 이동 알림이 없습니다.</p><p class="modal-note">지각 위험이 감지되면 이곳에 가장 먼저 표시됩니다.</p>', '닫기');
});

document.querySelector('[aria-label="프로필"]')?.addEventListener('click', () => {
  const profile = readStoredValue(PROFILE_STORAGE_KEY, {});
  const transportMode = ['walk', 'transit', 'car'].includes(profile.transportMode) ? profile.transportMode : 'transit';
  showModal('프로필 설정', `
    <form id="profile-form" class="profile-form">
      <label class="modal-field">표시 이름<input name="name" type="text" maxlength="40" value="${escapeHtml(profile.name || '')}" placeholder="이름" required></label>
      <label class="modal-field">집 위치<input name="home" type="text" maxlength="120" value="${escapeHtml(profile.home || '')}" placeholder="집 위치 (선택)"></label>
      <label class="modal-field">기본 이동 수단<select name="transportMode"><option value="transit" ${transportMode === 'transit' ? 'selected' : ''}>대중교통</option><option value="walk" ${transportMode === 'walk' ? 'selected' : ''}>도보</option><option value="car" ${transportMode === 'car' ? 'selected' : ''}>자동차</option></select></label>
      <p class="modal-note">설정은 이 브라우저에만 저장됩니다.</p>
    </form>`, '저장', (modal) => {
    const form = modal.querySelector('#profile-form');
    if (!form.reportValidity()) return false;
    const formData = new FormData(form);
    const updatedProfile = {
      name: String(formData.get('name')).trim(),
      home: String(formData.get('home')).trim(),
      transportMode: String(formData.get('transportMode'))
    };
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(updatedProfile));
    } catch {
      showToast('브라우저 저장 공간에 접근할 수 없습니다.', 'info');
      return false;
    }
    document.querySelector('.avatar').textContent = updatedProfile.name.slice(0, 1);
    showToast('프로필을 저장했습니다.', 'success');
    return true;
  });
});

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
    const hasEvents = loadSavedEvents().some((item) => item.date === iso);
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
  const selectedCalendar = isEditing ? calendarIdForEvent(existingEvent) : 'personal';
  const modal = document.createElement('div');
  modal.className = 'event-modal-backdrop';
  modal.innerHTML = `
    <section class="event-form-modal" role="dialog" aria-modal="true" aria-labelledby="event-modal-title">
      <header class="event-modal-header">
        <div><span class="event-modal-eyebrow">${isEditing ? 'EDIT EVENT' : 'NEW EVENT'}</span><h2 id="event-modal-title">${isEditing ? '일정 수정' : '새 일정'}</h2></div>
        <button type="button" class="event-modal-close" aria-label="닫기"><span class="material-symbols-rounded">close</span></button>
      </header>
      <form class="event-modal-form">
        <label class="event-form-field event-title-field"><span>제목</span><input name="title" type="text" maxlength="80" placeholder="일정 제목을 입력하세요" value="${escapeHtml(isEditing ? existingEvent.title : '')}" required autofocus></label>
        <label class="event-form-field"><span>날짜</span><input name="date" type="date" value="${escapeHtml(isEditing ? existingEvent.date : initialDate)}" required></label>
        <label class="event-all-day-field"><input name="allDay" type="checkbox" ${isEditing && existingEvent.allDay ? 'checked' : ''}><span class="event-checkmark"></span><span>종일</span></label>
        <div class="event-time-fields">
          <label class="event-form-field"><span>시작</span><input name="startTime" type="time" value="${escapeHtml(isEditing ? existingEvent.startTime || '09:00' : '09:00')}"></label>
          <span class="event-time-separator">—</span>
          <label class="event-form-field"><span>종료</span><input name="endTime" type="time" value="${escapeHtml(isEditing ? existingEvent.endTime || '10:00' : '10:00')}"></label>
        </div>
        <label class="event-form-field"><span>내 캘린더</span><select name="calendarId">${calendarGroups.map((group) => `<option value="${group.id}" ${selectedCalendar === group.id ? 'selected' : ''}>${group.name}</option>`).join('')}</select></label>
        <label class="event-form-field"><span>장소 <small>선택</small></span><input name="location" type="text" maxlength="120" placeholder="장소를 추가하세요" value="${escapeHtml(isEditing ? existingEvent.location || '' : '')}"></label>
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
  const close = () => {
    modal.remove();
    document.removeEventListener('keydown', handleEscape);
  };
  const handleEscape = (event) => {
    if (event.key === 'Escape') close();
  };
  const updateAllDayFields = () => {
    timeFields.forEach((input) => {
      input.disabled = form.elements.allDay.checked;
      input.required = !form.elements.allDay.checked;
    });
  };
  updateAllDayFields();
  form.elements.allDay.addEventListener('change', updateAllDayFields);
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.closest('.event-modal-close, .event-cancel-button')) close();
  });
  document.addEventListener('keydown', handleEscape);
  requestAnimationFrame(() => titleInput.focus());

  form.addEventListener('submit', (event) => {
    event.preventDefault();
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
    const conflict = findTimeConflict(savedEvent, isEditing ? existingEvent.id : null);
    if (conflict) {
      showToast(`다른 일정 '${conflict.title}'과 시간이 겹칩니다. 시간을 바꿔 주세요.`, 'info');
      return;
    }
    const savedEvents = loadSavedEvents();
    const updatedEvents = isEditing
      ? savedEvents.map((item) => item.id === existingEvent.id ? savedEvent : item)
      : [...savedEvents, savedEvent];
    if (!saveEvents(updatedEvents)) return;
    const [year, month, day] = savedEvent.date.split('-').map(Number);
    displayedMonth = new Date(year, month - 1, 1);
    close();
    setSelectedDate(new Date(year, month - 1, day, 12));
    showView('today');
    showToast(isEditing ? '일정을 수정했습니다.' : '일정을 등록했습니다.', 'success');
  });

  modal.querySelector('.event-delete-button')?.addEventListener('click', () => {
    const remaining = loadSavedEvents().filter((item) => item.id !== existingEvent.id);
    if (!saveEvents(remaining)) return;
    close();
    setSelectedDate(selectedDate);
    showToast('일정을 삭제했습니다.', 'success');
  });
}

function eventsForDate(date) {
  return loadSavedEvents()
    .filter((item) => item.date === date && visibleCalendars.has(calendarIdForEvent(item)))
    .sort((first, second) => (first.allDay ? '' : first.startTime).localeCompare(second.allDay ? '' : second.startTime));
}

function renderCalendarSidebar() {
  const list = document.querySelector('.calendar-list');
  if (list) {
    list.innerHTML = calendarGroups.map((group) => `
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

function renderEventBadge(item, compact = false) {
  const group = calendarGroups.find((candidate) => candidate.id === calendarIdForEvent(item));
  const time = item.allDay ? '종일' : item.startTime;
  return `<button type="button" class="event-badge${compact ? ' compact' : ''}" style="--calendar-color:${group.color}" data-edit-event="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 수정">
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
  const events = loadSavedEvents()
    .filter((item) => item.date >= monthStart && item.date <= monthEnd && visibleCalendars.has(calendarIdForEvent(item)))
    .sort((first, second) => `${first.date}${first.allDay ? '' : first.startTime}`.localeCompare(`${second.date}${second.allDay ? '' : second.startTime}`));
  if (!events.length) return '<div class="agenda-empty">이번 달에 등록된 일정이 없습니다.</div>';
  return `<div class="agenda-view">${events.map((item) => {
    const date = new Date(`${item.date}T12:00:00`);
    return `<article class="agenda-event-row"><time>${date.getDate()}일 <span>${['일', '월', '화', '수', '목', '금', '토'][date.getDay()]}</span></time>${renderEventBadge(item)}</article>`;
  }).join('')}</div>`;
}

function renderCalendarView() {
  const content = document.querySelector('.calendar-view-content');
  if (!content) return;
  const renderers = { month: renderMonthView, week: renderWeekView, day: renderDayView, agenda: renderAgendaView };
  content.innerHTML = renderers[calendarViewMode]();
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

document.querySelector('.main-month-prev')?.addEventListener('click', () => navigateCalendar(-1));
document.querySelector('.main-month-next')?.addEventListener('click', () => navigateCalendar(1));
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
  const eventBadge = event.target.closest('[data-edit-event]');
  if (eventBadge) {
    event.stopPropagation();
    const item = loadSavedEvents().find((saved) => saved.id === eventBadge.dataset.editEvent);
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
    const item = loadSavedEvents().find((saved) => saved.id === badge.dataset.editEvent);
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
  if (dayCell && (event.key === 'Enter' || event.key === ' ')) {
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

  function saveEvents(events) {
    try {
      localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(events));
      return true;
    } catch {
      showToast('일정을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.', 'info');
      return false;
    }
  }

  function findTimeConflict(candidate, ignoredId = null) {
    return loadSavedEvents().find((item) => item.id !== ignoredId
      && item.date === candidate.date
      && candidate.startTime < item.endTime
      && candidate.endTime > item.startTime);
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
    const timeline = document.querySelector('.timeline');
    if (!timeline) return;
    const date = localDateString(selectedDate);
    const events = loadSavedEvents()
      .filter((item) => item.date === date && visibleCalendars.has(calendarIdForEvent(item)))
      .sort((first, second) => first.startTime.localeCompare(second.startTime));

    if (!events.length) {
      timeline.innerHTML = `
        <div class="empty-state panel">
          <span class="material-symbols-rounded">calendar_add_on</span>
          <h2>등록된 일정이 없어요</h2>
          <p>선택한 날짜에 일정을 추가해 보세요.</p>
          <button class="primary-cta add-event-button" type="button"><span class="material-symbols-rounded">add</span>일정 등록</button>
        </div>
      `;
      return;
    }

    timeline.innerHTML = events.map((item) => `
      <article class="timeline-row saved-event">
        <div class="time-node"><b><span class="material-symbols-rounded">event</span></b><time>${escapeHtml(item.startTime)}</time></div>
        <div class="event-card panel">
          <div class="card-meta"><span class="tag indigo">${escapeHtml(item.category)}</span><div class="event-actions"><button class="event-edit" type="button" data-edit-event="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 수정"><span class="material-symbols-rounded">edit</span></button><button class="event-delete" type="button" data-delete-event="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 일정 삭제"><span class="material-symbols-rounded">delete</span></button></div></div>
          <h2>${escapeHtml(item.title)}</h2>
          <p class="event-time"><span class="material-symbols-rounded">schedule</span>${item.allDay ? '종일' : `${escapeHtml(item.startTime)} - ${escapeHtml(item.endTime)}`}</p>
          ${item.location ? `<p><span class="material-symbols-rounded">location_on</span>${escapeHtml(item.location)}</p>` : ''}
          ${item.notes ? `<p class="event-notes">${escapeHtml(item.notes)}</p>` : ''}
        </div>
      </article>
    `).join('');
  }

  document.querySelector('.timeline')?.addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit-event]');
    if (editButton) {
      const existing = loadSavedEvents().find((item) => item.id === editButton.dataset.editEvent);
      if (!existing) return;
      openEventFormModal('edit', existing);
      return;
    }

    const deleteButton = event.target.closest('[data-delete-event]');
    if (!deleteButton) return;
    const eventId = deleteButton.dataset.deleteEvent;
    const remainingEvents = loadSavedEvents().filter((item) => item.id !== eventId);
    try {
      if (!saveEvents(remainingEvents)) return;
    } catch {
      showToast('일정을 삭제하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.', 'info');
      return;
    }
    setSelectedDate(selectedDate);
    showToast('일정을 삭제했습니다.');
  });

  const manualEventForm = document.querySelector('#manual-event-form');
  const endTimeInput = manualEventForm.elements.endTime;
  endTimeInput.addEventListener('input', () => endTimeInput.setCustomValidity(''));
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
    if (conflict) {
      showToast(`다른 일정 '${conflict.title}'과 시간이 겹칩니다. 시간을 바꿔 주세요.`, 'info');
      return;
    }

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
    const events = loadSavedEvents().sort((first, second) => `${first.date}${first.startTime}`.localeCompare(`${second.date}${second.startTime}`));
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
        `DTSTART;TZID=Asia/Seoul:${toICSDate(item.date, item.startTime)}`,
        `DTEND;TZID=Asia/Seoul:${toICSDate(item.date, item.endTime)}`,
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
      const backup = JSON.parse(await file.text());
      if (backup.format !== 'mapdule-backup' || !Array.isArray(backup.events)) throw new Error('invalid backup');
      const imported = backup.events.filter((item) => item
        && typeof item.id === 'string'
        && typeof item.title === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(item.date)
        && /^\d{2}:\d{2}$/.test(item.startTime)
        && /^\d{2}:\d{2}$/.test(item.endTime));
      showModal('백업 복원', `<p>${imported.length}개 일정을 현재 일정에 합칩니다.</p><p class="modal-note">같은 일정 ID는 백업 데이터로 갱신됩니다.</p>`, '복원', () => {
        const merged = new Map(loadSavedEvents().map((item) => [item.id, item]));
        imported.forEach((item) => merged.set(item.id, item));
        if (!saveEvents([...merged.values()])) return false;
        if (backup.profile && typeof backup.profile === 'object' && !Array.isArray(backup.profile)) {
          try {
            localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(backup.profile));
          } catch {
            showToast('일정은 복원했지만 프로필 저장에는 실패했습니다.', 'info');
          }
        }
        setSelectedDate(selectedDate);
        showToast('백업을 복원했습니다.', 'success');
        return true;
      });
    } catch {
      showToast('올바른 MapDule 백업 파일이 아닙니다.', 'info');
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
      document.querySelector('.avatar').textContent = 'P';
      setSelectedDate(selectedDate);
      showToast('일정과 프로필을 삭제했습니다.');
      return true;
    });
  });

  document.querySelector('.sync-button')?.addEventListener('click', (event) => {
  const button = event.currentTarget;
  button.innerHTML = '<span class="material-symbols-rounded">check</span>동기화 완료';
  setTimeout(() => {
    button.innerHTML = '<span class="material-symbols-rounded">my_location</span>실시간 동기화';
  }, 1800);
});

document.querySelector('.map-location-button')?.addEventListener('click', showCurrentLocation);

document.querySelector('.location-box button')?.addEventListener('click', () => {
  showToast('예약된 일정이 없습니다.');
});

document.querySelector('.risk-footer button')?.addEventListener('click', () => {
  showToast('이동 경로를 계산할 일정이 없습니다.');
});

document.querySelector('.ai-brief button')?.addEventListener('click', () => showView('ai'));

document.querySelector('.accept-quest')?.addEventListener('click', (event) => {
  event.currentTarget.textContent = '일정에 담김 ✓';
  event.currentTarget.disabled = true;
  event.currentTarget.nextElementSibling.textContent = '추가됨';
});

document.querySelector('.skip-quest')?.addEventListener('click', (event) => {
  const card = event.currentTarget.closest('.quest-card');
  card.parentElement.style.display = 'none';
});

const dinnerRecommendation = document.querySelector('#dinner-recommendation');
document.querySelector('#add-dinner')?.addEventListener('click', (event) => {
  dinnerRecommendation.classList.toggle('hidden');
  const added = !dinnerRecommendation.classList.contains('hidden');
  event.currentTarget.innerHTML = added
    ? '<span class="material-symbols-rounded">check</span>식사 일정 반영됨'
    : '<span class="material-symbols-rounded">restaurant</span>중간 저녁 식사 추가';
});

document.querySelector('#keep-original')?.addEventListener('click', () => {
  dinnerRecommendation.classList.add('hidden');
  const addButton = document.querySelector('#add-dinner');
  addButton.innerHTML = '<span class="material-symbols-rounded">restaurant</span>중간 저녁 식사 추가';
  showToast('원래 일정 그대로 등록할게요.');
});

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
    const status = await response.json();
    if (!response.ok) throw new Error(status.error || 'AI 설정 상태를 확인하지 못했습니다.');
    badge.textContent = status.configured ? 'Azure OpenAI 준비됨' : '서버 설정 필요';
    badge.className = `tag ${status.configured ? 'mint' : 'slate'}`;
    if (!status.configured) setAiAnalysisMessage('Azure OpenAI 서버 설정이 필요합니다. 로컬은 .env, 배포 사이트는 Azure Static Web Apps의 애플리케이션 설정에 endpoint, API key, deployment를 등록해 주세요.');
  } catch (error) {
    badge.textContent = 'AI 서버 연결 안 됨';
    badge.className = 'tag coral';
    setAiAnalysisMessage(error.message || 'AI 서버에 연결할 수 없습니다.', 'error');
  }
}

refreshAzureOpenAiStatus();

document.querySelector('#analyze-prompt')?.addEventListener('click', async (event) => {
  const promptInput = document.querySelector('#schedule-prompt');
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setAiAnalysisMessage('먼저 분석할 일정 문장을 입력해 주세요.', 'error');
    promptInput.focus();
    return;
  }

  const button = event.currentTarget;
  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="material-symbols-rounded">progress_activity</span>일정 분석 중';
  setAiAnalysisMessage('Azure OpenAI가 문장에서 일정을 찾고 있습니다.');
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
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '일정 분석에 실패했습니다.');
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
    document.querySelector('.ai-stack').innerHTML = `
      <div class="empty-state panel"><span class="material-symbols-rounded">error_outline</span><h2>일정을 분석하지 못했어요</h2><p>${escapeHtml(error.message || 'Azure OpenAI 연결 상태를 확인해 주세요.')}</p></div>
    `;
    document.querySelector('.section-title small').textContent = '분석 실패';
    setAiAnalysisMessage(error.message || '일정 분석에 실패했습니다.', 'error');
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
    const conflict = [...savedEvents, ...staged].find((existing) => existing.date === item.date
      && item.startTime < existing.endTime
      && item.endTime > existing.startTime);
    if (conflict) {
      showToast(`'${item.title}' 일정이 '${conflict.title}' 일정과 겹칩니다. 시간을 조정해 주세요.`, 'info');
      return;
    }
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

document.querySelector('#midpoint .primary-cta')?.addEventListener('click', () => {
  showModal('출발 위치 추가', '<label class="modal-field">친구 이름<input placeholder="예: 민수" /></label><label class="modal-field">출발 위치<input placeholder="예: 홍대입구역" /></label>', '위치 추가');
});

document.querySelector('.secondary-cta')?.addEventListener('click', () => showToast('중간지점을 먼저 계산해 주세요.'));
