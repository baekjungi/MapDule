(() => {
  const TOKEN_KEY = 'mapdule-push-token';
  const STATE_KEY = 'mapdule-push-state';
  let cancelling = null;
  const fingerprint = (event) => window.departureEventFingerprint(event);
  const bytes = (key) => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)), (character) => character.charCodeAt(0));
  const readState = () => { try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch { return null; } };
  const token = () => {
    let value = localStorage.getItem(TOKEN_KEY);
    if (!value) {
      const random = crypto.getRandomValues(new Uint8Array(32));
      value = btoa(String.fromCharCode(...random)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem(TOKEN_KEY, value);
    }
    return value;
  };
  async function request(action, body) {
    const response = await fetch(`/api/push/${action}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(12000),
      headers: body ? { 'Content-Type': 'application/json', 'X-MapDule-Push-Token': token() } : {},
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!/^application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('알림 서버 응답을 확인하지 못했어요.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '알림 서버 연결을 확인해 주세요.');
    return result;
  }
  async function cancel() {
    if (cancelling) return cancelling;
    const state = readState();
    if (!state) return;
    cancelling = (async () => {
      await request('cancel', { endpoint: state.endpoint });
      localStorage.removeItem(STATE_KEY);
    })();
    try { await cancelling; } finally { cancelling = null; }
  }
  async function schedule(date, targets, events) {
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const config = await request('status');
    if (!config.enabled || Notification.permission !== 'granted') return false;
    token();
    if (cancelling) await cancelling;
    const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    const key = bytes(config.publicKey);
    const oldKey = subscription?.options.applicationServerKey;
    if (oldKey && btoa(String.fromCharCode(...new Uint8Array(oldKey))) !== btoa(String.fromCharCode(...key))) {
      await cancel();
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const now = Date.now();
    const items = targets.map((target) => ({
      id: `${date}-${target.toId}`, title: '출발할 시간이에요.',
      body: `${target.toTitle}까지 이동 약 ${target.travelMinutes}분, ${target.nextStartTime} 시작이에요.`.slice(0, 200),
      dueAt: new Date(Math.max(now + 5000, new Date(`${date}T${target.recommendedDepartureTime}:00`).getTime())).toISOString(),
      expiresAt: new Date(`${date}T${target.nextStartTime}:00`).toISOString()
    }));
    const referenced = new Set(targets.flatMap((target) => [target.fromId, target.toId]));
    const fingerprints = [...referenced].map((id) => [id, fingerprint(events.find((event) => event.id === id))]);
    if (readState()?.endpoint && readState().endpoint !== subscription.endpoint) await cancel();
    localStorage.setItem(STATE_KEY, JSON.stringify({ endpoint: subscription.endpoint, fingerprints }));
    await request('schedule', { subscription: subscription.toJSON(), items });
    return true;
  }
  async function reconcile(events) {
    const state = readState();
    if (!state || !state.fingerprints.some(([id, previous]) => previous !== fingerprint(events.find((event) => event.id === id)))) return;
    try {
      await cancel();
      window.showToast?.('일정이 변경되어 기존 출발 푸시 예약을 취소했어요. 일정을 다시 계산해 주세요.', 'info');
    } catch {
      window.showToast?.('기존 푸시 예약 취소에 실패했어요. 연결 후 알림 끄기를 다시 눌러 주세요.', 'info');
    }
  }
  window.MapDulePush = { schedule, cancel, reconcile, fingerprint };
})();