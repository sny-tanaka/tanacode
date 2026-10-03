// セッションの MCP サーバー（tanacode-sessions）の入り口。Claude Code が --mcp-config に従って起動する（stdio）。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// ソケットのパスとセッションは、--mcp-config の env で受け取る
import { SESSIONS_MCP, SESSIONS_MCP_FOR_CHILD } from '@shared/session-tools';
import { callBridge } from './mcp-bridge';
import { runRelay } from './mcp-relay';
import { SESSIONS_CALL_TIMEOUT_MS, SESSIONS_CHILD_ENV, SESSIONS_CLOSED_MESSAGE, SESSIONS_SESSION_ENV, SESSIONS_SOCKET_ENV } from './sessions-bridge';

const socketPath = process.env[SESSIONS_SOCKET_ENV] ?? '';
const session = process.env[SESSIONS_SESSION_ENV] ?? '';

runRelay(
  process.stdin,
  process.stdout,
  {
    // 子セッションには、読むだけのツールだけを見せる
    server: process.env[SESSIONS_CHILD_ENV] === '1' ? SESSIONS_MCP_FOR_CHILD : SESSIONS_MCP,
    version: process.env.TANACODE_VERSION ?? '0.0.0',
    call: (tool, args, signal) => callBridge(socketPath, { session, tool, args }, SESSIONS_CALL_TIMEOUT_MS, SESSIONS_CLOSED_MESSAGE, signal),
  },
  // Claude Code が終われば、標準入力が閉じる
  () => process.exit(0),
);
