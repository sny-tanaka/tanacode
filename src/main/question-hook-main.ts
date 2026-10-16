// AskUserQuestion の質問をアプリに渡して答えを待つフック（question-hook.ts）の入り口。Claude Code が PermissionRequest のフックとして起動する。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// ソケットのパスとセッションは、起動する Claude Code の環境変数で受け取る（questionHookEnv）
import { QUESTION_HOOK_TIMEOUT_SECONDS, QUESTION_SESSION_ENV, QUESTION_SOCKET_ENV, runQuestionHook } from './question-hook';

// フックの標準入力（質問の入力）を待つ上限。Claude Code は書いたらすぐ閉じる。来なければ、何も決めずに終わる
const INPUT_TIMEOUT_MS = 2_000;

// 標準入力を閉じられるまで読む（上限を過ぎたら、そこまでのもの）
function readInput(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, INPUT_TIMEOUT_MS);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

void readInput()
  .then((input) => runQuestionHook(process.env[QUESTION_SOCKET_ENV] ?? '', process.env[QUESTION_SESSION_ENV] ?? '', QUESTION_HOOK_TIMEOUT_SECONDS * 1000, input))
  .then((output) => (output ? process.stdout.write(`${output}\n`, () => process.exit(0)) : process.exit(0)));
