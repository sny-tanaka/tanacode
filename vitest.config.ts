import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { coverage } from './vitest.coverage';

// npm test: 本物の Claude Code から取った控え（test/fixtures）で、画面・会話ログ・statusLine の読み取りを確かめる
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // アイコン（tsx）を描いて確かめるテストがある。tsconfig と同じ、import 不要の JSX にする
  esbuild: { jsx: 'automatic' },
  test: { include: ['test/*.test.ts'], coverage: coverage('unit') },
});
