// スマホの画面の Service Worker（Issue #464）。遠隔サーバーが /app/sw.js で配る（キャッシュさせない）。
// 通知に要る最小限だけにする: 画面のファイルや絵はキャッシュせず、fetch も受けない（設計の決まり）。
// - push: Mac の tanacode が送った通知（暗号化はブラウザが解く）を出す。同じセッションの通知は 1 つにまとめる（tag）
// - notificationclick: 開いている画面があれば前に出して、そのセッションを開かせる。無ければ、そのセッションを開く URL で開く
export const SERVICE_WORKER = `'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'tanacode';
  const body = typeof data.body === 'string' ? data.body : '';
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
  const profileId = typeof data.profileId === 'string' ? data.profileId : '';
  event.waitUntil(self.registration.showNotification(title, { body, tag: sessionId || undefined, data: { sessionId, profileId } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const params = new URLSearchParams();
  if (data.sessionId) params.set('session', data.sessionId);
  if (data.profileId) params.set('profile', data.profileId);
  const url = '/app/' + (params.size > 0 ? '?' + params.toString() : '');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (!new URL(client.url).pathname.startsWith('/app')) continue;
        client.postMessage({ type: 'tanacode:open-session', sessionId: data.sessionId || null, profileId: data.profileId || null });
        return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
`;
