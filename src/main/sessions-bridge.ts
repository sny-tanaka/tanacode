import { SESSIONS_MCP, SESSIONS_MCP_FOR_CHILD } from '@shared/session-tools';
import { mcpServerEntry, type McpLaunch, type McpServerEntry } from './mcp-bridge';

// セッションの中継（sessions-mcp.ts。Claude Code が起動する MCP サーバー）に渡すもの。ソケットのやりとりは mcp-bridge.ts

// 中継に渡す環境変数（--mcp-config の env）。ソケットのパスと、どのセッションの Claude Code か（呼び出し元。親子の関係はアプリの記録で判断する）
export const SESSIONS_SOCKET_ENV = 'TANACODE_SESSIONS_SOCKET';
export const SESSIONS_SESSION_ENV = 'TANACODE_SESSIONS_SESSION';
// 子セッションの中継なら 1。子を動かすツールを、ツールの一覧に出さない
export const SESSIONS_CHILD_ENV = 'TANACODE_SESSIONS_CHILD';

// child: 子セッションに足す（子を動かすツールを出さない）
export type SessionsMcpLaunch = McpLaunch & { child?: boolean };

// アプリが起動していないとき、中継が Claude に返す文
export const SESSIONS_CLOSED_MESSAGE = 'tanacode is not running. To work with other sessions, ask the user to start tanacode.';

// 子セッションを待つ（wait_sessions）上限。アプリはこの時間で待つのをやめて、そのときの状態を返す。
// 待っている間は人の発言が届かないので、長く待たせない（子の作業の終わりは、親への知らせと予約で待つ）
export const WAIT_MAX_SECONDS = 60;
// 中継が 1 回の呼び出しを待つ上限と、Claude Code が中継を待つ上限（--mcp-config の timeout）。wait_sessions の待ちより長く、
// 時間のかかるほかのツール（end_session の worktree の削除・PR の問い合わせなど）も収まるよう、11 分にしておく
export const SESSIONS_CALL_TIMEOUT_MS = 11 * 60_000;
const CLAUDE_TIMEOUT_MS = SESSIONS_CALL_TIMEOUT_MS + 60_000;

// --mcp-config に入れるセッションのサーバー。sessionId: どのセッションの Claude Code か（中継の env で渡す）
export function sessionsMcpServer(launch: SessionsMcpLaunch, sessionId: string): McpServerEntry {
  const env = { [SESSIONS_SOCKET_ENV]: launch.socketPath, [SESSIONS_SESSION_ENV]: sessionId, ...(launch.child ? { [SESSIONS_CHILD_ENV]: '1' } : {}) };
  return mcpServerEntry(launch.child ? SESSIONS_MCP_FOR_CHILD : SESSIONS_MCP, launch, env, CLAUDE_TIMEOUT_MS);
}
