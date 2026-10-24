// worktree-guard（worktree-guard.ts）の確かめの入り口。awk が「確認を出させる」と決めたコマンドだけ、フックがこれを動かす。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// アプリには聞かない（git と gh を直に動かす）。標準出力に、確かめた結果（pass か ask）だけを書く。読めない・時間がかかりすぎる
// ときは ask（フックは、確認を出させる）
import { GUARD_DEADLINE_MS, type GuardVerdict, verifyCommand } from './worktree-guard-check';

function decide(text: string): Promise<GuardVerdict> {
  const input = JSON.parse(text) as { cwd?: unknown; tool_input?: { command?: unknown } };
  const command = input.tool_input?.command;
  const cwd = input.cwd;
  if (typeof command !== 'string' || typeof cwd !== 'string' || cwd === '') return Promise.resolve('ask');
  return verifyCommand(command, cwd);
}

// Claude Code は、フックの標準入力に JSON を書いて閉じる（ここでは、フックのシェルが awk に渡したものと同じものを渡す）
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => (stdin += chunk));
process.stdin.on('end', () => {
  const late = new Promise<GuardVerdict>((resolve) => setTimeout(() => resolve('ask'), GUARD_DEADLINE_MS).unref());
  Promise.race([Promise.resolve().then(() => decide(stdin)), late])
    .catch((): GuardVerdict => 'ask')
    .then((verdict) => process.stdout.write(`${verdict}\n`, () => process.exit(0)));
});
