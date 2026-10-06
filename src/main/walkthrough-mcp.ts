// ウォークスルーの MCP サーバー（tanacode-walkthrough）の入り口。Claude Code が --mcp-config に従って起動する（stdio）。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// ソケットのパスとセッションは、--mcp-config の env で受け取る
import { WALKTHROUGH_MCP } from '@shared/walkthrough-tools';
import { callBridge } from './mcp-bridge';
import { runRelay } from './mcp-relay';
import { WALKTHROUGH_CALL_TIMEOUT_MS, WALKTHROUGH_CLOSED_MESSAGE, WALKTHROUGH_SESSION_ENV, WALKTHROUGH_SOCKET_ENV } from './walkthrough-bridge';

const socketPath = process.env[WALKTHROUGH_SOCKET_ENV] ?? '';
const session = process.env[WALKTHROUGH_SESSION_ENV] ?? '';

runRelay(
  process.stdin,
  process.stdout,
  {
    server: WALKTHROUGH_MCP,
    version: process.env.TANACODE_VERSION ?? '0.0.0',
    call: (tool, args, signal) => callBridge(socketPath, { session, tool, args }, WALKTHROUGH_CALL_TIMEOUT_MS, WALKTHROUGH_CLOSED_MESSAGE, signal),
  },
  // Claude Code が終われば、標準入力が閉じる
  () => process.exit(0),
);
