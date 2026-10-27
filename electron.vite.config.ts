import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import license from 'rollup-plugin-license';
import { backgroundElectron } from './scripts/background-electron';
import { licenseOf, thirdPartyNotices } from './scripts/third-party-notices';

// TANACODE_SOURCEMAP=1 でビルドすると、ソースマップ（.map）も書き出す。E2E のカバレッジを src の行に戻すのに使う
// （npm run coverage:e2e。.map はアプリには入れない）
const sourcemap = process.env.TANACODE_SOURCEMAP === '1';
// ソースマップには元のソースを埋め込まない（カバレッジは src のファイルを読んで戻すので要らない）。
// 埋め込むと、画面側のビルドの最大メモリが 0.7GB ほど増える（5.1GB → 5.8GB）
const output = { sourcemapExcludeSources: true };

// 裏で起動する（TANACODE_BACKGROUND=1）npm run dev・npm start は、LSUIElement を足した Electron の写しで起動する（scripts/background-electron.ts）。
// 起動の直後も Dock に出さず、前面を奪わないため。electron-vite は ELECTRON_EXEC_PATH の Electron を起動する（自分で決めていれば、そのまま使う）
if (process.env.TANACODE_BACKGROUND === '1' && !process.env.ELECTRON_EXEC_PATH) {
  const bin = backgroundElectron(resolve('.'));
  if (bin) process.env.ELECTRON_EXEC_PATH = bin;
}

// 画面に出すアプリのバージョン（__APP_VERSION__ として埋め込む）
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // pty-host: Claude Code を持っておく常駐プロセス（アプリが切り離して起動する）。
    // browser-mcp・sessions-mcp・checklist-mcp・walkthrough-mcp・terminal-mcp: アプリ内ブラウザ・セッション・チェックリスト・ウォークスルー・ターミナルの MCP サーバー（Claude Code が起動し、アプリへ中継する）
    // instructions-hook: TANACODE.md を Claude に渡す SessionStart のフック（Claude Code が起動する）
    // worktree-guard-hook: worktree やブランチを消す操作で、失うものが無いかを確かめる（Bash の PreToolUse のフックが起動する）
    build: {
      sourcemap,
      rolldownOptions: {
        output,
        input: {
          index: resolve('src/main/index.ts'),
          'pty-host': resolve('src/main/pty-host.ts'),
          'browser-mcp': resolve('src/main/browser-mcp.ts'),
          'sessions-mcp': resolve('src/main/sessions-mcp.ts'),
          'checklist-mcp': resolve('src/main/checklist-mcp.ts'),
          'walkthrough-mcp': resolve('src/main/walkthrough-mcp.ts'),
          'terminal-mcp': resolve('src/main/terminal-mcp.ts'),
          'instructions-hook': resolve('src/main/instructions-hook.ts'),
          'worktree-guard-hook': resolve('src/main/worktree-guard-hook.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { sourcemap, rolldownOptions: { output } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { sourcemap, rolldownOptions: { output } },
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
