import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import license from 'rollup-plugin-license';
import { licenseOf, thirdPartyNotices } from './scripts/third-party-notices';

// TANACODE_SOURCEMAP=1 でビルドすると、ソースマップ（.map）も書き出す。E2E のカバレッジを src の行に戻すのに使う
// （npm run coverage:e2e。.map はアプリには入れない）
const sourcemap = process.env.TANACODE_SOURCEMAP === '1';

// 画面に出すアプリのバージョン（__APP_VERSION__ として埋め込む）
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // pty-host: Claude Code を持っておく常駐プロセス（アプリが切り離して起動する）。
    // browser-mcp・sessions-mcp・checklist-mcp・walkthrough-mcp: アプリ内ブラウザ・セッション・チェックリスト・ウォークスルーの MCP サーバー（Claude Code が起動し、アプリへ中継する）
    build: {
      sourcemap,
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'pty-host': resolve('src/main/pty-host.ts'),
          'browser-mcp': resolve('src/main/browser-mcp.ts'),
          'sessions-mcp': resolve('src/main/sessions-mcp.ts'),
          'checklist-mcp': resolve('src/main/checklist-mcp.ts'),
          'walkthrough-mcp': resolve('src/main/walkthrough-mcp.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { sourcemap },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { sourcemap },
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
