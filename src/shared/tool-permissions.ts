import { BROWSER_MCP } from './browser-tools';
import { CHECKLIST_MCP } from './checklist-tools';
import { mcpToolId, type McpServerDef, type McpTool, type McpToolGroup } from './mcp-tools';
import { SESSIONS_MCP, SESSIONS_MCP_FOR_CHILD } from './session-tools';
import { TERMINAL_MCP, TERMINAL_MCP_FOR_CHILD } from './terminal-tools';
import { WALKTHROUGH_MCP } from './walkthrough-tools';

// tanacode が足す MCP のツールごとの許可（メニューの「MCP の設定…」）。アプリ全体で 1 つ。
// ask: 毎回確認 / allow: 常に許可。どのツールも、どちらにも変えられる（既定から変えるのは、利用者の判断）

export type ToolPermission = 'ask' | 'allow';

// MCP サーバーの入り・切り（アプリ全体で 1 つ。settings.json の browserControl など）
export const MCP_GROUPS: McpToolGroup[] = ['browser', 'sessions', 'checklist', 'walkthrough', 'terminal'];
export type McpEnabled = Record<McpToolGroup, boolean>;

// 既定の扱い。画面の注記と、フック（main の tool-permissions.ts）の形を決める
// - allowed: --allowedTools で許可済み（読むだけ・人に頼む・子への指示・チェックリスト・コードを示す）。既定は「常に許可」
// - act: 何かを動かすツール。フックが確認なしに通す（allow。plan のときは Claude Code の plan の扱いに任せる）。既定は「常に許可」
// - always: 権限モードによらず、フックがいつも確認を出させる（セッションを始める・tanacode の再起動・ターミナルに打つ・GitHub の PR に書き込む）。既定は「毎回確認」
// - outside: 許す先の外を開くときだけ、権限モードによらず確認を出させる。許す先の中は act と同じ（navigate）。既定は「毎回確認」（許す先の外を開くとき）
// - remote: localhost 以外のページでだけ確認を出させる。localhost では確認なし（evaluate）。既定は「毎回確認」（localhost 以外のページで）
export type ToolDefaultRule = 'allowed' | 'act' | 'always' | 'outside' | 'remote';

// 設定の画面に並べる順。child: 子セッションに足す定義（無ければ、子にも同じツールを出す）
export const PERMISSION_SERVERS: { def: McpServerDef; child?: McpServerDef }[] = [
  { def: BROWSER_MCP },
  { def: SESSIONS_MCP, child: SESSIONS_MCP_FOR_CHILD },
  { def: CHECKLIST_MCP },
  { def: WALKTHROUGH_MCP },
  { def: TERMINAL_MCP, child: TERMINAL_MCP_FOR_CHILD },
];

const ALWAYS_ASK = new Set([
  mcpToolId(SESSIONS_MCP.name, 'start_session'),
  mcpToolId(SESSIONS_MCP.name, 'restart_app'),
  mcpToolId(TERMINAL_MCP.name, 'type_in_terminal'),
  mcpToolId(WALKTHROUGH_MCP.name, 'post_walkthrough'),
]);
const NAVIGATE = mcpToolId(BROWSER_MCP.name, 'navigate');

export function toolDefaultRule(def: McpServerDef, tool: McpTool): ToolDefaultRule {
  const id = mcpToolId(def.name, tool.name);
  if (ALWAYS_ASK.has(id)) return 'always';
  if (id === NAVIGATE) return 'outside';
  if (tool.kind === 'eval') return 'remote';
  return tool.kind === 'act' ? 'act' : 'allowed';
}

export function defaultToolPermission(def: McpServerDef, tool: McpTool): ToolPermission {
  const rule = toolDefaultRule(def, tool);
  return rule === 'allowed' || rule === 'act' ? 'allow' : 'ask';
}

// 子セッションに出さないツールか
export function hiddenFromChild(server: { def: McpServerDef; child?: McpServerDef }, tool: McpTool): boolean {
  return !!server.child && !server.child.tools.some((t) => t.name === tool.name);
}

// 全部のツールの ID と、既定の許可
export function permissionToolDefaults(): Map<string, ToolPermission> {
  return new Map(PERMISSION_SERVERS.flatMap(({ def }) => def.tools.map((tool) => [mcpToolId(def.name, tool.name), defaultToolPermission(def, tool)] as const)));
}

// 保存した値・画面から届いた値を、知っているツールの ask・allow だけにする。既定と同じ値も持つ（利用者が選んだことを残す。
// 前のバージョンの「セッションを始める前に許可を求める」を、利用者が選び直したあとに引き継ぎ直さないため）
export function toolPermissionsOf(value: unknown): Record<string, ToolPermission> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const known = permissionToolDefaults();
  const result: Record<string, ToolPermission> = {};
  for (const [id, permission] of Object.entries(value as Record<string, unknown>)) {
    if (known.has(id) && (permission === 'ask' || permission === 'allow')) result[id] = permission;
  }
  return result;
}

// 既定から変えたツール（印のファイルを置くもの）
export function changedToolPermissions(permissions: Record<string, ToolPermission>): Record<string, ToolPermission> {
  const defaults = permissionToolDefaults();
  return Object.fromEntries(Object.entries(permissions).filter(([id, permission]) => defaults.has(id) && defaults.get(id) !== permission));
}
