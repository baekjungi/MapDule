const views = [...document.querySelectorAll('.view')];
const navItems = [...document.querySelectorAll('.nav-item')];

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
    return { day: weekdayNames[index], date: date.getDate(), selected: date.toDateString() === today.toDateString() };
  });

  const month = today.getMonth() + 1;
  const todayName = weekdayNames[today.getDay()];
  document.querySelector('#today-title').innerHTML = `오늘, ${month}월 ${today.getDate()}일 <em>(${todayName})</em>`;
  document.querySelector('.status-pill').innerHTML = '<i></i>위치 미연결';
  document.querySelector('.avatar').innerHTML = '<span class="material-symbols-rounded">person</span>';

  document.querySelector('.map-card').innerHTML = `
    <div class="map-grid"></div>
    <div class="map-empty"><span class="material-symbols-rounded">map</span><b>표시할 경로가 없어요</b><small>일정을 등록하면 이동 경로가 표시됩니다.</small></div>
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

  document.querySelector('.energy-top h2').textContent = '일정 등록 후 확인할 수 있어요';
  document.querySelector('.energy-top > strong').textContent = '—';
  document.querySelector('.gauge i').style.width = '0%';
  document.querySelector('.gauge-labels').hidden = true;
  document.querySelector('.energy-hero > p').textContent = '일정과 이동 정보가 등록되면 피로도를 계산합니다.';
  document.querySelector('.energy-hero .primary-cta').disabled = true;
  document.querySelector('.energy-hero .primary-cta').textContent = '일정 등록 후 휴식을 제안합니다';
  document.querySelector('.recovery-list').innerHTML = '<div class="empty-state panel"><p>예정된 회복 활동이 없습니다.</p></div>';

  document.querySelector('.ai-brief small').textContent = '일정을 추가하면 이동 안내를 표시합니다.';
  const quickRoute = document.querySelector('.ai-brief button');
  quickRoute.textContent = '일정 추가';
  quickRoute.dataset.view = 'ai';

  return weekDates;
}

const weekDates = clearDemoContent();

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

function showModal(title, content, actionText = '확인') {
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
    if (event.target === modal || event.target.closest('.modal-close') || event.target.closest('.modal-action')) close();
  });
  modal.querySelector('.modal-close').focus();
}

function showView(id) {
  views.forEach((view) => view.classList.toggle('active', view.id === id));
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-view]').forEach((control) => {
  control.addEventListener('click', () => showView(control.dataset.view));
});

document.querySelector('.brand')?.addEventListener('click', (event) => {
  event.preventDefault();
  showView('today');
});

document.querySelector('[aria-label="알림"]')?.addEventListener('click', () => {
  showModal('알림 센터', '<p>새로운 이동 알림이 없습니다.</p><p class="modal-note">지각 위험이 감지되면 이곳에 가장 먼저 표시됩니다.</p>', '닫기');
});

document.querySelector('[aria-label="프로필"]')?.addEventListener('click', () => {
  showModal('프로필', '<p>로그인하면 일정과 설정을 동기화할 수 있어요.</p>', '확인');
});

const dateTitle = document.querySelector('#today-title');
const dateButtons = [...document.querySelectorAll('.week-strip button')];
let selectedDate = new Date();
dateButtons.forEach((button, index) => {
  button.addEventListener('click', () => {
    dateButtons.forEach((item) => item.classList.remove('selected'));
    button.classList.add('selected');
    const selected = weekDates[index];
    selectedDate = new Date(selectedDate);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + index);
    selectedDate = weekStart;
    dateTitle.innerHTML = `${selected.selected ? '오늘, ' : ''}${selectedDate.getMonth() + 1}월 ${selectedDate.getDate()}일 <em>(${selected.day})</em>`;
    showToast(`${selected.day}요일 일정으로 이동했습니다.`);
  });
});

function moveSelectedDate(days) {
  selectedDate.setDate(selectedDate.getDate() + days);
  const day = ['일', '월', '화', '수', '목', '금', '토'][selectedDate.getDay()];
  dateTitle.innerHTML = `${selectedDate.toDateString() === new Date().toDateString() ? '오늘, ' : ''}${selectedDate.getMonth() + 1}월 ${selectedDate.getDate()}일 <em>(${day})</em>`;
  dateButtons.forEach((button) => button.classList.remove('selected'));
  showToast(`${selectedDate.getMonth() + 1}월 ${selectedDate.getDate()}일 일정으로 이동했습니다.`);
}

document.querySelector('[aria-label="이전 날짜"]')?.addEventListener('click', () => moveSelectedDate(-1));
document.querySelector('[aria-label="다음 날짜"]')?.addEventListener('click', () => moveSelectedDate(1));

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

const energyButton = document.querySelector('#energy .primary-cta');
energyButton?.addEventListener('click', () => {
  energyButton.innerHTML = '<span class="material-symbols-rounded">check</span>휴식 블록이 추가됨';
  energyButton.classList.add('added');
  showToast('15:40에 30분 휴식 블록을 추가했습니다.', 'success');
});
