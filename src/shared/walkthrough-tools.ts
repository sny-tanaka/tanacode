import { findTool, mcpToolId, type McpServerDef, type McpTool } from './mcp-tools';

// Claude Code に MCP のツールとして渡す、ウォークスルー（Claude がエディタでコードを示しながら説明し、人が質問する）。
// 中継のスクリプト（src/main/walkthrough-mcp.ts）が tools/list で返し、アプリ（src/main/walkthrough-control.ts）が実行する。
// Claude Code での名前は mcp__tanacode-walkthrough__<name>

export const WALKTHROUGH_MCP_SERVER = 'tanacode-walkthrough';

type Schema = Record<string, unknown>;

const path: Schema = { type: 'string', description: 'ファイルのパス（セッションのフォルダからの相対パスか、フォルダの中の絶対パス）' };
const startLine: Schema = { type: 'integer', minimum: 1, description: '示す範囲の最初の行（1 から）' };
const endLine: Schema = { type: 'integer', minimum: 1, description: '示す範囲の最後の行（含む）。省くと start_line の 1 行' };
const body: Schema = {
  type: 'string',
  description: '説明（Markdown。エディタの範囲の直下に吹き出しで出す）。何をしたかより、なぜこうしたか（意図・選ばなかった案・気をつけたこと）を 2〜6 文で',
};

export const WALKTHROUGH_TOOLS: McpTool[] = [
  {
    name: 'start_walkthrough',
    kind: 'show',
    label: '始める',
    description:
      'ウォークスルーの手順を渡して始める（前のものは置き換える）。人の tanacode のエディタに 1 つ目のステップを開き、すぐ返る。人は「次へ」「戻る」で自分のペースで進め、質問はチャットに届く。渡したら、ターンを終えて待つ',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'ウォークスルーの名前（例: 税率を可変にした変更）' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          description: '見せる順のステップ。1 ステップに 1 つの意図',
          items: {
            type: 'object',
            properties: {
              path,
              start_line: startLine,
              end_line: endLine,
              title: { type: 'string', description: 'ステップの見出し（短く。例: 税率を設定から読む）' },
              body,
            },
            required: ['path', 'start_line', 'title', 'body'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_code',
    kind: 'show',
    label: 'コードを示す',
    description:
      '質問に答えるときに、手順の外の場所を人のエディタに示す（寄り道）。人が「ウォークスルーに戻る」を押すと、元のステップに戻る。ウォークスルーを始めていなくても使える',
    inputSchema: {
      type: 'object',
      properties: { path, start_line: startLine, end_line: endLine, body },
      required: ['path', 'start_line', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'walkthrough_status',
    kind: 'read',
    label: '今の場所',
    description: '今のウォークスルーの手順と、人が今どのステップを見ているか（見終えたステップ・寄り道）を返す。人が終えていれば、そう返す',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// MCP の初期化で返す、サーバーの説明（Claude Code は会話の先頭に入れる）
export const WALKTHROUGH_MCP_INSTRUCTIONS = [
  '人の tanacode のエディタにコードを開いて示しながら、変更や仕組みを説明する（ウォークスルー）ためのツール。画面共有でレビュイーがレビュワーにコードを見せて説明するのと同じことを、あなた（レビュイー）と人（レビュワー）でする。',
  '- 人が「ウォークスルーして」「説明して」「どう変えたか見せて」のように、コードを見ながらの説明を頼んだら使う。',
  '- 先にコードを読んで手順を組み立て、start_walkthrough で全部を一度に渡す。1 ステップに 1 つの意図。読む人が分かりやすい順に（全体の入口 → 中身、データの形 → 使う側）。範囲は説明に要る行だけに絞る（長くても 40 行ほど）。',
  '- 説明は、何をしたかより、なぜこうしたか（意図・選ばなかった案・気をつけたこと・気になっている点）を書く。コードを読めば分かることは繰り返さない。',
  '- 渡したら、チャットには短く「エディタで 1/N から見てください」とだけ書いてターンを終える。人は「次へ」「戻る」で自分のペースで進める。',
  '- 人の質問は、ふつうの発言としてチャットに届く（「ウォークスルー「…」の 3/7「…」（path:40-58）について質問です。」や「path:12-20 について質問です。」と、選んだコードが付く）。答えはチャットに書く。別の場所を見せたほうが早ければ、show_code で示してから答える。',
  '- 頼まれてコードを直したら、示している行がずれるので、直し終えたあとに start_walkthrough で、人が見ていたステップから先を示し直す。',
  '- 人が今どこを見ているかは walkthrough_status で確かめられる。',
].join('\n');

export const WALKTHROUGH_MCP: McpServerDef = {
  name: WALKTHROUGH_MCP_SERVER,
  title: 'tanacode のウォークスルー',
  instructions: WALKTHROUGH_MCP_INSTRUCTIONS,
  tools: WALKTHROUGH_TOOLS,
};

export function walkthroughToolId(name: string): string {
  return mcpToolId(WALKTHROUGH_MCP_SERVER, name);
}

export function walkthroughTool(name: string): McpTool | undefined {
  return findTool(WALKTHROUGH_MCP, name);
}

// フォルダの中の絶対パスは、フォルダからの相対パスにする（チャットの表示用。外のパスはそのまま）
function relativeTo(p: string, cwd: string): string {
  return cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
}

function lines(input: Record<string, unknown>): string {
  const start = Number(input.start_line);
  const end = Number(input.end_line);
  if (!Number.isInteger(start)) return '';
  return Number.isInteger(end) && end > start ? `:${start}-${end}` : `:${start}`;
}

// チャットのツールの行に出す対象（「税率を可変にした変更 · 7 ステップ」「src/tax.ts:12-20」）。ウォークスルーのツールでなければ null
export function walkthroughTarget(name: string, input: Record<string, unknown>, cwd: string): string | null {
  if (!name.startsWith(`mcp__${WALKTHROUGH_MCP_SERVER}__`)) return null;
  if (name.endsWith('__start_walkthrough')) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const count = Array.isArray(input.steps) ? `${input.steps.length} ステップ` : '';
    return [title, count].filter(Boolean).join(' · ');
  }
  if (name.endsWith('__show_code') && typeof input.path === 'string') return `${relativeTo(input.path, cwd)}${lines(input)}`;
  return '';
}

// チャットのツールの行を押したときに開くもの。start_walkthrough は今のウォークスルー、show_code はその場所
export type WalkthroughToolTarget = { kind: 'walkthrough' } | { kind: 'code'; path: string; line: number };

export function walkthroughOfTool(name: string, input: string): WalkthroughToolTarget | null {
  if (!name.startsWith(`mcp__${WALKTHROUGH_MCP_SERVER}__`)) return null;
  if (name.endsWith('__start_walkthrough')) return { kind: 'walkthrough' };
  if (!name.endsWith('__show_code')) return null;
  try {
    const args = JSON.parse(input) as Record<string, unknown>;
    const line = Number(args.start_line);
    return typeof args.path === 'string' && Number.isInteger(line) && line > 0 ? { kind: 'code', path: args.path, line } : null;
  } catch {
    return null;
  }
}
