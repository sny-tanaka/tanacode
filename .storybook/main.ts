import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StorybookConfig } from '@storybook/react-vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string };

// 画面の部品（src/renderer）だけを、アプリを起動せずにブラウザで見るための Storybook
const config: StorybookConfig = {
  stories: ['../src/renderer/src/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  // 使い方の情報を Storybook に送らない
  core: { disableTelemetry: true },
  // アプリ（electron.vite.config.ts）と同じく、@shared の別名・React のプラグイン・バージョンの埋め込みを使う
  viteFinal: async (vite) => ({
    ...vite,
    define: { ...vite.define, __APP_VERSION__: JSON.stringify(version) },
    plugins: [...(vite.plugins ?? []), react()],
    // アプリのビルドの出力などは見張らない（録画の途中にアプリをビルドすると、ページが読み込み直されてしまう）
    server: {
      ...vite.server,
      watch: { ...vite.server?.watch, ignored: ['**/out/**', '**/dist/**', '**/release/**'] },
    },
    resolve: {
      ...vite.resolve,
      alias: { ...(vite.resolve?.alias as Record<string, string> | undefined), '@shared': resolve(import.meta.dirname, '../src/shared') },
    },
  }),
};

export default config;
