import type { HookRun } from '@shared/chat';
import type { ChatItem } from './chatState';
import { mcpParts, toolLabel } from './toolLabel';

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

type Category = { label: string; verb: string; done: string };

// 要約に出す分類（この順に並べる）と、実行中・完了の表示の言い方（verb は「〜中」「〜に失敗」、done は終わったとき）
const CATEGORIES: Category[] = [
  { label: '編集', verb: '編集', done: '編集しました' },
  { label: '実行', verb: '実行', done: '実行しました' },
  { label: '読込', verb: '読み込み', done: '読み込みました' },
  { label: '検索', verb: '検索', done: '検索しました' },
  { label: '取得', verb: '取得', done: '取得しました' },
  { label: 'エージェント', verb: '依頼', done: '依頼しました' },
  { label: 'ワークフロー', verb: '実行', done: '実行しました' },
  { label: '質問', verb: '', done: '' },
  { label: 'ToDo', verb: '更新', done: '更新しました' },
  { label: 'ブラウザ', verb: '操作', done: '操作しました' },
  { label: 'MCP', verb: '実行', done: '実行しました' },
  { label: 'その他', verb: '実行', done: '実行しました' },
];

const CATEGORY_OF: Record<string, string> = {
  Edit: '編集',
  MultiEdit: '編集',
  Write: '編集',
  NotebookEdit: '編集',
  Bash: '実行',
  BashOutput: '実行',
  KillShell: '実行',
  KillBash: '実行',
  Read: '読込',
  NotebookRead: '読込',
  Grep: '検索',
  Glob: '検索',
  ToolSearch: '検索',
  WebSearch: '検索',
  WebFetch: '取得',
  Agent: 'エージェント',
  Task: 'エージェント',
  Workflow: 'ワークフロー',
  AskUserQuestion: '質問',
  TodoWrite: 'ToDo',
};

function categoryOf(tool: ToolItem): Category {
  const mcp = mcpParts(tool.name);
  const label = mcp ? (mcp.server === 'Browser' || mcp.server === 'Chrome' || mcp.server === 'アプリ内ブラウザ' ? 'ブラウザ' : 'MCP') : (CATEGORY_OF[tool.name] ?? 'その他');
  return CATEGORIES.find((c) => c.label === label)!;
}

// 畳んだときの要約。例: 8件の操作 · 編集 5 · 実行 2 · 読込 1 · 14秒
export function groupSummary(group: ToolGroup): { count: string; parts: string[]; failed: number; duration: string | null } {
  const counts = new Map<string, number>();
  for (const tool of group.tools) {
    const label = categoryOf(tool).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = CATEGORIES.filter((c) => counts.has(c.label)).map((c) => `${c.label} ${counts.get(c.label)}`);
  const failed = group.tools.filter((t) => t.status === 'error').length;
  return { count: `${group.tools.length}件の操作`, parts, failed, duration: groupDuration(group) };
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
  if (category.label === '質問') return tool.status === 'running' ? '質問への回答を待っています…' : '質問に回答しました';
  if (tool.description) {
    const text = shorten(tool.description.replace(/[。.…]+$/, ''));
    return tool.status === 'running' ? `${text}…` : tool.status === 'error' ? `${text}（失敗）` : text;
  }
  const subject = category.label === 'ToDo' ? 'ToDo' : tool.filePath ? baseName(tool.filePath) : shorten(tool.target || toolLabel(tool.name));
  if (tool.status === 'running') return `${subject} を${category.verb}中…`;
  if (tool.status === 'error') return `${subject} の${category.verb}に失敗しました`;
  return `${subject} を${category.done}`;
}

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

function shorten(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '1秒未満';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`;
}

// 畳んだ hooks の要約。例: フック 3件 · Stop · UserPromptSubmit · 失敗 1 · 1.2秒
export function hookSummary(group: HookGroup): { count: string; events: string[]; failed: number; blocked: number; duration: string | null } {
  const events = [...new Set(group.runs.map((r) => r.event))];
  const times = group.runs.map((r) => r.durationMs).filter((v): v is number => v !== null);
  return {
    count: `フック ${group.runs.length}件`,
    events,
    failed: group.runs.filter((r) => r.outcome === 'error').length,
    blocked: group.runs.filter((r) => r.outcome === 'blocked').length,
    duration: times.length > 0 ? formatDuration(times.reduce((a, b) => a + b, 0)) : null,
  };
}
