import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

// アプリ内ブラウザの中継（src/main/browser-mcp.ts）を、アプリのビルドと同じく 1 つの JS にまとめる。
// 互換性の確認では、これを node で動かす（アプリでは tanacode 本体を Node として動かす）
export async function buildRelay(): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'tanacode-relay-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      ssr: resolve('src/main/browser-mcp.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'browser-mcp.js' } },
    },
  });
  return join(outDir, 'browser-mcp.js');
}
