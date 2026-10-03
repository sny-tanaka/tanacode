import type { Preview } from '@storybook/react-vite';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../src/renderer/src/global.css';
import { TooltipLayer } from '../src/renderer/src/layout/Tooltip';
import { resetBlockTranslation } from '../src/renderer/src/translate/BlockTranslation';
import { installMockApi, resetMockApi } from './mockApi';

installMockApi();
// アプリ（src/renderer/index.html）と同じ言語にする。日本語の折り返し（word-break: auto-phrase）は言語が日本語のときだけ効く
document.documentElement.lang = 'ja';

// 部品は読む場所（チャット・エディタ）の地の色の上に置く。幅はストーリーごとに parameters.width で変えられる
const preview: Preview = {
  // ストーリー自身の beforeEach（mockApi で返事を決める）より先に走るので、ここで前のストーリーの返事を捨てる
  // （翻訳の「使えるか」と訳した文も、モジュールに覚えているので捨てる）
  beforeEach: () => {
    resetMockApi();
    resetBlockTranslation();
  },
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
  },
  decorators: [
    // デモ動画（parameters.bare）は、余白を付けずにアプリの画面いっぱいに出す
    (Story, context) =>
      context.parameters.bare ? (
        <Story />
      ) : (
        <div
          style={{
            minHeight: '100vh',
            overflow: 'auto',
            padding: 24,
            background: `var(${context.parameters.background ?? '--bg-panel'})`,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ maxWidth: context.parameters.width ?? 440, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Story />
          </div>
          <TooltipLayer />
        </div>
      ),
  ],
};

export default preview;
