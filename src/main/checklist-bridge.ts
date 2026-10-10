import { CHECKLIST_MCP } from '@shared/checklist-tools';
import { mcpServerEntry, type McpLaunch, type McpServerEntry } from './mcp-bridge';

// チェックリストの中継（checklist-mcp.ts。Claude Code が起動する MCP サーバー）に渡すもの。ソケットのやりとりは mcp-bridge.ts

// 中継に渡す環境変数（--mcp-config の env）。ソケットのパスと、どのセッションの Claude Code か
export const CHECKLIST_SOCKET_ENV = 'TANACODE_CHECKLIST_SOCKET';
export const CHECKLIST_SESSION_ENV = 'TANACODE_CHECKLIST_SESSION';

// アプリが起動していないとき、中継が Claude に返す文
export const CHECKLIST_CLOSED_MESSAGE = 'tanacode is not running. To use checklists, ask the user to start tanacode.';

// 中継が 1 回の呼び出しを待つ上限（チェックリストの読み書きはすぐ終わる）
export const CHECKLIST_CALL_TIMEOUT_MS = 30_000;

// --mcp-config に入れるチェックリストのサーバー。sessionId: どのセッションの Claude Code か（中継の env で渡す）
export function checklistMcpServer(launch: McpLaunch, sessionId: string): McpServerEntry {
  return mcpServerEntry(CHECKLIST_MCP, launch, { [CHECKLIST_SOCKET_ENV]: launch.socketPath, [CHECKLIST_SESSION_ENV]: sessionId });
}
