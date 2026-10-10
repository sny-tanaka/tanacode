import { t } from './i18n';
import { findTool, mcpToolId, type McpServerDef, type McpTool, type McpToolName } from './mcp-tools';
import { PARENT_MESSAGE_TAG } from './session-tools';

// Claude Code に MCP のツールとして渡す、ウォークスルー（Claude がエディタでコードを示しながら説明し、人が質問する）。
// 中継のスクリプト（src/main/walkthrough-mcp.ts）が tools/list で返し、アプリ（src/main/walkthrough-control.ts）が実行する。
// Claude Code での名前は mcp__tanacode-walkthrough__<name>

export const WALKTHROUGH_MCP_SERVER = 'tanacode-walkthrough';

type Schema = Record<string, unknown>;

const path: Schema = { type: 'string', description: 'ファイルのパス（セッションのフォルダからの相対パスか、フォルダの中の絶対パス）' };
const startLine: Schema = { type: 'integer', minimum: 1, description: '示す範囲の最初の行（1 から）' };
const endLine: Schema = { type: 'integer', minimum: 1, description: '示す範囲の最後の行（含む）。省くと start_line の 1 行' };
const view: Schema = {
  type: 'string',
  enum: ['file', 'diff'],
  description:
    'file: エディタに出す（既定）。diff: ブランチの差分（分岐したところ ↔ 作業ツリー）の画面に出し、消した行も並べて見せる。行番号はどちらも今のファイルのもの。ブランチで変わっていないファイルは、diff でもエディタに出す',
};
const body: Schema = {
  type: 'string',
  description: '説明（Markdown。エディタの範囲の直下に吹き出しで出す）。何をしたかより、なぜこうしたか（意図・選ばなかった案・気をつけたこと）を 2〜6 文で',
};

// 名前は、短い名前の文言（tools.walkthrough.<名前>）があるもの
export const WALKTHROUGH_TOOLS: McpTool<McpToolName<'walkthrough'>>[] = [
  {
    name: 'start_walkthrough',
    kind: 'show',
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
              view,
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
    description:
      '質問に答えるときに、手順の外の場所を人のエディタに示す（寄り道）。人が「ウォークスルーに戻る」を押すと、元のステップに戻る。ウォークスルーを始めていなくても使える',
    inputSchema: {
      type: 'object',
      properties: { path, start_line: startLine, end_line: endLine, body, view },
      required: ['path', 'start_line', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'walkthrough_status',
    kind: 'read',
    description: '今のウォークスルーの手順と、人が今どのステップを見ているか（見終えたステップ・寄り道）を返す。人が終えていれば、そう返す',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// MCP の初期化で返す、サーバーの説明（Claude Code は会話の先頭の system の発言に入れる。英語で書く理由は mcp-tools.ts の McpServerDef）
export const WALKTHROUGH_MCP_INSTRUCTIONS = [
  "Tools for walkthroughs: you open code in the user's tanacode editor and explain a change or how something works while showing it, the way a reviewee shares their screen with a reviewer. You are the reviewee and the user is the reviewer.",
  '- The user may not know about walkthroughs, so do not wait to be asked:',
  `  - When you finish a change that spans several files or contains design decisions worth reviewing, end your turn by starting a walkthrough of it instead of only summarizing it in the chat. Skip this for small or obvious edits, when the user said they do not need it, and when the task came from a parent session (<${PARENT_MESSAGE_TAG}>), since no one is watching your editor then.`,
  '  - When you explain how existing code works or answer a question about specific code, show the place with show_code (or a walkthrough when it takes several places) instead of pasting the code into the chat.',
  '  - Always use it when the user asks for a walkthrough, for an explanation along the code, or to be shown what was changed.',
  '- Read the code first, plan the steps, and pass them all at once with start_walkthrough. One intent per step. Order the steps so they are easy to follow (the overall entry point before the details, the shape of the data before its users). Keep each range to the lines the explanation needs (about 40 lines at most).',
  '- When you explain the changes of the branch, use view: "diff" to show the deleted lines next to the new ones. Where the before and after need no comparison (new files, explaining a mechanism), keep view: "file".',
  '- In the explanations, write why rather than what: the intent, the alternatives you did not choose, what you were careful about and what still concerns you. Do not repeat what the code already says. Write the titles and explanations in the language the user is using.',
  '- After passing the steps, write only a short line in the chat (e.g. "Please start from 1/N in the editor", in the language the user is using) and end your turn. The user moves through the steps with Next and Back at their own pace.',
  '- The questions of the user arrive as ordinary chat messages with the selected code attached (e.g. 「ウォークスルー「…」の 3/7「…」（path:40-58）について質問です。」 or 「path:12-20 について質問です。」). Answer in the chat. If showing another place is faster, show it with show_code first.',
  '- If you change code on request, the lines you showed shift. When you are done, restart with start_walkthrough from the step the user was viewing onward.',
  '- walkthrough_status tells you where the user is looking now.',
].join('\n');

export const WALKTHROUGH_MCP: McpServerDef = {
  name: WALKTHROUGH_MCP_SERVER,
  labels: 'walkthrough',
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
    const count = Array.isArray(input.steps) ? t('tools.target.stepCount', { count: input.steps.length }) : '';
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
