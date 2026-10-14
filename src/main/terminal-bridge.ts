import { TERMINAL_GATE_HOOK_ENV } from '@shared/chat';
import { language, t } from '@shared/i18n';
import { readTypeInput, TERMINAL_MCP, TERMINAL_MCP_FOR_CHILD, terminalToolId, typedPreview } from '@shared/terminal-tools';
import { callBridge, MCP_LANGUAGE_ENV, mcpServerEntry, type McpLaunch, type McpServerEntry, type ToolResult } from './mcp-bridge';

// 人のターミナルの中継（terminal-mcp.ts。Claude Code が起動する MCP サーバー）に渡すものと、打つ前の確認のフック。ソケットのやりとりは mcp-bridge.ts。
// 打つ前の確認（type_in_terminal の PreToolUse）は、アプリ内ブラウザの JavaScript の実行の確認（browser-gate.ts）と同じ形:
// 1. フックは中継の入口（terminal-mcp.js）を --gate 付きで動かす。中継は標準入力の tool_input を読み、アプリにソケットで問い合わせる
// 2. アプリは打つものを確かめて「確認済みの印」を控え（terminal-control.ts）、タブの名前を返す。フックは ask と、タブの名前と打つものを入れた理由を返す
// 3. ツールの呼び出しがアプリに届いたら、アプリは印を確かめて使い切る。印が無ければ断る（フックが動かなかったときの備え）
// 権限モード（auto・bypassPermissions を含む）や「次から聞かない」によらず、毎回確認が出る（実測は test/cli/terminal.test.ts）。
// アプリに聞けなかったときも、確認を出させる

// 中継に渡す環境変数（--mcp-config の env）。ソケットのパスと、どのセッションの Claude Code か（呼び出し元。親子の関係はアプリの記録で判断する）
export const TERMINAL_SOCKET_ENV = 'TANACODE_TERMINAL_SOCKET';
export const TERMINAL_SESSION_ENV = 'TANACODE_TERMINAL_SESSION';
// 子セッションの中継なら 1。打つツールを、ツールの一覧に出さない
export const TERMINAL_CHILD_ENV = 'TANACODE_TERMINAL_CHILD';
// 中継の入口を、打つ前の確認のフックとして動かすための環境変数。
// フックは Claude Code の環境で動くので、起動する Claude Code の環境に足す（--mcp-config の env は、MCP サーバーにしか届かない）
export const TERMINAL_COMMAND_ENV = 'TANACODE_TERMINAL_COMMAND';
export const TERMINAL_SCRIPT_ENV = 'TANACODE_TERMINAL_SCRIPT';
// フックがアプリに、打つものを確かめて印を控えるよう頼む、中継の内部の呼び出し。MCP のツールではない
export const TERMINAL_GATE_REQUEST = 'gate:type';
// 入口に付けると、中継（MCP サーバー）ではなくフックとして動く
export const TERMINAL_GATE_ARG = '--gate';

// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
export const TERMINAL_GATE_COMMAND = `${TERMINAL_GATE_HOOK_ENV}=1 ELECTRON_RUN_AS_NODE=1 "$${TERMINAL_COMMAND_ENV}" "$${TERMINAL_SCRIPT_ENV}" ${TERMINAL_GATE_ARG}`;
export const TERMINAL_GATED_TOOL = terminalToolId('type_in_terminal');

// アプリが起動していないとき、中継が Claude に返す文
export const TERMINAL_CLOSED_MESSAGE = "tanacode is not running. To use the user's terminal, ask the user to start tanacode.";

// 中継が 1 回の呼び出しを待つ上限。打つツールは、出力が止まるのを最大 3 秒待つ（新しいタブは、シェルが起動するのも待つ）
export const TERMINAL_CALL_TIMEOUT_MS = 30_000;

// child: 子セッションに足す（打つツールを出さず、確認のフックも足さない）
export type TerminalMcpLaunch = McpLaunch & { child?: boolean };

// --mcp-config に入れるターミナルのサーバー。sessionId: どのセッションの Claude Code か（中継の env で渡す）
export function terminalMcpServer(launch: TerminalMcpLaunch, sessionId: string): McpServerEntry {
  const env = { [TERMINAL_SOCKET_ENV]: launch.socketPath, [TERMINAL_SESSION_ENV]: sessionId, ...(launch.child ? { [TERMINAL_CHILD_ENV]: '1' } : {}) };
  return mcpServerEntry(launch.child ? TERMINAL_MCP_FOR_CHILD : TERMINAL_MCP, launch, env);
}

// 起動する Claude Code の環境に足す、打つ前の確認のフックが使う環境変数。確認の理由は、Claude Code を起動したときのアプリの言語で書く
export function terminalGateEnv(launch: TerminalMcpLaunch, sessionId: string): Record<string, string> {
  return {
    [TERMINAL_SOCKET_ENV]: launch.socketPath,
    [TERMINAL_SESSION_ENV]: sessionId,
    [TERMINAL_COMMAND_ENV]: launch.command,
    [TERMINAL_SCRIPT_ENV]: launch.script,
    [MCP_LANGUAGE_ENV]: language(),
  };
}

// アプリが答える、打つ先のタブの名前と、打つもの
export type TerminalGateAnswer = { tab: string; typed: string };

// アプリのエラーの返事や、形の違う返事は null
export function readGateAnswer(result: ToolResult): TerminalGateAnswer | null {
  if (result.isError) return null;
  const first = result.content[0];
  if (first?.type !== 'text') return null;
  try {
    const value = JSON.parse(first.text) as Partial<TerminalGateAnswer>;
    return typeof value.tab === 'string' && typeof value.typed === 'string' ? { tab: value.tab, typed: value.typed } : null;
  } catch {
    return null;
  }
}

// フックが標準出力に書く JSON（Claude Code の PreToolUse の出力）。どの場合も ask（確認を出させる）。
// アプリに確かめられなかったときは、フックが受け取った入力から、打つものを出す
export function terminalGateOutput(answer: TerminalGateAnswer | null, input: Record<string, unknown>): string {
  let reason: string;
  if (answer) reason = t('main.hooks.terminalGate', { tab: answer.tab, typed: answer.typed });
  else {
    const read = readTypeInput(input);
    reason = t('main.hooks.terminalGateUnknown', { typed: typeof read === 'string' ? JSON.stringify(input.text ?? input.key ?? '') : typedPreview(read) });
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } });
}

// フックの本体。hookInput: Claude Code がフックの標準入力に渡した JSON（tool_input に type_in_terminal の入力）。
// アプリに印を控えさせ、標準出力に書く内容を返す
export async function runTerminalGate(socketPath: string, session: string, hookInput: string, timeoutMs: number): Promise<string> {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(hookInput) as { tool_input?: unknown };
    if (parsed.tool_input && typeof parsed.tool_input === 'object' && !Array.isArray(parsed.tool_input)) input = parsed.tool_input as Record<string, unknown>;
  } catch {
    // 読めない入力。アプリに確かめられないので、確認を出させる
    return terminalGateOutput(null, input);
  }
  const result = await callBridge(socketPath, { session, tool: TERMINAL_GATE_REQUEST, args: input }, timeoutMs, TERMINAL_CLOSED_MESSAGE);
  return terminalGateOutput(readGateAnswer(result), input);
}
