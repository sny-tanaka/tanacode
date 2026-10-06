import { WALKTHROUGH_MCP } from '@shared/walkthrough-tools';
import { mcpServerEntry, type McpLaunch, type McpServerEntry } from './mcp-bridge';

// ウォークスルーの中継（walkthrough-mcp.ts。Claude Code が起動する MCP サーバー）に渡すもの。ソケットのやりとりは mcp-bridge.ts

// 中継に渡す環境変数（--mcp-config の env）。ソケットのパスと、どのセッションの Claude Code か
export const WALKTHROUGH_SOCKET_ENV = 'TANACODE_WALKTHROUGH_SOCKET';
export const WALKTHROUGH_SESSION_ENV = 'TANACODE_WALKTHROUGH_SESSION';

// アプリが起動していないとき、中継が Claude に返す文
export const WALKTHROUGH_CLOSED_MESSAGE = 'tanacode が起動していません。コードを示すには、ユーザーに tanacode を起動してもらってください';

// 中継が 1 回の呼び出しを待つ上限（ファイルの行数を確かめるだけで、人の操作は待たない）
export const WALKTHROUGH_CALL_TIMEOUT_MS = 30_000;

// --mcp-config に入れるウォークスルーのサーバー。sessionId: どのセッションの Claude Code か（中継の env で渡す）
export function walkthroughMcpServer(launch: McpLaunch, sessionId: string): McpServerEntry {
  return mcpServerEntry(WALKTHROUGH_MCP, launch, { [WALKTHROUGH_SOCKET_ENV]: launch.socketPath, [WALKTHROUGH_SESSION_ENV]: sessionId });
}
