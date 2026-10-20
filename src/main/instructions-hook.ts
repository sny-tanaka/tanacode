// TANACODE.md を Claude に渡す SessionStart のフックの入り口。アプリが起動する Claude Code に、--settings で足す（statusline.ts の ownSettings）。
// tanacode 本体を Node として（ELECTRON_RUN_AS_NODE）動かすので、Node.js を別に入れる必要はない。Electron の API は使わない。
// 探すフォルダ（セッションのフォルダと、プロファイルのフォルダ）は、起動する Claude Code の環境変数で受け取る（instructionsHookEnv）。アプリには聞かない（アプリが止まっていても渡せる）
import { appHookOutput } from './hook-output';
import { INSTRUCTIONS_DIRS_ENV, INSTRUCTIONS_PROFILE_ENV } from './instructions-launch';
import { runInstructionsHook } from './project-instructions';

function dirsOf(value: string | undefined): string[] {
  try {
    const dirs: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string' && d !== '') : [];
  } catch {
    return [];
  }
}

// Claude Code は、フックの標準入力に JSON を書いて閉じる。入力は最後まで読む（読み終える前に閉じると、フックの失敗になる。hook-output.ts）
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => (stdin += chunk));
process.stdin.on('end', () => {
  let output = '';
  try {
    output = runInstructionsHook(stdin, dirsOf(process.env[INSTRUCTIONS_DIRS_ENV]), process.env[INSTRUCTIONS_PROFILE_ENV] || null);
  } catch {
    // 読めなくても Claude の作業は止めない（何も渡さない）
  }
  // 何も渡さないときも、アプリのフックの印（suppressOutput）を書く（hook-output.ts）
  process.stdout.write(`${appHookOutput(output)}\n`, () => process.exit(0));
});
