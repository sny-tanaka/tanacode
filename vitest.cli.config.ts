import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { coverage } from './vitest.coverage';

// npm run test:cli: 本物の claude をモックの API で動かし、アプリと同じ読み取りが通るかを確かめる（test/cli）
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['test/cli/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000, coverage: coverage('cli') },
});
