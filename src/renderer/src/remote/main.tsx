import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { createApi } from '@shared/api-bindings';
import { IpcChannel } from '@shared/ipc';
import { setLanguage } from '@shared/i18n';
import { App } from '../App';
import { syncSharedPrefs } from '../sharedPrefs';
import { guardLinks } from './links';
import { BEFORE_RELOAD, setRemoteConnected, setRemoteMode } from './mode';
import { RemoteTransport } from './transport';
import { downloadFile } from './download';
import '../global.css';

// スマホの画面の入口（遠隔サーバーが /app/ で配る。Issue #464）。Mac の画面と同じ App を、WebSocket の window.tanacode で動かす。
// CSP は、遠隔サーバーが応答のヘッダーで付ける（Mac の画面の index.html の meta と同じものに、connect-src 'self'）

// 選んだプロファイルを覚えておく鍵（次に開いたときも同じプロファイルで始める）
const PROFILE_KEY = 'tanacode.remote.profile';

const transport = new RemoteTransport({
  // セッションが切れた・束縛の鍵が無いときは、ログインの画面へ戻す
  onSignedOut: () => location.replace('/'),
  // 上の帯に、Mac とつながっているかを出す
  onConnection: setRemoteConnected,
  // 切れていた間の知らせ（セッションの一覧・質問・許可の確認など）は届いていないので、画面を読み込み直す（assets はキャッシュ済みで軽い）。
  // 返事を待っている頼みが返ってから、打ちかけの文を控えて読み込み直す
  onReconnected: () =>
    void transport.idle().then(() => {
      window.dispatchEvent(new Event(BEFORE_RELOAD));
      location.reload();
    }),
});
setRemoteMode(true);
// ふつうのブラウザには、Mac の画面の main の守り（外のページは外のブラウザで・画面は移らせない）が無いので、ここで補う
guardLinks(window);
// 押す・打つを覚えて、そのあと少しの間の頼みに、人の操作の印を付ける（使わない時間は、印のある頼みでだけ数え直される）
for (const type of ['pointerdown', 'keydown'] as const) addEventListener(type, () => transport.markInput(), true);

// 通知を押して開いたとき（/app/?session=…&profile=…）は、そのプロファイルのそのセッションを開く。URL からは消しておく
const opened = new URLSearchParams(location.search);
const openSession = opened.get('session');
const openProfile = opened.get('profile');
if (openSession || openProfile) history.replaceState(null, '', location.pathname);

void transport.start().then(async (ready) => {
  const saved = localStorage.getItem(PROFILE_KEY);
  const wanted = openProfile && ready.profileIds.includes(openProfile) ? openProfile : saved;
  const profileId = wanted && ready.profileIds.includes(wanted) ? wanted : ready.profileIds[0];
  if (!profileId) return location.replace('/');
  localStorage.setItem(PROFILE_KEY, profileId);
  transport.useProfile(profileId);
  // ドロップしたファイルの Mac の上のパスは、スマホでは分からない
  const api = createApi(transport.api(() => '', () => ready.language));
  // Mac にしか無いものを、スマホのものに置き換える: 外のページはスマホのブラウザの新しいタブで開き、書き出したファイルはスマホにダウンロードする
  api.browser.openExternal = async (url) => void window.open(url);
  api.sessions.saveExport = async (html, fileName) => downloadFile(html, fileName);
  (window as unknown as { tanacode: unknown }).tanacode = api;
  setLanguage(ready.language);
  document.documentElement.lang = ready.language;
  // 共有の表示設定（カラムの幅など）は、スマホでは手元だけ（遠隔では呼べないので、すぐに手元の値で始まる）
  await syncSharedPrefs();
  if (openSession) transport.local(IpcChannel.SessionsSelect, openSession);
  // 画面を開いている間に通知を押したら、Service Worker が知らせる。別のプロファイルなら、そのプロファイルで開き直す
  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; sessionId?: unknown; profileId?: unknown } | null;
    if (data?.type !== 'tanacode:open-session' || typeof data.sessionId !== 'string') return;
    if (typeof data.profileId === 'string' && data.profileId !== profileId && ready.profileIds.includes(data.profileId)) {
      location.replace(`/app/?session=${encodeURIComponent(data.sessionId)}&profile=${encodeURIComponent(data.profileId)}`);
      return;
    }
    transport.local(IpcChannel.SessionsSelect, data.sessionId);
  });
  // 通知に要る Service Worker（画面のファイルはキャッシュさせない）
  void navigator.serviceWorker?.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  createRoot(document.getElementById('root')!).render(<App />);
});
