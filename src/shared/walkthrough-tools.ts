import { t } from './i18n';
import { findTool, mcpToolId, type McpServerDef, type McpTool, type McpToolName } from './mcp-tools';
import { PARENT_MESSAGE_TAG } from './session-tools';

// Claude Code に MCP のツールとして渡す、ウォークスルー（Claude がエディタでコードを示しながら説明し、人が質問する）。
// 中継のスクリプト（src/main/walkthrough-mcp.ts）が tools/list で返し、アプリ（src/main/walkthrough-control.ts）が実行する。
// Claude Code での名前は mcp__tanacode-walkthrough__<name>

export const WALKTHROUGH_MCP_SERVER = 'tanacode-walkthrough';

type Schema = Record<string, unknown>;

const path: Schema = { type: 'string', description: 'File path (relative to the session folder, or an absolute path inside it)' };
const startLine: Schema = { type: 'integer', minimum: 1, description: 'First line of the range to show (1-based)' };
const endLine: Schema = { type: 'integer', minimum: 1, description: 'Last line of the range to show (inclusive). Omit it to show only start_line' };
const view: Schema = {
  type: 'string',
  enum: ['file', 'diff'],
  description:
    'file: show it in the editor (default). diff: show it in the branch diff view (merge base ↔ working tree), with the deleted lines next to the new ones. In both, line numbers are those of the current file. A file that the branch did not change is shown in the editor even with diff',
};
const body: Schema = {
  type: 'string',
  description: 'Explanation (Markdown, shown in a callout right below the range in the editor). In 2-6 sentences, write why rather than what: the intent, the alternatives you did not choose and what you were careful about',
};

// 名前は、短い名前の文言（tools.walkthrough.<名前>）があるもの
export const WALKTHROUGH_TOOLS: McpTool<McpToolName<'walkthrough'>>[] = [
  {
    name: 'start_walkthrough',
    kind: 'show',
    description:
      "Start a walkthrough by passing all its steps (replaces the previous one). Opens the first step in the user's tanacode editor and returns immediately. The user moves through the steps with Next and Back at their own pace, and their questions arrive in the chat. After passing the steps, end your turn and wait",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Name of the walkthrough (e.g. "Make the tax rate configurable")' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          description: 'Steps in the order to show them. One intent per step',
          items: {
            type: 'object',
            properties: {
              path,
              start_line: startLine,
              end_line: endLine,
              title: { type: 'string', description: 'Heading of the step (short, e.g. "Read the tax rate from the settings")' },
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
      "Show a place outside the steps in the user's editor while answering a question (an aside). When the user goes back to the walkthrough, the editor returns to the step they were on. Works even when no walkthrough has been started",
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
    description: 'Return the steps of the current walkthrough and which step the user is viewing now (the steps already viewed, any aside). If the user has finished it, it says so',
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
  `- The questions of the user arrive as ordinary chat messages with the selected code attached in the language of the user's tanacode (e.g. 「ウォークスルー「…」の 3/7「…」（path:40-58）について質問です。」 or "I have a question about step 3/7, “…” (path:40-58), in the walkthrough “…”.", and 「path:12-20 について質問です。」 or "I have a question about path:12-20."). Answer in the chat. If showing another place is faster, show it with show_code first.`,
  '- If you change code on request, the lines you showed shift. When you are done, restart with start_walkthrough from the step the user was viewing onward.',
  '- walkthrough_status tells you where the user is looking now.',
].join('\n');

export const WALKTHROUGH_MCP: McpServerDef = {
  name: WALKTHROUGH_MCP_SERVER,
  labels: 'walkthrough',
  title: 'tanacode walkthroughs',
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
