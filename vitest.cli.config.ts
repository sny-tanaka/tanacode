import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import durations from './test/cli/durations.json';
import { durationSequencer } from './test/helpers/duration-sequencer';
import { coverage } from './vitest.coverage';

// npm run test:cli: 本物の claude をモックの API で動かし、アプリと同じ読み取りが通るかを確かめる（test/cli）
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // clean-env.ts: tanacode や Claude Code の中のシェルで流しても、そのセッションの環境変数（CLAUDE_CONFIG_DIR・TANACODE_*）を持ち込まない。
  // ファイルは並べて流すので、長いもの（test/cli/durations.json）から流す。長いファイルが最後に残ると、終わりが延びるため
  test: {
    include: ['test/cli/**/*.test.ts'],
    setupFiles: ['test/clean-env.ts'],
    // 台本ごとの目録を 1 つにまとめる（TANACODE_RECORD=1 のとき。test/transcript-inventory.ts）
    globalSetup: ['test/cli/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: coverage('cli'),
    sequence: { sequencer: durationSequencer(durations, { sortLongestFirst: true }) },
  },
});
