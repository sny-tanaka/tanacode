import { BROWSER_MCP, BROWSER_MCP_SERVER } from '@shared/browser-tools';
import { CHECKLIST_MCP, CHECKLIST_MCP_SERVER } from '@shared/checklist-tools';
import { t } from '@shared/i18n';
import { findTool, mcpToolLabel, type McpServerDef } from '@shared/mcp-tools';
import { SESSIONS_MCP, SESSIONS_MCP_SERVER } from '@shared/session-tools';
import { WALKTHROUGH_MCP, WALKTHROUGH_MCP_SERVER } from '@shared/walkthrough-tools';

// MCP のツールの内部名（mcp__<サーバー>__<ツール>）を、画面に出す短い名前にする。例: 「Browser · navigate」。
// tanacode のアプリ内ブラウザ・セッションなどのツールは、文言（tools.*）の名前にする（例: 「アプリ内ブラウザ · クリック」「セッション · 子セッションに指示」）
const TANACODE_SERVERS = new Map<string, McpServerDef>([
  [BROWSER_MCP_SERVER, BROWSER_MCP],
  [SESSIONS_MCP_SERVER, SESSIONS_MCP],
  [CHECKLIST_MCP_SERVER, CHECKLIST_MCP],
  [WALKTHROUGH_MCP_SERVER, WALKTHROUGH_MCP],
]);

// サーバーの表示名。Claude のブラウザ・Claude in Chrome は、英語の名前のまま
function serverName(server: string): string {
  if (server === 'Claude_Browser') return 'Browser';
  if (server === 'claude-in-chrome') return 'Chrome';
  const def = TANACODE_SERVERS.get(server);
  return def ? t(`tools.server.${def.labels}`) : server;
}

export function mcpParts(name: string): { server: string | null; tool: string } | null {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return null;
  // コネクタ（Slack など）はサーバー名が UUID なので出さない
  const server = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(m[1]) ? null : serverName(m[1]);
  const def = TANACODE_SERVERS.get(m[1]);
  const found = def && findTool(def, m[2]);
  return { server, tool: def && found ? mcpToolLabel(def, found) : m[2] };
}

export function toolLabel(name: string): string {
  const mcp = mcpParts(name);
  if (!mcp) return name;
  return mcp.server ? `${mcp.server} · ${mcp.tool}` : mcp.tool;
}

// tanacode のほかのセッションを扱うツール（子セッションの起動・指示、ほかのセッションを覗く）か
export function isSessionTool(name: string): boolean {
  return name.startsWith(`mcp__${SESSIONS_MCP_SERVER}__`);
}

// チェックリストのツールか
export function isChecklistTool(name: string): boolean {
  return name.startsWith(`mcp__${CHECKLIST_MCP_SERVER}__`);
}

// ウォークスルーのツールか
export function isWalkthroughTool(name: string): boolean {
  return name.startsWith(`mcp__${WALKTHROUGH_MCP_SERVER}__`);
}
