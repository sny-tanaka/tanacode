import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import durations from './test/e2e/durations.json';
import { durationSequencer } from './test/helpers/duration-sequencer';

// npm run test:e2e: アプリ本体を Playwright で起動して、画面の操作から Claude Code・MCP・ターミナルまでを通しで確かめる（test/e2e）。
// 先に npm run build でビルドしておく（パッケージした .app を確かめるときは TANACODE_E2E_APP にその実行ファイルを渡す）。
// npm run coverage:e2e は、カバレッジも集めて coverage/e2e に書く（先に TANACODE_SOURCEMAP=1 でビルドしておく）。
// アプリを同時にいくつ起動するか（TANACODE_E2E_WORKERS。既定は 1 つずつ）。手元の Mac では 1 つずつにする（前面とキー入力を奪わず、重くしない）。
// CI では、テストのファイルを --shard で何台かに分けて流す。分け方は、ファイルごとの時間（test/e2e/durations.json）で台の合計がそろうようにする（test/helpers/duration-sequencer.ts）。
// 並べるときは、長いファイルから流す（長いファイルが最後に残って終わりが延びないように）
const workers = Math.max(1, Number(process.env.TANACODE_E2E_WORKERS) || 1);

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: workers > 1,
    maxWorkers: workers,
    globalSetup: ['test/e2e/global-setup.ts'],
    sequence: { sequencer: durationSequencer(durations, { sortLongestFirst: workers > 1 }) },
  },
});
