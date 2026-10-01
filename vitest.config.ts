import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// npm test: 本物の Claude Code から取った控え（test/fixtures）で、画面・会話ログ・statusLine の読み取りを確かめる
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['test/*.test.ts'] },
});
