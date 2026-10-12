// チェックリストの MCP サーバー（tanacode-checklist）の入り口。Claude Code が --mcp-config に従って起動する（stdio）。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// ソケットのパスとセッションは、--mcp-config の env で受け取る
// --hook を付けて動かしたときは、MCP サーバーではなく、チェックリストを使い続けさせるフックとして働く（checklist-hook.ts）
import { CHECKLIST_MCP } from '@shared/checklist-tools';
import { CHECKLIST_CALL_TIMEOUT_MS, CHECKLIST_CLOSED_MESSAGE, CHECKLIST_SESSION_ENV, CHECKLIST_SOCKET_ENV } from './checklist-bridge';
import { CHECKLIST_HOOK_ARG, preCompactBlock, runHook } from './checklist-hook';
import { callBridge } from './mcp-bridge';
import { runRelay } from './mcp-relay';

const socketPath = process.env[CHECKLIST_SOCKET_ENV] ?? '';
const session = process.env[CHECKLIST_SESSION_ENV] ?? '';

// フックがアプリを待つ上限。Claude の作業を止めない側に倒せばよいので、短くてよい
const HOOK_TIMEOUT_MS = 5_000;

if (process.argv.includes(CHECKLIST_HOOK_ARG)) {
  // Claude Code は、フックの標準入力に JSON を書いて閉じる
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => (stdin += chunk));
  process.stdin.on('end', () => {
    void (async () => {
      // 圧縮の前のフックで止めるときは、理由を標準エラーに書いて、終了コード 2 で終える
      const block = await preCompactBlock(stdin, socketPath, session, HOOK_TIMEOUT_MS);
      if (block) return process.stderr.write(`${block}\n`, () => process.exit(2));
      const output = await runHook(stdin, socketPath, session, HOOK_TIMEOUT_MS);
      return output ? process.stdout.write(`${output}\n`, () => process.exit(0)) : process.exit(0);
    })();
  });
} else {
  runRelay(
    process.stdin,
    process.stdout,
    {
      server: CHECKLIST_MCP,
      version: process.env.TANACODE_VERSION ?? '0.0.0',
      call: (tool, args, signal) => callBridge(socketPath, { session, tool, args }, CHECKLIST_CALL_TIMEOUT_MS, CHECKLIST_CLOSED_MESSAGE, signal),
    },
    // Claude Code が終われば、標準入力が閉じる
    () => process.exit(0),
  );
}
