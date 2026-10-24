import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

// 子セッションの起動の確認を省く印のファイル（userData に置く。アプリ全体で 1 つ）。メニューの「MCP → セッションを始める前に許可を求める」を
// オフにしている間だけ置く。起動の確認のフックは、呼ばれるたびにこのファイルがあるかを見るので、切り替えは動いているセッションにもすぐ効く
export const SESSIONS_NO_ASK_FILE = 'sessions-start-no-ask';
// 印のファイルのパスを、起動の確認のフックに渡す環境変数（起動する Claude Code の環境に足す。フックは Claude Code の環境で動く）
export const SESSIONS_NO_ASK_ENV = 'TANACODE_SESSIONS_NO_ASK_FILE';

// child: 子セッションに足す（子を動かすツールを出さない）/ noAskFile: 起動の確認を省く印のファイルのパス（無ければ、いつも確認を出させる）
export type SessionsMcpLaunch = McpLaunch & { child?: boolean; noAskFile?: string };

// アプリが起動していないとき、中継が Claude に返す文
export const SESSIONS_CLOSED_MESSAGE = 'tanacode is not running. To work with other sessions, ask the user to start tanacode.';

// 子セッションを待つ（wait_sessions）上限。アプリはこの時間で待つのをやめて、そのときの状態を返す。
// 待っている間は人の発言が届かないので、長く待たせない（子の作業の終わりは、親への知らせと予約で待つ）
export const WAIT_MAX_SECONDS = 60;
// 中継が 1 回の呼び出しを待つ上限と、Claude Code が中継を待つ上限（--mcp-config の timeout）。wait_sessions の待ちより長く、
// 時間のかかるほかのツール（end_session の worktree の削除・PR の問い合わせなど）も収まるよう、11 分にしておく
export const SESSIONS_CALL_TIMEOUT_MS = 11 * 60_000;
const CLAUDE_TIMEOUT_MS = SESSIONS_CALL_TIMEOUT_MS + 60_000;

// 子セッションの起動（start_session）の前のフック（--settings の PreToolUse）。印のファイル（SESSIONS_NO_ASK_ENV）が無ければ、
// 権限モードによらず人の許可の確認を出させる（ask。許可の確認は auto・bypassPermissions では出ないので、フックで ask を返す）。
// あれば、権限モードによらず確認なしに始めさせる（allow。manual のセッションでも聞かない）。環境変数が無い・空のときも ask に倒す。
// 子も利用枠を使うことを、理由に書く（Claude Code を起動するときの言語で。シェルの単一引用符に埋め込むので、理由に ' を含めない）。
// 目印の環境変数は、チャットのフックの一覧に出さないためのもの。
// 入力は使わないが、最後まで読んで捨てる（Claude Code は、入力を書き終える前にフックが標準入力を閉じると、フックの失敗として扱う）
export function sessionsGateCommand(): string {
  const print = (permissionDecision: 'allow' | 'ask') => gateOutput(permissionDecision, t('main.hooks.sessionsGate'));
  return `cat >/dev/null; if [ -f "$${SESSIONS_NO_ASK_ENV}" ]; then ${print('allow')}; else ${print('ask')}; fi`;
}
export const SESSIONS_GATED_TOOL = sessionToolId('start_session');

// tanacode の再起動（restart_app）の前のフック。権限モードによらず、いつも人の許可の確認を出させる（印のファイルは見ない。
// アプリ全体を起動し直すので、人が頼んだことを人に確かめる）。Remote Control からも答えられる。入力は読んで捨てる（上と同じ）
export function restartGateCommand(): string {
  return `cat >/dev/null; ${gateOutput('ask', t('main.hooks.restartGate'))}`;
}
export const RESTART_GATED_TOOL = sessionToolId('restart_app');

// 確認のフックの答えを書くコマンド。理由はシェルの単一引用符に埋め込むので、' を含めない。
// 目印の環境変数は、チャットのフックの一覧に出さないためのもの
function gateOutput(permissionDecision: 'allow' | 'ask', reason: string): string {
  const output = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason },
    // アプリのフックの印（hook-output.ts）
    suppressOutput: true,
  });
  return `${SESSIONS_GATE_HOOK_ENV}=1 printf '%s\\n' '${output}'`;
}

// 印のファイルを、メニューの設定に合わせて置く・消す。ask: 始める前に許可を求めるか（求めるなら消す）
export function writeSessionsNoAskFile(file: string, ask: boolean): void {
  if (ask) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
}

// 起動する Claude Code の環境に足す、起動の確認のフックが使う環境変数。印のファイルのパスを渡されていないときも、空で上書きする
// （アプリを起動した環境から受け継いだ値を、フックに読ませない）
export function sessionsGateEnv(launch: SessionsMcpLaunch): Record<string, string> {
  return { [SESSIONS_NO_ASK_ENV]: launch.noAskFile ?? '' };
}

// --mcp-config に入れるセッションのサーバー。sessionId: どのセッションの Claude Code か（中継の env で渡す）
export function sessionsMcpServer(launch: SessionsMcpLaunch, sessionId: string): McpServerEntry {
  const env = { [SESSIONS_SOCKET_ENV]: launch.socketPath, [SESSIONS_SESSION_ENV]: sessionId, ...(launch.child ? { [SESSIONS_CHILD_ENV]: '1' } : {}) };
  return mcpServerEntry(launch.child ? SESSIONS_MCP_FOR_CHILD : SESSIONS_MCP, launch, env, CLAUDE_TIMEOUT_MS);
}
