import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import license from 'rollup-plugin-license';
import { licenseOf, thirdPartyNotices } from './scripts/third-party-notices';

// 画面に出すアプリのバージョン（__APP_VERSION__ として埋め込む）
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // pty-host: Claude Code を持っておく常駐プロセス（アプリが切り離して起動する）。
    // browser-mcp・sessions-mcp: アプリ内ブラウザ・セッションの MCP サーバー（Claude Code が起動し、アプリへ中継する）
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'pty-host': resolve('src/main/pty-host.ts'),
          'browser-mcp': resolve('src/main/browser-mcp.ts'),
          'sessions-mcp': resolve('src/main/sessions-mcp.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [
      react(),
      // アプリに入れて配る依存のライセンス表示を、アプリの中（out/renderer/THIRD_PARTY_NOTICES.txt）に書き出す。
      // GPL 系のライセンスや、ライセンスの分からない依存が混ざったらビルドを止める
      license({
        thirdParty: {
          includePrivate: false,
          allow: {
            test: (dependency) => {
              const kind = licenseOf(dependency.license, dependency.licenseText);
              return !!kind && !/GPL/i.test(kind);
            },
            failOnUnlicensed: true,
            failOnViolation: true,
          },
          output: { file: resolve('out/renderer/THIRD_PARTY_NOTICES.txt'), template: thirdPartyNotices },
        },
      }),
    ],
  },
});
