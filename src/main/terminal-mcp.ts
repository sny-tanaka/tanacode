// 人のターミナルの MCP サーバー（tanacode-terminal）の入り口。Claude Code が --mcp-config に従って起動する（stdio）。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// ソケットのパスとセッションは、--mcp-config の env で受け取る。
// --gate を付けて動かしたときは、MCP サーバーではなく、打つ前の確認のフックとして働く（terminal-bridge.ts）。標準入力に、フックの入力の JSON が届く
import { isLanguage, setLanguage } from '@shared/i18n';
import { TERMINAL_MCP, TERMINAL_MCP_FOR_CHILD } from '@shared/terminal-tools';
import { appHookOutput } from './hook-output';
import { callBridge, MCP_LANGUAGE_ENV } from './mcp-bridge';
import { runRelay } from './mcp-relay';
import {
  runTerminalGate,
  TERMINAL_CALL_TIMEOUT_MS,
  TERMINAL_CHILD_ENV,
  TERMINAL_CLOSED_MESSAGE,
  TERMINAL_GATE_ARG,
  TERMINAL_SESSION_ENV,
  TERMINAL_SOCKET_ENV,
} from './terminal-bridge';

const socketPath = process.env[TERMINAL_SOCKET_ENV] ?? '';
const session = process.env[TERMINAL_SESSION_ENV] ?? '';

// フックが待つ上限。確認を出させる側に倒せばよいので、短くてよい
const GATE_TIMEOUT_MS = 5_000;

// 標準入力を最後まで読む。閉じられなくても、上限を過ぎたらそこまでで進める
function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const done = () => {
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (text += chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

if (process.argv.includes(TERMINAL_GATE_ARG)) {
  // 確認の理由は、Claude Code を起動したときのアプリの言語で書く
  const lang = process.env[MCP_LANGUAGE_ENV];
  if (isLanguage(lang)) setLanguage(lang);
  void readStdin(GATE_TIMEOUT_MS)
    .then((input) => runTerminalGate(socketPath, session, input, GATE_TIMEOUT_MS))
    .then((output) => process.stdout.write(`${appHookOutput(output)}\n`, () => process.exit(0)));
} else {
  runRelay(
    process.stdin,
    process.stdout,
    {
      // 子セッションには、読むツールだけを見せる
      server: process.env[TERMINAL_CHILD_ENV] === '1' ? TERMINAL_MCP_FOR_CHILD : TERMINAL_MCP,
      version: process.env.TANACODE_VERSION ?? '0.0.0',
      call: (tool, args, signal) => callBridge(socketPath, { session, tool, args }, TERMINAL_CALL_TIMEOUT_MS, TERMINAL_CLOSED_MESSAGE, signal),
    },
    // Claude Code が終われば、標準入力が閉じる
    () => process.exit(0),
  );
}
