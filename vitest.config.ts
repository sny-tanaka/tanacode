import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { coverage } from './vitest.coverage';

// npm test: 本物の Claude Code から取った控え（test/fixtures）で、画面・会話ログ・statusLine の読み取りを確かめる
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // アイコン（tsx）を描いて確かめるテストがある。tsconfig と同じ、import 不要の JSX にする
  esbuild: { jsx: 'automatic' },
  // 画面のテスト（test/renderer）は、ファイルの先頭の @vitest-environment jsdom で DOM の代わりを使う
  // CLAUDE_CONFIG_DIR は空にする（Claude Code の中など、付いたシェルで流しても、使い捨てのホームの ~/.claude を見るように）
  test: { include: ['test/*.test.ts', 'test/renderer/*.test.{ts,tsx}'], env: { CLAUDE_CONFIG_DIR: '' }, coverage: coverage('unit') },
});
