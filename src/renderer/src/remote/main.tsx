import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { createApi } from '@shared/api-bindings';
import { setLanguage } from '@shared/i18n';
import { App } from '../App';
import { syncSharedPrefs } from '../sharedPrefs';
import { RemoteTransport } from './transport';
import '../global.css';

// スマホの画面の入口（遠隔サーバーが /app/ で配る。Issue #464）。Mac の画面と同じ App を、WebSocket の window.tanacode で動かす。
// CSP は、遠隔サーバーが応答のヘッダーで付ける（Mac の画面の index.html の meta と同じものに、connect-src 'self'）

// 選んだプロファイルを覚えておく鍵（次に開いたときも同じプロファイルで始める）
const PROFILE_KEY = 'tanacode.remote.profile';

const transport = new RemoteTransport({
  // セッションが切れた・束縛の鍵が無いときは、ログインの画面へ戻す
  onSignedOut: () => location.replace('/'),
});
// 押す・打つを覚えて、そのあと少しの間の頼みに、人の操作の印を付ける（使わない時間は、印のある頼みでだけ数え直される）
for (const type of ['pointerdown', 'keydown'] as const) addEventListener(type, () => transport.markInput(), true);

void transport.start().then(async (ready) => {
  const saved = localStorage.getItem(PROFILE_KEY);
  const profileId = saved && ready.profileIds.includes(saved) ? saved : ready.profileIds[0];
  if (!profileId) return location.replace('/');
  localStorage.setItem(PROFILE_KEY, profileId);
  transport.useProfile(profileId);
  // ドロップしたファイルの Mac の上のパスは、スマホでは分からない
  (window as unknown as { tanacode: unknown }).tanacode = createApi(transport.api(() => '', () => ready.language));
  setLanguage(ready.language);
  document.documentElement.lang = ready.language;
  // 共有の表示設定（カラムの幅など）は、スマホでは手元だけ（遠隔では呼べないので、すぐに手元の値で始まる）
  await syncSharedPrefs();
  createRoot(document.getElementById('root')!).render(<App />);
});
