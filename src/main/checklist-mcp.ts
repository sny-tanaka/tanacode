// チェックリストの MCP サーバー（tanacode-checklist）の入り口。Claude Code が --mcp-config に従って起動する（stdio）。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// ソケットのパスとセッションは、--mcp-config の env で受け取る
import { CHECKLIST_MCP } from '@shared/checklist-tools';
import { CHECKLIST_CALL_TIMEOUT_MS, CHECKLIST_CLOSED_MESSAGE, CHECKLIST_SESSION_ENV, CHECKLIST_SOCKET_ENV } from './checklist-bridge';
import { callBridge } from './mcp-bridge';
import { runRelay } from './mcp-relay';

const socketPath = process.env[CHECKLIST_SOCKET_ENV] ?? '';
const session = process.env[CHECKLIST_SESSION_ENV] ?? '';

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
