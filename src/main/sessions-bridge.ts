import { SESSIONS_GATE_HOOK_ENV } from '@shared/chat';
import { t } from '@shared/i18n';
import { SESSIONS_MCP, SESSIONS_MCP_FOR_CHILD, sessionToolId } from '@shared/session-tools';
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
export const SESSIONS_CLOSED_MESSAGE = 'tanacode が起動していません。ほかのセッションを扱うには、ユーザーに tanacode を起動してもらってください';

// 子セッションを待つ（wait_sessions）上限。アプリはこの時間で待つのをやめて、そのときの状態を返す
export const WAIT_MAX_SECONDS = 600;
// 中継が 1 回の呼び出しを待つ上限と、Claude Code が中継を待つ上限（--mcp-config の timeout）。アプリの待ちより長くする
export const SESSIONS_CALL_TIMEOUT_MS = (WAIT_MAX_SECONDS + 60) * 1000;
const CLAUDE_TIMEOUT_MS = SESSIONS_CALL_TIMEOUT_MS + 60_000;

// 子セッションの起動（start_session）の前に、権限モードによらず人の許可の確認を出させるフック（--settings の PreToolUse）。
// 許可の確認は auto・bypassPermissions では出ないので、フックで ask を返す（勝手にセッションを開かせない）。
// 子も利用枠を使うことを、確認の理由に書く（Claude Code を起動するときの言語で。シェルの単一引用符に埋め込むので、理由に ' を含めない）。
// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
export function sessionsGateCommand(): string {
  const output = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: t('main.hooks.sessionsGate') },
  });
  return `${SESSIONS_GATE_HOOK_ENV}=1 printf '%s\\n' '${output}'`;
}
export const SESSIONS_GATED_TOOL = sessionToolId('start_session');

// --mcp-config に入れるセッションのサーバー。sessionId: どのセッションの Claude Code か（中継の env で渡す）
export function sessionsMcpServer(launch: SessionsMcpLaunch, sessionId: string): McpServerEntry {
  const env = { [SESSIONS_SOCKET_ENV]: launch.socketPath, [SESSIONS_SESSION_ENV]: sessionId, ...(launch.child ? { [SESSIONS_CHILD_ENV]: '1' } : {}) };
  return mcpServerEntry(launch.child ? SESSIONS_MCP_FOR_CHILD : SESSIONS_MCP, launch, env, CLAUDE_TIMEOUT_MS);
}
