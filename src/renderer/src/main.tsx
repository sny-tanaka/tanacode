import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { setLanguage } from '@shared/i18n';
import { App } from './App';
import { watchChatFocus } from './chat/focusWatch';
import { syncSharedPrefs } from './sharedPrefs';
import './global.css';

// 言語は、描く前に決める（部品はモジュールを読み込むときに文言を読まないので、ここで決めれば間に合う）。
// 日本語の折り返し（word-break: auto-phrase）は html の lang が ja のときだけ効く
const lang = window.tanacode.language();
setLanguage(lang);
document.documentElement.lang = lang;

// チャットの入力欄から、人の操作でないのにフォーカスが外れたら、アプリのログ（userData/focus.log）に残す
watchChatFocus({ report: (report) => window.tanacode.diagnostics.focusLost(report) });

// プロファイルをまたいで同じにする表示設定（カラムの幅など）は、描く前にそろえる（描いてから幅が変わらないように）
void syncSharedPrefs().then(() => createRoot(document.getElementById('root')!).render(<App />));
