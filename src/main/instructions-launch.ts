import { INSTRUCTIONS_HOOK_ENV } from '@shared/chat';

// TANACODE.md を渡す SessionStart のフック（instructions-hook.ts）を、アプリが起動する Claude Code に足すための材料。
// フックは Claude Code の環境で動くので、実行ファイル・スクリプト・探すフォルダを、起動する Claude Code の環境変数で渡す
// （チェックリストのフックと同じ作り。checklist-bridge.ts の checklistHookEnv）
export const INSTRUCTIONS_COMMAND_ENV = 'TANACODE_INSTRUCTIONS_COMMAND';
export const INSTRUCTIONS_SCRIPT_ENV = 'TANACODE_INSTRUCTIONS_SCRIPT';
// 探すフォルダ（JSON の配列。セッションのフォルダ、worktree のセッションなら元のリポジトリの順）
export const INSTRUCTIONS_DIRS_ENV = 'TANACODE_INSTRUCTIONS_DIRS';

// フックを動かす実行ファイル（tanacode 本体の Helper を Node として。互換性の確認では node）と、フックのスクリプト（instructions-hook.js）
export type InstructionsLaunch = { command: string; script: string };

// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
export const INSTRUCTIONS_HOOK_COMMAND = `${INSTRUCTIONS_HOOK_ENV}=1 ELECTRON_RUN_AS_NODE=1 "$${INSTRUCTIONS_COMMAND_ENV}" "$${INSTRUCTIONS_SCRIPT_ENV}"`;

// フックが待つ上限（秒）。ファイルを読むだけなので、ふつうはすぐ終わる
const HOOK_TIMEOUT_SECONDS = 10;

// --settings の hooks の SessionStart に足すもの。新しい会話（startup）・再開（resume）・/clear（clear）・圧縮のあと（compact）のどれでも動き、
// その都度ファイルを読む（書き換えたら、次にどれかが起きたときから効く）。どれも -p でも動く（Claude Code 2.1.303 で実測）
export function instructionsHooks(): unknown[] {
  return [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: INSTRUCTIONS_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }] }];
}

// 起動する Claude Code の環境に足す、フックが使う環境変数
export function instructionsHookEnv(launch: InstructionsLaunch, dirs: readonly string[]): Record<string, string> {
  return {
    [INSTRUCTIONS_COMMAND_ENV]: launch.command,
    [INSTRUCTIONS_SCRIPT_ENV]: launch.script,
    [INSTRUCTIONS_DIRS_ENV]: JSON.stringify(dirs),
  };
}
