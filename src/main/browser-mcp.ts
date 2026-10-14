// アプリ内ブラウザの MCP サーバーの入り口。Claude Code が --mcp-config に従って起動する（stdio）。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// ソケットのパスとセッションは、--mcp-config の env で受け取る
// --gate を付けて動かしたときは、MCP サーバーではなく、JavaScript の実行と開く先の確認のフックとして働く（browser-gate.ts）
import { BROWSER_ASK_TIMEOUT_MS, BROWSER_ASK_TOOL, BROWSER_MCP } from '@shared/browser-tools';
import { isLanguage, setLanguage } from '@shared/i18n';
import { BROWSER_CLOSED_MESSAGE, BROWSER_LANGUAGE_ENV, BROWSER_SESSION_ENV, BROWSER_SOCKET_ENV } from './browser-bridge';
import { BROWSER_GATE_ARG, runGate } from './browser-gate';
import { callBridge } from './mcp-bridge';
import { runRelay } from './mcp-relay';

// 1 回の呼び出しを待つ上限。アプリ側の待ち（要素が出るまで待つ・読み込み）より長くする
const CALL_TIMEOUT_MS = 90_000;
// ユーザーに操作を頼む呼び出しは、ユーザーの返事を待つ。上限を過ぎたらアプリが「時間切れ」を返すので、それより少し長くする
const ASK_CALL_TIMEOUT_MS = BROWSER_ASK_TIMEOUT_MS + 30_000;

const socketPath = process.env[BROWSER_SOCKET_ENV] ?? '';
const session = process.env[BROWSER_SESSION_ENV] ?? '';

// フックが待つ上限。確認を出させる側に倒せばよいので、短くてよい
const GATE_TIMEOUT_MS = 5_000;
// フックの標準入力（ツールの名前と入力）を待つ上限。Claude Code は書いたらすぐ閉じる。来なければ、ツールが分からないものとして確認を出させる
const GATE_INPUT_TIMEOUT_MS = 2_000;

// 標準入力を閉じられるまで読む（上限を過ぎたら、そこまでのもの）
function readInput(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, GATE_INPUT_TIMEOUT_MS);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

if (process.argv.includes(BROWSER_GATE_ARG)) {
  // 確認の理由は、Claude Code を起動したときのアプリの言語で書く
  const lang = process.env[BROWSER_LANGUAGE_ENV];
  if (isLanguage(lang)) setLanguage(lang);
  void readInput()
    .then((input) => runGate(socketPath, session, GATE_TIMEOUT_MS, input))
    .then((output) => process.stdout.write(`${output}\n`, () => process.exit(0)));
} else {
  runRelay(
    process.stdin,
    process.stdout,
    {
      server: BROWSER_MCP,
      version: process.env.TANACODE_VERSION ?? '0.0.0',
      call: (tool, args, signal) =>
        callBridge(socketPath, { session, tool, args }, tool === BROWSER_ASK_TOOL ? ASK_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS, BROWSER_CLOSED_MESSAGE, signal),
    },
    // Claude Code が終われば、標準入力が閉じる
    () => process.exit(0),
  );
}
