import { chatMessage, REJECTED } from './requests';
import { QUESTION_HOOK_ENV } from '@shared/chat';
import { questionReplyOf, type QuestionReply } from '@shared/questions';
import { askQuestionsOf } from './screen-parser';
import { callBridge, type McpLaunch, type ToolResult } from './mcp-bridge';

// AskUserQuestion の質問を、ターミナルの画面を読まずに受け取って答えるフック。アプリが起動する Claude Code に、--settings で
// PermissionRequest のフックとして足す（statusline.ts の ownSettings）。フックは質問の入力をアプリに渡し、アプリの返事（質問のカード・
// 親の answer_question）を待って、Claude Code に返す。
// - 答え: decision の allow と updatedInput.answers（質問文 → 答え）。会話ログには、画面で答えたときと同じ結果が書かれる
// - Chat about this: deny と、画面で選んだときと同じ文 / キャンセル: deny と interrupt（画面の Esc と同じく、作業を止める）
// フックが待っている間も、Claude Code は画面に質問を出していて、人はターミナルや Remote Control でも答えられる。そちらで答えると、
// Claude Code はフックを待たずに進む（フックの返事は使われない）。アプリは会話ログで答えを見て、待っているフックを終わらせる。
// アプリにつながらない・つながりが切れた（アプリを終えた・起動し直した）ときは、何も返さずにすぐ終わる。質問は画面に出たままなので、
// 人がターミナルで答えるか、アプリが画面を読む道（予備）で答える。待ち続けるプロセスを残さないため、つなぎ直しはしない。
// 以上は、Claude Code 2.1.296 をモックの API で動かして確かめた（manual・acceptEdits・auto・bypassPermissions のどれでも動く）。
// フックの入口は question-hook-main.ts。環境変数は questionHookEnv が、起動する Claude Code に足す

// フックに渡す環境変数。ソケットのパス・どのセッションの Claude Code か・入口を動かす実行ファイルとスクリプト
// （フックは Claude Code の環境で動くので、起動する Claude Code の環境に足す）
export const QUESTION_SOCKET_ENV = 'TANACODE_QUESTION_SOCKET';
export const QUESTION_SESSION_ENV = 'TANACODE_QUESTION_SESSION';
export const QUESTION_COMMAND_ENV = 'TANACODE_QUESTION_COMMAND';
export const QUESTION_SCRIPT_ENV = 'TANACODE_QUESTION_SCRIPT';

// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
export const QUESTION_HOOK_COMMAND = `${QUESTION_HOOK_ENV}=1 ELECTRON_RUN_AS_NODE=1 "$${QUESTION_COMMAND_ENV}" "$${QUESTION_SCRIPT_ENV}"`;

// フックを待たせる上限（秒）。人が席を外していても、たいていは答えられる長さ。過ぎると Claude Code がフックを止め（SIGTERM）、
// 質問は画面に残る（画面を読む道で答える）
export const QUESTION_HOOK_TIMEOUT_SECONDS = 24 * 60 * 60;

// フックがアプリに質問を渡して、返事を待つ呼び出し（MCP のツールではない）
export const QUESTION_WAIT_REQUEST = 'question:wait';

// --settings の hooks の PermissionRequest に足すもの
export function questionHook(): Record<string, unknown> {
  return { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: QUESTION_HOOK_COMMAND, timeout: QUESTION_HOOK_TIMEOUT_SECONDS }] };
}

// 起動する Claude Code の環境に足す、フックが使う環境変数
export function questionHookEnv(launch: McpLaunch, sessionId: string): Record<string, string> {
  return {
    [QUESTION_SOCKET_ENV]: launch.socketPath,
    [QUESTION_SESSION_ENV]: sessionId,
    [QUESTION_COMMAND_ENV]: launch.command,
    [QUESTION_SCRIPT_ENV]: launch.script,
  };
}

// 画面で「Chat about this」を選んだときに、Claude Code が Claude に返す文（stream-json の答えと同じもの。requests.ts）
export { chatMessage } from './requests';

// フックの標準入力（Claude Code の PermissionRequest の入力）のうち、使うもの。読めなければ null
export function readHookInput(text: string): { tool: string; input: Record<string, unknown> } | null {
  try {
    const value = JSON.parse(text) as { tool_name?: unknown; tool_input?: unknown };
    const input = value.tool_input;
    if (typeof value.tool_name !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) return null;
    return { tool: value.tool_name, input: input as Record<string, unknown> };
  } catch {
    return null;
  }
}

// アプリの返事。待つのをやめた（人がターミナルで答えた・アプリが取り下げた）・エラー・形の違うものは null（何も返さない）
export function readReply(result: ToolResult): QuestionReply | null {
  if (result.isError) return null;
  const first = result.content[0];
  if (first?.type !== 'text') return null;
  try {
    return questionReplyOf(JSON.parse(first.text));
  } catch {
    return null;
  }
}

// フックが標準出力に書く JSON（Claude Code の PermissionRequest の出力）。返事が無ければ空（何も決めない。画面の質問がそのまま残る）。
// input: Claude Code から受け取った AskUserQuestion の入力（答えは、これに answers を足して返す）
export function questionHookOutput(input: Record<string, unknown>, reply: QuestionReply | null): string {
  if (!reply) return '';
  const decide = (decision: Record<string, unknown>) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
  if (reply.kind === 'answer') return decide({ behavior: 'allow', updatedInput: { ...input, answers: reply.answers } });
  if (reply.kind === 'cancel') return decide({ behavior: 'deny', message: REJECTED, interrupt: true });
  const questions = askQuestionsOf(input) ?? [];
  return decide({ behavior: 'deny', message: chatMessage(questions.map((q) => q.question)) });
}

// フックの本体。アプリに質問を渡して返事を待ち、標準出力に書く内容を返す。hookInput: 標準入力に届いた JSON
export async function runQuestionHook(socketPath: string, session: string, timeoutMs: number, hookInput: string): Promise<string> {
  const read = readHookInput(hookInput);
  // ほかのツールで呼ばれた（フックの設定と合わない）・入力が読めないときは、何も決めない
  if (!read || read.tool !== 'AskUserQuestion' || !askQuestionsOf(read.input)) return '';
  const result = await callBridge(socketPath, { session, tool: QUESTION_WAIT_REQUEST, args: { input: read.input } }, timeoutMs, 'tanacode is not running.');
  return questionHookOutput(read.input, readReply(result));
}
