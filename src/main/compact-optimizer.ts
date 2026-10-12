import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { compactInstructions, type CompactMark, type ContextItem } from '@shared/context';
import { t } from '@shared/i18n';
import { readEntries } from './chat-log';
import { childEnv } from './claude-session';
import { ContextTracker } from './context-tracker';

// 最適化圧縮。会話ログから今のコンテキストの行（ContextTracker）と中身の抜粋を集め、使い捨ての Claude Code（Haiku）に
// 行ごとの「残す」「捨てる」を選ばせて、その印から /compact に添える指示の文を組み立てる（人が印を付けるときと同じ compactInstructions）。
// Haiku はツールも MCP も hooks も使わず、会話も保存しない（claude -p で 1 回答えさせるだけ）

// 選ばせるモデル（Claude Code の別名。最新の Haiku になる）
export const OPTIMIZER_MODEL = 'haiku';
// 答えが返るまで待つ時間（実測では、ツールの結果 30 件ほどの会話で 10 秒ほど）
const TIMEOUT_MS = 180_000;
// 行ごとの抜粋の長さ。新しいやりとりほど今の作業が分かるので長くする
const ITEM_CHARS = 1500;
const RECENT_CHARS = 6000;
const RECENT_TOPICS = 3;
// 抜粋の合計の上限。超えるときは、新しいやりとり以外の行を短くする
const TOTAL_CHARS = 400_000;
const MIN_ITEM_CHARS = 200;

const SYSTEM_PROMPT = `You decide what a coding agent's context keeps when it is compacted. The agent (Claude Code) is about to summarize its conversation to free up its context window, and will then keep working with the user. You get the items that make up its current context, oldest first. Each item has an id, a kind, a label, an approximate size in tokens, and an excerpt of its content.

Kinds: file = a file the agent read or wrote (edited="true" if it wrote it); tool = a large tool result; image = an image; agent = a subagent's result; topic = one user message and the exchange that followed it (replies, tool calls, small tool results); summary = the summary from an earlier compaction.

Infer what the user is working on now from the latest topics. Then choose one mark for every item:
- keep: needed in detail to continue the current work. For example: files being changed or about to be changed, the user's requirements and decisions that still apply, unresolved errors, and facts that would be costly to rediscover.
- drop: safe to forget. For example: finished side investigations, superseded attempts, long logs or search output whose conclusion is already known, and files unrelated to the current work.
- auto: unsure. The summarizer decides.

Prefer keep or drop over auto. Never drop the latest topic. Return exactly one mark for each item id.`;

const SCHEMA = {
  type: 'object',
  properties: {
    marks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, mark: { type: 'string', enum: ['keep', 'drop', 'auto'] } },
        required: ['id', 'mark'],
      },
    },
  },
  required: ['marks'],
};

// claude に付ける引数。会話は標準入力から渡す。
// --bare は使わない（OAuth のログインを読まないため、サブスクリプションで使っている人が使えなくなる）。代わりに、ツール・MCP・hooks を止める。
// settingsFile: セッションが設定ファイルを選んでいるとき、その中身に hooks を止める指定を足したファイル（SettingsFiles.prepareOptimizer）。
// --settings は 1 つしか効かないので、無いときだけ hooks を止める指定をそのまま渡す
export function optimizerArgs(settingsFile: string | null = null): string[] {
  return [
    '-p',
    '--model',
    OPTIMIZER_MODEL,
    '--tools',
    '',
    '--strict-mcp-config',
    '--settings',
    settingsFile ?? JSON.stringify({ disableAllHooks: true }),
    '--no-session-persistence',
    '--system-prompt',
    SYSTEM_PROMPT,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SCHEMA),
  ];
}

// 標準入力に prompt を渡して claude を動かし、標準出力を返す
export type RunClaude = (args: string[], prompt: string) => Promise<string>;

// 会話ログ（file）から、最適化圧縮の指示の文を作る。選ぶものが無い・どれも Haiku 任せなら空。
// claudeDir: プロファイルの Claude Code の設定のフォルダ（そのプロファイルのログインで動かす）。settingsFile: optimizerArgs の settingsFile
export async function optimizedInstructions(
  file: string,
  cwd: string,
  { claudeDir = null, settingsFile = null }: { claudeDir?: string | null; settingsFile?: string | null } = {},
  run: RunClaude = runClaude(claudeDir),
): Promise<string> {
  const tracker = new ContextTracker(cwd, true);
  for (const entry of await readEntries(file)) tracker.handle(entry);
  const { items } = tracker.current();
  const live = items.filter((i) => !i.compacted).sort((a, b) => a.order - b.order);
  if (live.length === 0) return '';
  const output = await run(optimizerArgs(settingsFile), optimizerPrompt(live, tracker.excerpts()));
  const marks = parseMarks(output, live);
  // 今の作業のやりとり（いちばん新しいもの）は、捨てさせない
  const latest = live.filter((i) => i.kind === 'topic').pop();
  if (latest && marks.get(latest.id) === 'drop') marks.delete(latest.id);
  return compactInstructions(items, marks);
}

// Haiku に渡す文。行は古い順に、短い番号を付けて並べる（parseMarks で番号から行に戻す）
export function optimizerPrompt(items: ContextItem[], excerpts: ReadonlyMap<string, string>): string {
  const topics = items.filter((i) => i.kind === 'topic');
  const recent = new Set(topics.slice(-RECENT_TOPICS).map((i) => i.id));
  const recentTotal = items.reduce((sum, i) => sum + (recent.has(i.id) ? RECENT_CHARS : 0), 0);
  const others = items.length - recent.size;
  const itemChars = others > 0 ? Math.max(MIN_ITEM_CHARS, Math.min(ITEM_CHARS, Math.floor((TOTAL_CHARS - recentTotal) / others))) : ITEM_CHARS;
  const body = items.map((item, i) => {
    const attrs = [`id="${i + 1}"`, `kind="${item.kind}"`, `label="${attr(item.label)}"`, `tokens="${item.tokens}"`];
    if (item.tool) attrs.push(`tool="${attr(item.tool)}"`);
    if (item.edited) attrs.push('edited="true"');
    const excerpt = shorten(excerpts.get(item.id) ?? '', recent.has(item.id) ? RECENT_CHARS : itemChars).replaceAll('</item>', '</ item>');
    return `<item ${attrs.join(' ')}>\n${excerpt}\n</item>`;
  });
  return `Context items (oldest first):\n\n${body.join('\n\n')}`;
}

// claude の答え（--output-format json）から印を取り出す。番号を行の id に戻し、残す・捨てるだけにする（auto は Haiku 任せなので印を付けない）
export function parseMarks(output: string, items: ContextItem[]): Map<string, CompactMark> {
  let result: { is_error?: unknown; result?: unknown; structured_output?: { marks?: unknown } };
  try {
    result = JSON.parse(output) as typeof result;
  } catch {
    throw new Error(output.trim().split('\n').pop() || t('main.compactOptimizer.noResponse'));
  }
  const marks = result.structured_output?.marks;
  if (result.is_error || !Array.isArray(marks)) throw new Error(typeof result.result === 'string' && result.result ? result.result : t('main.compactOptimizer.noMarks'));
  const chosen = new Map<string, CompactMark>();
  for (const m of marks as { id?: unknown; mark?: unknown }[]) {
    const item = items[Number(m?.id) - 1];
    if (item && (m.mark === 'keep' || m.mark === 'drop')) chosen.set(item.id, m.mark);
  }
  return chosen;
}

// 使い捨ての claude を起動する。作業フォルダは一時フォルダ（プロジェクトの設定・CLAUDE.md を読ませない）。
// bin: 起動する claude（Claude Code との互換性の確認では、TANACODE_CLAUDE_BIN を使う）
export function runClaude(claudeDir: string | null, env: Record<string, string> = childEnv(claudeDir), bin = 'claude'): RunClaude {
  return (args, prompt) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      // 塊の切れ目で日本語などの文字が割れないよう、文字にしてから受け取る
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(t('main.compactOptimizer.timedOut')));
      }, TIMEOUT_MS);
      child.stdout.on('data', (d: string) => (stdout += d));
      child.stderr.on('data', (d: string) => (stderr += d));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // 失敗しても、答えの JSON（is_error と理由）を書くことがあるので、標準出力があればそちらで判断する
        if (stdout.trim()) resolve(stdout);
        else reject(new Error(stderr.trim() || t('main.compactOptimizer.exited', { code: String(code) })));
      });
      // 先に終わったときの書き込みのエラー（EPIPE）は、close で扱う
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n[…]\n${text.slice(text.length - (max - head))}`;
}

function attr(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll('"', '&quot;');
}
