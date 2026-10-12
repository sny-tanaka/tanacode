import type { ReminderEvent } from '@shared/checklist-reminder';
import { CHECKLIST_MCP } from '@shared/checklist-tools';
import { mcpServerEntry, type McpLaunch, type McpServerEntry } from './mcp-bridge';

// チェックリストの中継（checklist-mcp.ts。Claude Code が起動する MCP サーバー）に渡すもの。ソケットのやりとりは mcp-bridge.ts

// 中継に渡す環境変数（--mcp-config の env）。ソケットのパスと、どのセッションの Claude Code か
export const CHECKLIST_SOCKET_ENV = 'TANACODE_CHECKLIST_SOCKET';
export const CHECKLIST_SESSION_ENV = 'TANACODE_CHECKLIST_SESSION';
// 中継の入口（checklist-mcp.js）を、チェックリストを使い続けさせるフック（checklist-hook.ts）として動かすための環境変数。
// フックは Claude Code の環境で動くので、起動する Claude Code の環境に足す（--mcp-config の env は、MCP サーバーにしか届かない）
export const CHECKLIST_COMMAND_ENV = 'TANACODE_CHECKLIST_COMMAND';
export const CHECKLIST_SCRIPT_ENV = 'TANACODE_CHECKLIST_SCRIPT';

// フックがアプリに、今のチェックリストと Claude に渡す文を聞く、中継の内部の呼び出し。MCP のツールではない
const HOOK_REQUEST = 'hook:';
export function checklistHookRequest(event: ReminderEvent): string {
  return `${HOOK_REQUEST}${event}`;
}
export function checklistHookEvent(tool: string): ReminderEvent | null {
  const event = tool.startsWith(HOOK_REQUEST) ? tool.slice(HOOK_REQUEST.length) : '';
  return event === 'prompt' || event === 'stop' || event === 'compact' ? event : null;
}

// アプリが起動していないとき、中継が Claude に返す文
// 圧縮の前のフック（PreCompact）が、アプリに「止めるか」を聞く呼び出し。チェックリストの中継を通るが、答えるのは自動の最適化圧縮（AutoCompact）
export const PRECOMPACT_HOOK_REQUEST = 'hook:precompact';

export const CHECKLIST_CLOSED_MESSAGE = 'tanacode is not running. To use checklists, ask the user to start tanacode.';

// 中継が 1 回の呼び出しを待つ上限（チェックリストの読み書きはすぐ終わる）
export const CHECKLIST_CALL_TIMEOUT_MS = 30_000;

// --mcp-config に入れるチェックリストのサーバー。sessionId: どのセッションの Claude Code か（中継の env で渡す）
export function checklistMcpServer(launch: McpLaunch, sessionId: string): McpServerEntry {
  return mcpServerEntry(CHECKLIST_MCP, launch, { [CHECKLIST_SOCKET_ENV]: launch.socketPath, [CHECKLIST_SESSION_ENV]: sessionId });
}

// 起動する Claude Code の環境に足す、チェックリストを使い続けさせるフックが使う環境変数
export function checklistHookEnv(launch: McpLaunch, sessionId: string): Record<string, string> {
  return {
    [CHECKLIST_SOCKET_ENV]: launch.socketPath,
    [CHECKLIST_SESSION_ENV]: sessionId,
    [CHECKLIST_COMMAND_ENV]: launch.command,
    [CHECKLIST_SCRIPT_ENV]: launch.script,
  };
}
