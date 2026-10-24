import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

// MCP サーバーの中継（src/main/browser-mcp.ts・sessions-mcp.ts・checklist-mcp.ts・terminal-mcp.ts）と、TANACODE.md を渡すフック
// （src/main/instructions-hook.ts）を、アプリのビルドと同じく 1 つの JS にまとめる。互換性の確認では、これを node で動かす
// （アプリでは tanacode 本体を Node として動かす）
export async function buildRelay(entry: 'browser-mcp' | 'sessions-mcp' | 'checklist-mcp' | 'terminal-mcp' | 'instructions-hook' | 'worktree-guard-hook' = 'browser-mcp'): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'tanacode-relay-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      ssr: resolve(`src/main/${entry}.ts`),
      outDir,
      emptyOutDir: false,
      minify: false,
      rolldownOptions: { output: { format: 'cjs', entryFileNames: `${entry}.js` } },
    },
  });
  return join(outDir, `${entry}.js`);
}
