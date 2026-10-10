import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { coverage } from './vitest.coverage';

// npm run test:cli: 本物の claude をモックの API で動かし、アプリと同じ読み取りが通るかを確かめる（test/cli）
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // clean-env.ts: tanacode や Claude Code の中のシェルで流しても、そのセッションの環境変数（CLAUDE_CONFIG_DIR・TANACODE_*）を持ち込まない
  test: { include: ['test/cli/**/*.test.ts'], setupFiles: ['test/clean-env.ts'], testTimeout: 60_000, hookTimeout: 60_000, coverage: coverage('cli') },
});
