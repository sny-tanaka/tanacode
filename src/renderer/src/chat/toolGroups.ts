import { BROWSER_MCP_SERVER } from '@shared/browser-tools';
import type { HookRun } from '@shared/chat';
import { t } from '@shared/i18n';
import type { ChatItem } from './chatState';
import { isChecklistTool, isSessionTool, isWalkthroughTool, mcpParts, toolLabel } from './toolLabel';

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

// 本文と本文の間に続くツールの呼び出しのまとまり。畳んで 1 行で出す
export type ToolGroup = { kind: 'tool-group'; id: string; items: ChatItem[]; tools: ToolItem[] };

// ツールに付かない hooks の続き（Stop・SessionStart など）。これも畳んで 1 行で出す
export type HookGroup = { kind: 'hook-group'; id: string; runs: HookRun[] };

// チャットの行を、ツールの呼び出しのまとまりごとに束ねる。
// 本文・思考・発言・通知・エラー・区切り・ツールに付かない hooks・ユーザーに送ったファイル・質問への回答で区切る。思考はまとまりに入れず、外に出す。
// ワークフローも束ねる（実行中のものは入力欄の上のトレイに出るので、進み具合はそこで見られる）。
// ツールに付かない hooks は、続いているものを 1 つに束ねる
export function groupTools(items: ChatItem[]): ChatRowItem[] {
  const out: ChatRowItem[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length > 0) out.push({ kind: 'tool-group', id: `group:${run[0].id}`, items: run, tools: run });
    run = [];
  };
  for (const item of items) {
    // ユーザーに送ったファイルと、質問への回答は、本文と同じく畳まずに出す
    if (item.kind === 'tool' && item.name !== 'SendUserFile' && !item.answers) {
      run.push(item);
      continue;
    }
    flush();
    const last = out[out.length - 1];
    if (item.kind === 'hook' && last?.kind === 'hook-group') last.runs = [...last.runs, ...item.runs];
    else if (item.kind === 'hook') out.push({ kind: 'hook-group', id: `hooks:${item.id}`, runs: item.runs });
    else out.push(item);
  }
  flush();
  return out;
}

export type ChatRowItem = ChatItem | ToolGroup | HookGroup;

// groupTools はまとまりを毎回新しく作るので、中身（束ねた項目）が前と同じまとまりは前のオブジェクトを使い回す。
// こうすると、変わっていないまとまりの行（memo した部品）は描き直されない
export function reuseGroups(prev: ChatRowItem[], next: ChatRowItem[]): ChatRowItem[] {
  const before = new Map<string, ChatRowItem>();
  for (const row of prev) if (row.kind === 'tool-group' || row.kind === 'hook-group') before.set(row.id, row);
  const same = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return next.map((row) => {
    const old = before.get(row.id);
    if (row.kind === 'tool-group' && old?.kind === 'tool-group' && same(old.items, row.items)) return old;
    if (row.kind === 'hook-group' && old?.kind === 'hook-group' && same(old.runs, row.runs)) return old;
    return row;
  });
}

// 要約に出す分類（この順に並べる）
const CATEGORIES = ['edit', 'run', 'read', 'search', 'fetch', 'agent', 'workflow', 'question', 'todo', 'browser', 'session', 'checklist', 'walkthrough', 'mcp', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

// 1 つのツールの行を、ツールの名前などで言い表す分類（実行中・完了・失敗の言い方の動詞を持たない）
type NamedCategory = 'question' | 'session' | 'checklist' | 'walkthrough';

// 実行中・完了・失敗の表示の言い方（「〜中」「〜に失敗」「〜しました」）の動詞
type Verb = 'edit' | 'run' | 'read' | 'search' | 'fetch' | 'delegate' | 'update' | 'operate';
const VERB_OF: Record<Exclude<Category, NamedCategory>, Verb> = {
  edit: 'edit',
  run: 'run',
  read: 'read',
  search: 'search',
  fetch: 'fetch',
  agent: 'delegate',
  workflow: 'run',
  todo: 'update',
  browser: 'operate',
  mcp: 'run',
  other: 'run',
};

const CATEGORY_OF: Record<string, Category> = {
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  KillBash: 'run',
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  ToolSearch: 'search',
  WebSearch: 'search',
  WebFetch: 'fetch',
  Agent: 'agent',
  Task: 'agent',
  Workflow: 'workflow',
  AskUserQuestion: 'question',
  TodoWrite: 'todo',
};

function categoryOf(tool: ToolItem): Category {
  if (isSessionTool(tool.name)) return 'session';
  if (isChecklistTool(tool.name)) return 'checklist';
  if (isWalkthroughTool(tool.name)) return 'walkthrough';
  const mcp = mcpParts(tool.name);
  // アプリ内ブラウザは、表示名（言語で変わる）ではなく内部名で見分ける
  if (mcp) return tool.name.startsWith(`mcp__${BROWSER_MCP_SERVER}__`) || mcp.server === 'Browser' || mcp.server === 'Chrome' ? 'browser' : 'mcp';
  return CATEGORY_OF[tool.name] ?? 'other';
}

// 畳んだときの要約。例: 8件の操作 · 編集 5 · 実行 2 · 読込 1 · 14秒
export function groupSummary(group: ToolGroup): { count: string; parts: string[]; failed: number; duration: string | null } {
  const counts = new Map<Category, number>();
  for (const tool of group.tools) {
    const category = categoryOf(tool);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const parts = CATEGORIES.filter((c) => counts.has(c)).map((c) => t(`chat.toolGroup.${c}`, { count: counts.get(c)! }));
  const failed = group.tools.filter((t) => t.status === 'error').length;
  return { count: t('chat.toolGroup.count', { count: group.tools.length }), parts, failed, duration: groupDuration(group) };
}

// 最初の呼び出しから最後の結果まで（会話ログの時刻が無い古い行では出さない）
function groupDuration(group: ToolGroup): string | null {
  const starts = group.tools.map((t) => t.startedAt).filter((v): v is number => v !== undefined);
  const ends = group.tools.map((t) => t.endedAt ?? t.startedAt).filter((v): v is number => v !== undefined);
  if (starts.length === 0 || ends.length === 0) return null;
  return formatDuration(Math.max(0, Math.max(...ends) - Math.min(...starts)));
}

// 畳んだまとまりの下に出す、1 つのツールの行の言い方。
// 何をするかの説明（Bash・Agent などの description）があれば、ターミナルと同じくそれを出す（例: 「テストの書き方を確認する…」）。
// 無ければ、実行中は「brief.md を編集中…」、終わると「brief.md を編集しました」、失敗は「brief.md の編集に失敗しました」
export function toolLine(tool: ToolItem): string {
  const category = categoryOf(tool);
  // 名前や説明で言い表すときの、実行中（…を付ける）・失敗の言い方
  const named = (label: string) => (tool.status === 'running' ? `${label}…` : tool.status === 'error' ? t('chat.toolLine.failed', { text: label }) : label);
  if (category === 'question') return tool.status === 'running' ? t('chat.toolLine.questionWaiting') : t('chat.toolLine.questionAnswered');
  // セッションのツールは、対象の ID より、ツールの名前（「子セッションに指示」など）のほうが分かりやすい
  if (category === 'session') return named(mcpParts(tool.name)?.tool ?? tool.name);
  // チェックリスト・ウォークスルーのツールは、ツールの名前と対象（「チェックする · やること #3」「コードを示す · src/tax.ts:12-20」など）
  if (category === 'checklist' || category === 'walkthrough') return named([mcpParts(tool.name)?.tool ?? tool.name, tool.target].filter(Boolean).join(' · '));
  if (tool.description) return named(shorten(tool.description.replace(/[。.…]+$/, '')));
  const subject = category === 'todo' ? t('chat.toolLine.todo') : tool.filePath ? baseName(tool.filePath) : shorten(tool.target || toolLabel(tool.name));
  const verb = VERB_OF[category];
  if (tool.status === 'running') return t(`chat.toolLine.${verb}Running`, { subject });
  if (tool.status === 'error') return t(`chat.toolLine.${verb}Failed`, { subject });
  return t(`chat.toolLine.${verb}Done`, { subject });
}

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

function shorten(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return t('chat.duration.underSecond');
  const s = Math.round(ms / 1000);
  return s < 60 ? t('chat.duration.seconds', { count: s }) : t('chat.duration.minutesSeconds', { minutes: Math.floor(s / 60), seconds: s % 60 });
}

// 畳んだ hooks の要約。例: フック 3件 · Stop · UserPromptSubmit · 失敗 1 · 1.2秒
export function hookSummary(group: HookGroup): { count: string; events: string[]; failed: number; blocked: number; duration: string | null } {
  const events = [...new Set(group.runs.map((r) => r.event))];
  const times = group.runs.map((r) => r.durationMs).filter((v): v is number => v !== null);
  return {
    count: t('chat.hookGroup.count', { count: group.runs.length }),
    events,
    failed: group.runs.filter((r) => r.outcome === 'error').length,
    blocked: group.runs.filter((r) => r.outcome === 'blocked').length,
    duration: times.length > 0 ? formatDuration(times.reduce((a, b) => a + b, 0)) : null,
  };
}
