// MCP のツールの内部名（mcp__<サーバー>__<ツール>）を、画面に出す短い名前にする。例: 「Browser · navigate」
const SERVER_NAMES: Record<string, string> = { Claude_Browser: 'Browser', 'claude-in-chrome': 'Chrome' };

export function mcpParts(name: string): { server: string | null; tool: string } | null {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return null;
  // コネクタ（Slack など）はサーバー名が UUID なので出さない
  const server = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(m[1]) ? null : (SERVER_NAMES[m[1]] ?? m[1]);
  return { server, tool: m[2] };
}

export function toolLabel(name: string): string {
  const mcp = mcpParts(name);
  if (!mcp) return name;
  return mcp.server ? `${mcp.server} · ${mcp.tool}` : mcp.tool;
}
