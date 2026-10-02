// アプリ内ブラウザの MCP サーバーの入り口。Claude Code が --mcp-config に従って起動する（stdio）。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// ソケットのパスとセッションは、--mcp-config の env で受け取る
import { BROWSER_SESSION_ENV, BROWSER_SOCKET_ENV, callBridge } from './browser-bridge';
import { runRelay } from './browser-relay';

// 1 回の呼び出しを待つ上限。アプリ側の待ち（要素が出るまで待つ・読み込み）より長くする
const CALL_TIMEOUT_MS = 90_000;

const socketPath = process.env[BROWSER_SOCKET_ENV] ?? '';
const session = process.env[BROWSER_SESSION_ENV] ?? '';

runRelay(
  process.stdin,
  process.stdout,
  {
    version: process.env.TANACODE_VERSION ?? '0.0.0',
    call: (tool, args) => callBridge(socketPath, { session, tool, args }, CALL_TIMEOUT_MS),
  },
  // Claude Code が終われば、標準入力が閉じる
  () => process.exit(0),
);
