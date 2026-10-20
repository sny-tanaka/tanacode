import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// npm run check:transcripts: 手元の本物の会話ログ（~/.claude*/projects）を、アプリの読み取りに流して決まりを確かめる（test/local）。
// CI では流さない（会話ログは開発者の手元にしか無い）。ファイルは 1 つずつ読むので、1 つのプロセスで流す
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['test/local/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    maxWorkers: 1,
  },
});
