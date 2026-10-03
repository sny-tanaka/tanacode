// tanacode が起動する Claude Code に足す MCP サーバー（アプリ内ブラウザ・セッション）の、ツールの定義の形。
// 中継のスクリプト（src/main/mcp-relay.ts）が tools/list で返し、アプリが名前を確かめて実行する

// read: 読むだけ（起動の引数 --allowedTools で許可済みにする）/ act: 何かを動かす（Claude Code の許可の確認を通す）/
// eval: ページで JavaScript を実行する（アプリ内ブラウザだけ。--settings の PreToolUse のフックが確認を出すか決める）/
// ask: ユーザーに操作を頼む（アプリ内ブラウザだけ。何も動かさないので、読むだけのツールと同じく許可済みにする）/
// instruct: 子セッションに指示する・質問に答える（セッションだけ。読むだけではないが、権限は広がらないので許可済みにする）
export type McpToolKind = 'read' | 'act' | 'eval' | 'ask' | 'instruct';

type Schema = Record<string, unknown>;

export type McpTool = {
  name: string;
  kind: McpToolKind;
  // チャットのツールの行に出す短い名前
  label: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties: false };
};

// 1 つの MCP サーバー。name: Claude Code での名前（ツールは mcp__<name>__<ツール>）/ title: initialize で返す表示名 /
// instructions: initialize で返す説明（Claude Code はシステムプロンプトに入れる）
export type McpServerDef = { name: string; title: string; instructions: string; tools: McpTool[] };

export function mcpToolId(server: string, name: string): string {
  return `mcp__${server}__${name}`;
}

export function findTool(def: McpServerDef, name: string): McpTool | undefined {
  return def.tools.find((t) => t.name === name);
}

// Claude Code の起動の引数 --allowedTools で許可済みにするツール（読むだけ・ユーザーに操作を頼む・子セッションに指示する）
export function allowedToolIds(def: McpServerDef): string[] {
  return def.tools.filter((t) => t.kind === 'read' || t.kind === 'ask' || t.kind === 'instruct').map((t) => mcpToolId(def.name, t.name));
}
