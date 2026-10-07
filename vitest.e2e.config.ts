import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// npm run test:e2e: アプリ本体を Playwright で起動して、画面の操作から Claude Code・MCP・ターミナルまでを通しで確かめる（test/e2e）。
// 先に npm run build でビルドしておく（パッケージした .app を確かめるときは TANACODE_E2E_APP にその実行ファイルを渡す）。
// アプリはひとつずつ起動する（同時に起動すると、画面のフォーカスや pty ホストの起動が取り合いになる）
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
