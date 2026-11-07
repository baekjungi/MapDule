const SAFE_URLS = new Set(['/#ai', '/#family']);

self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data?.json(); } catch {}
  const title = typeof payload?.title === 'string' ? payload.title.slice(0, 80) : 'MapDule';
  const body = typeof payload?.body === 'string' ? payload.body.slice(0, 200) : '출발 알림이 도착했어요.';
  const url = SAFE_URLS.has(payload?.url) ? payload.url : '/#ai';
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: typeof payload?.tag === 'string' ? payload.tag.slice(0, 140) : 'mapdule-departure',
    icon: '/app-icon.svg', data: { url }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = SAFE_URLS.has(event.notification.data?.url) ? event.notification.data.url : '/#ai';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(url);
      await existing.focus();
    } else await self.clients.openWindow(url);
  })());
});
