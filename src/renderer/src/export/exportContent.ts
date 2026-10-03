import type { HookRun, TodoItem } from '@shared/chat';
import type { ChatItem } from '../chat/chatState';
import { DIFF_TOOLS } from '../chat/ToolCard';

// 書き出しに入れるもの（確認の画面で選ぶ）。homeToTilde: ホームフォルダのパスを ~ に置き換える
export type ExportOptions = { toolOutput: boolean; diffs: boolean; images: boolean; thinking: boolean; homeToTilde: boolean };

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { toolOutput: true, diffs: true, images: true, thinking: true, homeToTilde: true };

// 範囲の選択肢にする発言。index: items の中の位置
export type ExportPrompt = { index: number; text: string; at?: number };

export function promptsOf(items: ChatItem[]): ExportPrompt[] {
  const prompts: ExportPrompt[] = [];
  items.forEach((item, index) => {
    if (item.kind === 'user') prompts.push({ index, text: item.text || '（画像）', at: item.at });
  });
  return prompts;
}

// from 番目の発言から to 番目の発言（への応答の終わり）までの行。最初の発言からなら、その前の行（起動時のお知らせなど）も入れる
export function sliceRange(items: ChatItem[], prompts: ExportPrompt[], from: number, to: number): ChatItem[] {
  if (prompts.length === 0) return items;
  const start = from <= 0 ? 0 : prompts[from].index;
  const end = to >= prompts.length - 1 ? items.length : prompts[to + 1].index;
  return items.slice(start, end);
}

// 確認の画面に出す、入るものの数
export type ExportCounts = { prompts: number; replies: number; tools: number; outputs: number; diffs: number; images: number; thinking: number };

export function countContents(items: ChatItem[]): ExportCounts {
  const counts: ExportCounts = { prompts: 0, replies: 0, tools: 0, outputs: 0, diffs: 0, images: 0, thinking: 0 };
  const hookOutputs = (runs: HookRun[] | undefined) => (runs ?? []).filter((r) => r.stdout || r.stderr || r.message).length;
  for (const item of items) {
    if (item.kind === 'user') {
      counts.prompts++;
      counts.images += item.images?.length ?? 0;
    } else if (item.kind === 'text') counts.replies++;
    else if (item.kind === 'thinking') counts.thinking++;
    else if (item.kind === 'shell' && item.output) counts.outputs++;
    else if (item.kind === 'hook') counts.outputs += hookOutputs(item.runs);
    else if (item.kind === 'tool') {
      counts.tools++;
      if (item.output) counts.outputs++;
      counts.outputs += hookOutputs(item.hooks);
      if (item.patch) counts.diffs++;
      counts.images += item.images?.length ?? 0;
    }
  }
  return counts;
}

// 書き出した HTML の先頭に出すもの
export type ExportMeta = {
  title: string;
  cwd: string;
  branches: string[];
  period: { start: number; end: number } | null;
  // 書き出した範囲（例: 全体（発言 12 件））
  range: string;
  // 入れなかったもの（例: ツールの結果・画像）
  omitted: string[];
  files: ChangedFile[];
  exportedAt: number;
};

// 選んだ範囲（発言の番号。0 から）と、発言の数
export type ExportSpan = { start: number; end: number; total: number };

// 範囲の行に、選んだものを当てて、書き出す行・ToDo の進み具合（todoSteps）・先頭に出すものを作る
export function prepareExport(
  range: ChatItem[],
  todoSteps: ReadonlyMap<string, TodoItem[]>,
  session: { title: string; cwd: string; branches: string[]; home: string },
  options: ExportOptions,
  span: ExportSpan,
  now: number,
): { items: ChatItem[]; todoSteps: ReadonlyMap<string, TodoItem[]>; meta: ExportMeta } {
  const items = applyOptions(range, options, session.home);
  const counts = countContents(range);
  const tilde = <T>(value: T): T => (options.homeToTilde ? replaceHomeDeep(value, session.home) : value);
  const cwd = tilde(session.cwd);
  const whole = span.start === 0 && span.end === span.total - 1;
  const omitted = [
    !options.toolOutput && counts.outputs > 0 && 'ツールの結果',
    !options.diffs && counts.diffs > 0 && '編集の差分',
    !options.images && counts.images > 0 && '画像',
    !options.thinking && counts.thinking > 0 && '思考',
  ].filter((v): v is string => !!v);
  return {
    items,
    todoSteps: new Map([...todoSteps].map(([id, todos]) => [id, tilde(todos)])),
    meta: {
      title: tilde(session.title),
      cwd,
      branches: tilde(session.branches),
      period: periodOf(range),
      range: whole ? `全体（発言 ${span.total} 件）` : `発言 ${span.start + 1}〜${span.end + 1}（全 ${span.total} 件のうち ${span.end - span.start + 1} 件）`,
      omitted,
      files: changedFiles(items, cwd),
      exportedAt: now,
    },
  };
}

// 選んだものを外す。ツールの結果を外すときは、! のコマンドと hooks の出力（標準出力・標準エラー・Claude に渡した内容・止めた理由）も外す
// （変えた行の数・hooks の結果は残す）。差分を外すときは、ノートブックの編集の入力（書いた中身が入る）も外す
export function applyOptions(items: ChatItem[], options: ExportOptions, home: string): ChatItem[] {
  const hooks = (runs: HookRun[]) => (options.toolOutput ? runs : runs.map((r) => ({ ...r, stdout: '', stderr: '', message: '' })));
  const out = items.flatMap((item): ChatItem[] => {
    if (item.kind === 'thinking') return options.thinking ? [item] : [];
    if (item.kind === 'user') return [options.images ? item : { ...item, images: undefined }];
    if (item.kind === 'shell') return [options.toolOutput ? item : { ...item, output: '' }];
    if (item.kind === 'hook') return [{ ...item, runs: hooks(item.runs) }];
    if (item.kind === 'tool') {
      return [
        {
          ...item,
          output: options.toolOutput ? item.output : undefined,
          hooks: item.hooks && hooks(item.hooks),
          patch: options.diffs ? item.patch : undefined,
          input: options.diffs || !DIFF_TOOLS.has(item.name) ? item.input : '',
          images: options.images ? item.images : undefined,
        },
      ];
    }
    return [item];
  });
  return options.homeToTilde ? replaceHomeDeep(out, home) : out;
}

// ホームフォルダのパス（/Users/<名前>）を ~ にする。/Users/<名前>2 のような別のフォルダや、パスの途中（…/Data/Users/<名前>）は置き換えない。
// Claude Code の会話ログのフォルダ名（パスの / を - にした -Users-<名前>-…）の中も、名前を残さないよう -~ にする
export function replaceHome(text: string, home: string): string {
  const base = home.replace(/\/+$/, '');
  if (!base || base === '/') return text;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const encoded = base.replace(/[^A-Za-z0-9]/g, '-');
  return text
    .replace(new RegExp(`(?<![\\w.-])${escape(base)}(?![\\w@-]|\\.[\\w-])`, 'g'), '~')
    .replace(new RegExp(`(?<![\\w-])${escape(encoded)}(?![A-Za-z0-9])`, 'g'), '-~');
}

// 文字の中身をすべて置き換える（画像の鍵は uuid なので変わらない）
function replaceHomeDeep<T>(value: T, home: string): T {
  if (typeof value === 'string') return replaceHome(value, home) as T;
  if (Array.isArray(value)) return value.map((v) => replaceHomeDeep(v, home)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceHomeDeep(v, home)])) as T;
  }
  return value;
}

// 変えたファイル（Edit・Write など）と、変えた行の数の合計。最初に変えた順
export type ChangedFile = { path: string; added: number; removed: number };

export function changedFiles(items: ChatItem[], cwd: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const item of items) {
    if (item.kind !== 'tool' || !DIFF_TOOLS.has(item.name) || !item.filePath || item.status !== 'done') continue;
    const path = relativeTo(item.filePath, cwd);
    const file = files.get(path) ?? { path, added: 0, removed: 0 };
    file.added += item.added ?? 0;
    file.removed += item.removed ?? 0;
    files.set(path, file);
  }
  return [...files.values()];
}

function relativeTo(path: string, cwd: string): string {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

// 最初と最後の時刻（会話ログの時刻が無ければ null）
export function periodOf(items: ChatItem[]): { start: number; end: number } | null {
  const times = items.flatMap((item) => {
    if (item.kind === 'user' || item.kind === 'text') return item.at === undefined ? [] : [item.at];
    if (item.kind === 'tool') return [item.startedAt, item.endedAt].filter((t): t is number => t !== undefined);
    return [];
  });
  if (times.length === 0) return null;
  return { start: Math.min(...times), end: Math.max(...times) };
}

// 書き出す画像の鍵（重なりなし）
export function imageKeys(items: ChatItem[]): string[] {
  const keys = items.flatMap((item) => (item.kind === 'user' || item.kind === 'tool' ? (item.images ?? []) : []));
  return [...new Set(keys)];
}

// 保存のダイアログに出すファイル名。セッション名と日付（ファイル名に使えない文字は空白にする）
export function exportFileName(title: string | null, date: Date): string {
  const name = (title ?? '').replace(/[/\\:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '作業';
  return `${name} ${formatDate(date)}.html`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 例: 2026/10/03 14:05
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 例: 2026/10/03 14:05 〜 16:40（同じ日なら終わりは時刻だけ）
export function formatPeriod({ start, end }: { start: number; end: number }): string {
  const from = formatDateTime(start);
  const to = formatDateTime(end);
  return from.slice(0, 10) === to.slice(0, 10) ? `${from} 〜 ${to.slice(11)}` : `${from} 〜 ${to}`;
}
