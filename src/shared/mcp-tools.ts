import { t, type MessageKey } from './i18n';

// tanacode が起動する Claude Code に足す MCP サーバー（アプリ内ブラウザ・セッション・チェックリスト・ウォークスルー・ターミナル）の、ツールの定義の形。
// 中継のスクリプト（src/main/mcp-relay.ts）が tools/list で返し、アプリが名前を確かめて実行する

// read: 読むだけ（起動の引数 --allowedTools で許可済みにする）/ act: 何かを動かす（--allowedTools には入れず、ツールごとの許可のフックが決める。tool-permissions.ts）/
// eval: ページで JavaScript を実行する（アプリ内ブラウザだけ。--settings の PreToolUse のフックが確認を出すか決める）/
// ask: ユーザーに操作を頼む（アプリ内ブラウザだけ。何も動かさないので、読むだけのツールと同じく許可済みにする）/
// instruct: 子セッションに指示する・質問に答える・許可の確認に答える・役目を終えた子を片付ける・自分への予約・人への報告（セッションだけ。読むだけではないが、人の確認なしに通す。
// 許可の確認に答えられるのは、親が acceptEdits 以上のモードのときに「今回だけ許す」か「断る」だけで、片付けも戻せるため。予約は人が画面で取り消せ、報告は通知の本文になるだけ）/
// note: チェックリストを書き換える（アプリのデータだけを変え、ゴミ箱から戻せるので許可済みにする）/
// show: 人のエディタにコードを示す（ウォークスルーだけ。ファイルは書き換えないので許可済みにする）
export type McpToolKind = 'read' | 'act' | 'eval' | 'ask' | 'instruct' | 'note' | 'show';

type Schema = Record<string, unknown>;

// ツールの短い名前（チャットのツールの行などに出す）の文言のまとまり。文言は tools.<まとまり>.<ツール名>
export type McpToolGroup = 'browser' | 'sessions' | 'checklist' | 'walkthrough' | 'terminal';

// そのまとまりに短い名前の文言があるツールの名前。定義の name をこれにすると、文言の無いツールは型チェックで止まる
export type McpToolName<G extends McpToolGroup> = MessageKey extends infer K ? (K extends `tools.${G}.${infer N}` ? N : never) : never;

// openWorld: 手元の外（GitHub など）に書き込む。tools/list の openWorldHint にする
export type McpTool<N extends string = string> = {
  name: N;
  kind: McpToolKind;
  openWorld?: true;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties: false };
};

// 1 つの MCP サーバー。name: Claude Code での名前（ツールは mcp__<name>__<ツール>）/ labels: ツールの短い名前の文言のまとまり /
// title: initialize で返す表示名 / instructions: initialize で返す説明（Claude Code は会話の先頭の system の発言に入れる）。Claude だけが読み、画面には出さないので、
// Claude Code のシステムプロンプトにそろえて英語で書く。いつ使うかを書き、人が機能を知らなくても Claude が自分から使うようにする。
// 人が読むもの（カード・説明・依頼の文など）は、人が使っている言葉で書くよう、それぞれの説明で伝える
export type McpServerDef = { name: string; labels: McpToolGroup; title: string; instructions: string; tools: McpTool[] };

export function mcpToolId(server: string, name: string): string {
  return `mcp__${server}__${name}`;
}

export function findTool(def: McpServerDef, name: string): McpTool | undefined {
  return def.tools.find((t) => t.name === name);
}

// ツールの短い名前（チャットのツールの行・アプリ内ブラウザの「Claude が操作中」の帯などに出す。tools/list の title にも使う）。
// 文言があることは、定義の name の型（McpToolName）で確かめてある
export function mcpToolLabel(def: McpServerDef, tool: McpTool): string {
  return t(`tools.${def.labels}.${tool.name}` as MessageKey);
}

// Claude Code の起動の引数 --allowedTools で許可済みにするツール（読むだけ・ユーザーに操作を頼む・子セッションに指示する・チェックリストを書き換える・コードを示す）
export function allowedToolIds(def: McpServerDef): string[] {
  return def.tools.filter((t) => t.kind !== 'act' && t.kind !== 'eval').map((t) => mcpToolId(def.name, t.name));
}

// 定義に無い引数が来たときに Claude に返す文（無ければ null）。黙って無視すると、推測で付けた名前（fill_credential の field: "otp" など）が
// 既定の動きに落ちて、思わぬ欄に値を入れることがあるため、断って正しい引数を伝える。Claude Code が古い定義を持ったままのこともあるので、
// 引数の説明も添える（この文の一覧が今の定義）
export function unknownArgumentsError(tool: McpTool, args: Record<string, unknown>): string | null {
  const known = Object.keys(tool.inputSchema.properties);
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length === 0) return null;
  const list = known.map((key) => {
    const description = tool.inputSchema.properties[key]?.description;
    return `- ${key}${typeof description === 'string' ? `: ${description}` : ''}`;
  });
  return (
    `${tool.name} has no argument named ${unknown.map((key) => JSON.stringify(key)).join(', ')}, so nothing was done. ` +
    (known.length === 0
      ? 'It takes no arguments.'
      : `Its arguments are (if your definition of the tool lacks some of them, it is out of date; use these):\n${list.join('\n')}`)
  );
}
