// 通知を受けて出すだけの Service Worker。画面のファイルはキャッシュしない（fetch を受けない）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'tanacode の確かめ', body: '' };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body }));
});
