import { PERMISSION_SERVERS } from './tool-permissions';

// セッションの Claude Code に登録されている MCP サーバー（サイドパネルの「MCP」）。
// Claude Code に制御の要求 mcp_status を送り、返事の mcpServers を読む（2.1.316 で実測）

// つながりの状態。connected・pending（つないでいる途中）・failed・needs-auth（認証が要る）・disabled（/mcp で切った）。
// 知らない値は、そのまま持って画面に出す
export type McpServerStatus = 'connected' | 'pending' | 'failed' | 'needs-auth' | 'disabled' | (string & {});

export type McpServerTool = {
  name: string;
  // 読むだけ・壊しうる（MCP のツールの注記 annotations）
  readOnly: boolean;
  destructive: boolean;
};

export type McpServer = {
  name: string;
  status: McpServerStatus;
  // どこで登録したか。tanacode: tanacode が足したもの。ほかは Claude Code の scope（claudeai・user・project・local・plugin など）
  scope: string;
  // サーバーが名乗った名前とバージョン（つながる前・名乗らないものは null）
  serverName: string | null;
  version: string | null;
  // つなぎ方（stdio・http・sse・claudeai-proxy など）
  transport: string | null;
  // つながらなかった理由（failed のとき。無ければ null）
  error: string | null;
  tools: McpServerTool[];
};

// stopped: Claude Code が動いていない / terminal: ターミナルモード（制御の要求を送れない）/ failed: 聞けなかった
export type SessionMcp = { state: 'ready'; servers: McpServer[] } | { state: 'stopped' } | { state: 'terminal' } | { state: 'failed'; message: string };

const TANACODE_SERVERS = new Set(PERMISSION_SERVERS.flatMap(({ def, child }) => [def.name, ...(child ? [child.name] : [])]));

// 並べる順: 状態に問題のあるもの（認証が要る・失敗）を先に、そのあと tanacode・ほかの順。同じ組の中は名前の順
const STATUS_ORDER: Record<string, number> = { 'needs-auth': 0, failed: 0, pending: 1, connected: 2, disabled: 3 };

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

// mcp_status の返事を読む。形の違う項目は捨てる
export function mcpServersOf(response: unknown): McpServer[] {
  const list = record(response).mcpServers;
  if (!Array.isArray(list)) return [];
  const servers: McpServer[] = [];
  for (const item of list) {
    const raw = record(item);
    const name = text(raw.name);
    if (!name) continue;
    const info = record(raw.serverInfo);
    const tools = Array.isArray(raw.tools)
      ? raw.tools.flatMap((tool) => {
          const t = record(tool);
          const toolName = text(t.name);
          if (!toolName) return [];
          const notes = record(t.annotations);
          return [{ name: toolName, readOnly: notes.readOnly === true, destructive: notes.destructive === true }];
        })
      : [];
    servers.push({
      name,
      status: text(raw.status) ?? 'pending',
      scope: TANACODE_SERVERS.has(name) ? 'tanacode' : (text(raw.scope) ?? 'unknown'),
      serverName: text(info.name),
      version: text(info.version),
      transport: text(raw.transport) ?? text(record(raw.config).type),
      error: text(raw.error),
      tools,
    });
  }
  return servers.sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0) ||
      Number(b.scope === 'tanacode') - Number(a.scope === 'tanacode') ||
      a.name.localeCompare(b.name),
  );
}
