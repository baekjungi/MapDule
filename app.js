let views = [...document.querySelectorAll('.view')];
let navItems = [...document.querySelectorAll('.nav-item')];
const EVENTS_STORAGE_KEY = 'mapdule-events';
const PROFILE_STORAGE_KEY = 'mapdule-profile';
let editingEventId = null;

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
    <div class="map-top"><span><i></i>경로 대기 중</span><button type="button"><span class="material-symbols-rounded">layers</span>지도 보기</button></div>
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
    <label class="eyebrow" for="schedule-prompt">일정 문장 입력</label>
    <textarea id="schedule-prompt" class="prompt-input" rows="4" placeholder="일정과 장소를 자연어로 입력하세요."></textarea>
    <div class="prompt-actions"><span class="voice-pill"><span class="material-symbols-rounded">info</span>AI 일정 분석 연동 전</span><button class="link-button" id="analyze-prompt" type="button"><span class="material-symbols-rounded">auto_awesome</span>분석 준비 확인</button></div>
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

  const manualNavItem = document.createElement('button');
  manualNavItem.className = 'nav-item';
  manualNavItem.dataset.view = 'manual';
  manualNavItem.innerHTML = '<span class="material-symbols-rounded">event</span><small>일정 등록</small>';
  document.querySelector('.bottom-nav').append(manualNavItem);
  views = [...document.querySelectorAll('.view')];
  navItems = [...document.querySelectorAll('.nav-item')];

  document.querySelector('.ai-brief small').textContent = '일정을 추가하면 이동 안내를 표시합니다.';
  const quickRoute = document.querySelector('.ai-brief button');
  quickRoute.textContent = '일정 추가';
  quickRoute.dataset.view = 'ai';

  return weekDates;
}

const weekDates = clearDemoContent();

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
      new window.kakao.maps.Map(mapCanvas, {
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
  dateButtons.forEach((button, index) => button.classList.toggle('selected', weekDates[index].iso === localDateString(selectedDate)));
  renderCalendar();
  const dateField = document.querySelector('#manual-event-form [name="date"]');
  if (dateField) dateField.value = localDateString(selectedDate);
  if (announce) showToast(`${selectedDate.getMonth() + 1}월 ${selectedDate.getDate()}일 일정을 표시합니다.`);
}

dateButtons.forEach((button, index) => {
  button.addEventListener('click', () => {
    const selected = weekDates[index];
    setSelectedDate(new Date(`${selected.iso}T12:00:00`), true);
  });
});

function moveSelectedDate(days) {
  const date = new Date(selectedDate);
  date.setDate(date.getDate() + days);
  setSelectedDate(date, true);
}

document.querySelector('[aria-label="이전 날짜"]')?.addEventListener('click', () => moveSelectedDate(-1));
document.querySelector('[aria-label="다음 날짜"]')?.addEventListener('click', () => moveSelectedDate(1));

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
      .filter((item) => item.date === date)
      .sort((first, second) => first.startTime.localeCompare(second.startTime));

    if (!events.length) {
      timeline.innerHTML = `
        <div class="empty-state panel">
          <span class="material-symbols-rounded">calendar_add_on</span>
          <h2>등록된 일정이 없어요</h2>
          <p>직접 일정을 등록하면 이 날짜의 타임라인에 표시됩니다.</p>
          <button class="primary-cta" data-view="manual" type="button"><span class="material-symbols-rounded">add</span>일정 등록</button>
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
          <p class="event-time"><span class="material-symbols-rounded">schedule</span>${escapeHtml(item.startTime)} - ${escapeHtml(item.endTime)}</p>
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
      editingEventId = existing.id;
      manualEventForm.elements.title.value = existing.title;
      manualEventForm.elements.date.value = existing.date;
      manualEventForm.elements.category.value = existing.category;
      manualEventForm.elements.startTime.value = existing.startTime;
      manualEventForm.elements.endTime.value = existing.endTime;
      manualEventForm.elements.location.value = existing.location || '';
      manualEventForm.elements.notes.value = existing.notes || '';
      manualEventForm.querySelector('[type="submit"]').innerHTML = '<span class="material-symbols-rounded">save</span>일정 수정 저장';
      manualEventForm.querySelector('.cancel-edit').classList.remove('hidden');
      showView('manual');
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
    renderCalendar();
    showToast('일정을 삭제했습니다.');
  });

  const manualEventForm = document.querySelector('#manual-event-form');
  const endTimeInput = manualEventForm.elements.endTime;
  endTimeInput.addEventListener('input', () => endTimeInput.setCustomValidity(''));
  manualEventForm.elements.date.value = localDateString(selectedDate);
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

  renderCalendar();

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
        renderCalendar();
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
      renderCalendar();
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

document.querySelector('.map-top button')?.addEventListener('click', () => {
  showToast('일정을 등록하면 지도 경로를 확인할 수 있어요.');
});

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

document.querySelector('#analyze-prompt')?.addEventListener('click', () => {
  const prompt = document.querySelector('#schedule-prompt').value.trim();
  showToast(prompt ? 'AI 분석 기능이 연결되면 일정을 확인할 수 있어요.' : '먼저 일정 문장을 입력해 주세요.', 'info');
});

document.querySelector('#ai .primary-cta')?.addEventListener('click', () => {
  showToast('등록할 일정이 없습니다.');
});

document.querySelector('.manual-link')?.addEventListener('click', () => showView('today'));

document.querySelector('#midpoint .primary-cta')?.addEventListener('click', () => {
  showModal('출발 위치 추가', '<label class="modal-field">친구 이름<input placeholder="예: 민수" /></label><label class="modal-field">출발 위치<input placeholder="예: 홍대입구역" /></label>', '위치 추가');
});

document.querySelector('.secondary-cta')?.addEventListener('click', () => showToast('중간지점을 먼저 계산해 주세요.'));
