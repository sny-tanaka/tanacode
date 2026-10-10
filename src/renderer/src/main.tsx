import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { setLanguage, type Language } from '@shared/i18n';
import './global.css';

// 言語を main から受け取ってから、画面の部品を読み込む（部品のモジュールより先に言語を決める）。
// 言語を切り替えると、main が画面を読み込み直す。日本語の折り返し（word-break: auto-phrase）は html の lang が ja のときだけ効く
void window.tanacode.language
  .get()
  .catch((): Language => 'ja')
  .then(async (lang) => {
    setLanguage(lang);
    document.documentElement.lang = lang;
    const { App } = await import('./App');
    createRoot(document.getElementById('root')!).render(<App />);
  });
