import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_PERMISSION_HOOK_ENV } from '@shared/chat';
import { t } from '@shared/i18n';
import { browserToolId } from '@shared/browser-tools';
import { mcpToolId } from '@shared/mcp-tools';
import { sessionToolId } from '@shared/session-tools';
import { terminalToolId } from '@shared/terminal-tools';
import { walkthroughToolId } from '@shared/walkthrough-tools';
import { changedToolPermissions, PERMISSION_SERVERS, toolDefaultRule, type ToolPermission } from '@shared/tool-permissions';
import { SUPPRESS_OUTPUT } from './hook-output';

// ツールごとの許可（メニューの「MCP の設定…」の「確認」）を、起動する Claude Code に効かせるもの。
// 既定から変えたツールにだけ、userData の tool-permissions に印のファイル（<ツールの ID>.ask か .allow。中身は空）を置く。
// --settings の PreToolUse のフックは、呼ばれるたびに印のファイルがあるかを見る（Node を起動しない [ -f ]）ので、
// 切り替えは動いているセッションにもすぐ効く。フックの数・形は起動のときに決まるので、この仕組みより前に始めたセッションには効かない。
// - --allowedTools で許可済みのツール（既定は常に許可）: .ask があれば ask（--allowedTools や権限モードより強く、bypassPermissions でも確認が出る）。無ければ何も決めない
// - 何かを動かすツール（既定は常に許可）: .ask があれば ask。無ければ allow（manual でも確認なし。plan のときは何も決めない）
// - 既定でいつも確認を出させるツール（セッションを始める・tanacode の再起動・PR に載せる）: .allow があれば allow、無ければ ask
// - 開く（navigate）・JavaScript の実行（evaluate）・ターミナルに打つ（type_in_terminal）: アプリに問い合わせる確認のフック
//   （browser-gate.ts・terminal-bridge.ts）が、alwaysAllowed で印を見る（アプリ側の「確認した印」は、そのフックが控える）
// 権限モードが plan のときは、読むだけでないツールに allow を返さない（Claude Code の plan の扱いに任せる。既定で確認を出させるツールは、確認を出させる）

// 印のファイルのフォルダを、フックに渡す環境変数（起動する Claude Code の環境に足す。フックは Claude Code の環境で動く）
export const TOOL_PERMISSIONS_DIR_ENV = 'TANACODE_TOOL_PERMISSIONS_DIR';
// userData の中の、印のファイルのフォルダ（アプリ全体で 1 組）
export const TOOL_PERMISSIONS_DIR = 'tool-permissions';

// アプリに問い合わせる確認のフックが扱うツール（ここのフックは足さない。同じツールに 2 つのフックが答えると ask が勝つため）
const APP_GATED = new Set([browserToolId('navigate'), browserToolId('evaluate'), terminalToolId('type_in_terminal')]);

export function permissionFile(dir: string, toolId: string, permission: ToolPermission): string {
  return join(dir, `${toolId}.${permission}`);
}

// 印のファイルを、設定に合わせる（既定から変えたツールの印だけを置き、ほかは消す）。置けない・消せなければ投げる
export function writeToolPermissionFiles(dir: string, permissions: Record<string, ToolPermission>): void {
  mkdirSync(dir, { recursive: true });
  const wanted = new Set(Object.entries(changedToolPermissions(permissions)).map(([id, permission]) => `${id}.${permission}`));
  for (const name of readdirSync(dir)) if (!wanted.has(name)) rmSync(join(dir, name), { force: true });
  for (const name of wanted) writeFileSync(join(dir, name), '');
}

// フックの答えを書くコマンド。理由はシェルの単一引用符に埋め込むので、' を含めない。目印の環境変数は、チャットのフックの一覧に出さないためのもの
function print(permissionDecision: 'allow' | 'ask' | null, reason = ''): string {
  const output = permissionDecision
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason }, suppressOutput: true })
    : SUPPRESS_OUTPUT;
  return `${TOOL_PERMISSION_HOOK_ENV}=1 printf '%s\\n' '${output}'`;
}

// 印のファイルがあるか（環境変数が無い・空なら、無いとみなす）
function has(toolId: string, permission: ToolPermission): string {
  return `[ -n "$${TOOL_PERMISSIONS_DIR_ENV}" ] && [ -f "$${TOOL_PERMISSIONS_DIR_ENV}/${toolId}.${permission}" ]`;
}

// 標準入力（$i）の権限モードが plan でないか。Claude Code は空白なしの JSON で渡す。ツールの入力に plan の文字があっても、plan とみなす（allow しない側に倒す）
const NOT_PLAN = `case "$i" in *'"permission_mode":"plan"'*|*'"permission_mode": "plan"'*) false;; *) true;; esac`;

// 1 つのツールのフックのコマンド。入力は最後まで読む（Claude Code は、入力を書き終える前にフックが標準入力を閉じると、フックの失敗として扱う）
export function toolPermissionCommand(toolId: string, rule: ReturnType<typeof toolDefaultRule>): string {
  const allow = print('allow', t('main.hooks.toolAllow'));
  if (rule === 'allowed') return `cat >/dev/null; if ${has(toolId, 'ask')}; then ${print('ask', t('main.hooks.toolAsk'))}; else ${print(null)}; fi`;
  if (rule === 'always') {
    const reason =
      toolId === sessionToolId('restart_app')
        ? t('main.hooks.restartGate')
        : toolId === sessionToolId('start_session')
          ? t('main.hooks.sessionsGate')
          : toolId === walkthroughToolId('post_walkthrough')
            ? t('main.hooks.postWalkthroughGate')
            : t('main.hooks.toolAsk');
    return `i=$(cat); if ${has(toolId, 'allow')} && ${NOT_PLAN}; then ${allow}; else ${print('ask', reason)}; fi`;
  }
  // act: 既定で確認なしに通す
  return `i=$(cat); if ${has(toolId, 'ask')}; then ${print('ask', t('main.hooks.toolAsk'))}; elif ${NOT_PLAN}; then ${allow}; else ${print(null)}; fi`;
}

// フックの matcher を、そのツールの名前だけに当たる正規表現にする。ツールの ID は - を含むので、Claude Code は matcher を正規表現として読む。
// 囲まないと、名前の一部が同じほかのツールにも当たる（ID には、正規表現で意味を持つ文字は - のほかに無い）
export function exactMatcher(...toolIds: string[]): string {
  return toolIds.length === 1 ? `^${toolIds[0]}$` : `^(${toolIds.join('|')})$`;
}

// --settings の PreToolUse に足す、ツールごとのフック。足していない MCP のツールのフックは呼ばれないので、全部のツールに足す
export function toolPermissionHooks(): { matcher: string; hooks: { type: 'command'; command: string; timeout: number }[] }[] {
  return PERMISSION_SERVERS.flatMap(({ def }) =>
    def.tools
      .map((tool) => ({ id: mcpToolId(def.name, tool.name), rule: toolDefaultRule(def, tool) }))
      .filter(({ id }) => !APP_GATED.has(id))
      .map(({ id, rule }) => ({ matcher: exactMatcher(id), hooks: [{ type: 'command' as const, command: toolPermissionCommand(id, rule), timeout: 10 }] })),
  );
}

// アプリに問い合わせる確認のフックから: そのツールを「常に許可」にしていて、権限モードが plan でないか。
// hookInput: Claude Code がフックの標準入力に渡した JSON。dir: 印のファイルのフォルダ（環境変数から。無ければ false）
export function alwaysAllowed(toolId: string, hookInput: string, dir = process.env[TOOL_PERMISSIONS_DIR_ENV] ?? ''): boolean {
  if (!dir || !existsSync(permissionFile(dir, toolId, 'allow'))) return false;
  return !isPlanMode(hookInput);
}

// 標準入力（Claude Code の PreToolUse の入力）の権限モードが plan か。読めなければ plan とみなす（allow しない側に倒す）
export function isPlanMode(hookInput: string): boolean {
  try {
    return (JSON.parse(hookInput) as { permission_mode?: unknown }).permission_mode === 'plan';
  } catch {
    return true;
  }
}

// アプリに問い合わせる確認のフックが、「常に許可」で allow を返すときの答え
export function alwaysAllowOutput(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: t('main.hooks.toolAllow') } });
}
