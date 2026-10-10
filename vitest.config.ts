import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { coverage } from './vitest.coverage';

// npm test: 本物の Claude Code から取った控え（test/fixtures）で、画面・会話ログ・statusLine の読み取りを確かめる
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // アイコン（tsx）を描いて確かめるテストがある。tsconfig と同じ、import 不要の JSX にする
  esbuild: { jsx: 'automatic' },
  // 画面のテスト（test/renderer）は、ファイルの先頭の @vitest-environment jsdom で DOM の代わりを使う
  // clean-env.ts: tanacode や Claude Code の中のシェルで流しても、そのセッションの環境変数（CLAUDE_CONFIG_DIR・TANACODE_*）を持ち込まない
  test: { include: ['test/*.test.ts', 'test/renderer/*.test.{ts,tsx}'], setupFiles: ['test/clean-env.ts'], coverage: coverage('unit') },
});
