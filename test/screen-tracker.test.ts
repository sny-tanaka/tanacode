import { afterEach, expect, it } from 'vitest';
import type { PermissionMode } from '@shared/screen';
import { findTaskRows, parseTasks } from '../src/main/screen-parser';
import { ScreenTracker } from '../src/main/screen-tracker';

// 画面を読みながらキーを送る操作（権限モードの切り替え）

const MODES: [PermissionMode, string][] = [
  ['manual', '⏸ manual mode on'],
  ['acceptEdits', '⏵⏵ accept edits on'],
  ['plan', '⏸ plan mode on'],
  ['auto', '⏵⏵ auto mode on'],
];
const RULE = '─'.repeat(120);
const screen = (mode: number) => `\x1b[2J\x1b[H${RULE}\r\n❯ \r\n${RULE}\r\n  ${MODES[mode][1]} (shift+tab to cycle)\r\n`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let tracker: ScreenTracker | null = null;
afterEach(() => tracker?.dispose());

it('権限モードを切り替えるとき、キーを送る前から描いていた画面の読み取りで、次のキーを重ねて送らない', async () => {
  let mode = 0;
  const writes: string[] = [];
  // Claude Code の代わり。Shift+Tab を受け取ると、少しあとで次のモードを描く
  const write = (data: string) => {
    writes.push(data);
    setTimeout(() => {
      mode = (mode + 1) % MODES.length;
      tracker!.feed(screen(mode));
    }, 150);
  };
  tracker = new ScreenTracker(120, 40, write, () => {});
  tracker.feed(screen(0));
  for (let i = 0; i < 40 && tracker.current.mode !== 'manual'; i++) await sleep(25);
  expect(tracker.current).toMatchObject({ mode: 'manual', state: { kind: 'prompt' } });
  const switching = tracker.setMode('acceptEdits');
  // キーを送った直後に、送る前の画面の描き直し（作業中の表示など）が届く
  tracker.feed(screen(0));
  expect(await switching).toBe(true);
  await sleep(400);
  expect(writes).toEqual(['\x1b[Z']);
  expect(tracker.current.mode).toBe('acceptEdits');
});

// バックグラウンドのタスクを、/tasks の画面で選んで x で止める操作（stopTask）。
// Claude Code の代わりに、/tasks の一覧・詳細の画面を描く偽物を使う（実際の画面は test/cli/stop.test.ts）
const TOP = `${'▔'.repeat(100)} ◐ medium · /effort ▔`;
const prompt = (draft: string) => [RULE, `❯ ${draft}`, RULE, '  ⏸ manual mode on · ← for agents'];
const listScreen = (rows: string[], pointed: number) => [
  TOP,
  '   Background',
  `   ${rows.length} active shells`,
  `     Shells (${rows.length})`,
  ...rows.map((row, i) => `   ${i === pointed ? '❯' : ' '} ⏺ ${row.padEnd(40)}   running`),
  '   ↑/↓ to select · Enter to view · x to stop · Esc to close',
];
const detailsScreen = (command: string) => [
  TOP,
  '   Shell details',
  '',
  '   Status:   running',
  `   Command:  ${command}`,
  '',
  '   ← to go back · Esc/Enter/Space to close · x to stop',
];
const paint = (lines: string[]) => `\x1b[2J\x1b[H${lines.join('\r\n')}\r\n`;

// 偽の Claude Code。rows が 1 つなら /tasks は詳細を出し、2 つ以上なら一覧を出す。
// reactMs: x に反応するまでの遅れ（遅いと、その間の画面が変わらず、「操作できない画面」とみなされかねない）
function fakeTasks(rows: string[], { reactMs = 30, closesOnStop = false }: { reactMs?: number; closesOnStop?: boolean } = {}) {
  const writes: string[] = [];
  const states: string[] = [];
  let draft = '';
  let view: 'prompt' | 'list' | 'details' = 'prompt';
  let pointed = 0;
  const show = () => {
    if (view === 'list') return paint(listScreen(rows, pointed));
    if (view === 'details') return paint(detailsScreen(rows[0]));
    return paint(draft.startsWith('/') ? ['  /tasks    View and manage everything running in the background', ...prompt(draft)] : prompt(draft));
  };
  const later = (ms: number, fn: () => void) =>
    setTimeout(() => {
      fn();
      tracker!.feed(show());
    }, ms);
  const write = (data: string) => {
    writes.push(data);
    if (view === 'prompt') {
      if (data === '\r') later(30, () => ((draft = ''), (view = rows.length === 1 ? 'details' : 'list'), (pointed = 0)));
      else later(30, () => (draft += data));
      return;
    }
    if (data === '\x1b') return later(30, () => (view = 'prompt'));
    if (data === '\x1b[B' && view === 'list') return later(30, () => (pointed = Math.min(rows.length - 1, pointed + 1)));
    if (data === '\x1b[A' && view === 'list') return later(30, () => (pointed = Math.max(0, pointed - 1)));
    if (data === 'x') {
      later(reactMs, () => {
        rows.splice(view === 'list' ? pointed : 0, 1);
        pointed = Math.min(pointed, rows.length - 1);
        if (view === 'details' || closesOnStop || rows.length === 0) view = 'prompt';
      });
    }
  };
  tracker = new ScreenTracker(120, 40, write, (info) => states.push(`${info.state.kind}`));
  tracker.feed(paint(prompt('')));
  return { writes, states, rows };
}

const ready = async () => {
  for (let i = 0; i < 40 && tracker!.current.state.kind !== 'prompt'; i++) await sleep(25);
};

it('/tasks の一覧で、止めたいものにカーソルを合わせて x を送る。反応が遅くても、画面を操作している間は「操作できない画面」にならない', async () => {
  const fake = fakeTasks(['echo two; sleep 601', 'echo one; sleep 600'], { reactMs: 1600 });
  await ready();
  expect(await tracker!.stopTask('echo one; sleep 600')).toBe('stopped');
  // 一覧が残ったので、入力欄が見えるまで Esc を送る
  expect(fake.writes).toEqual(['/tasks', '\r', '\x1b[B', 'x', '\x1b']);
  expect(fake.rows).toEqual(['echo two; sleep 601']);
  await sleep(100);
  expect(fake.states).not.toContain('unknown');
  expect(tracker!.current).toMatchObject({ state: { kind: 'prompt' }, draft: '' });
});

it('/tasks の一覧で省略された長いコマンドも、頭が同じなら見つける。名前が同じものが 2 つあれば、何も止めずに閉じる', async () => {
  const long = `echo long-start; ${'sleep 1; '.repeat(30)}sleep 700`;
  const fake = fakeTasks([`${long.slice(0, 30)}…`, 'sleep 602', 'sleep 602']);
  await ready();
  expect(await tracker!.stopTask(long)).toBe('stopped');
  expect(fake.rows).toEqual(['sleep 602', 'sleep 602']);
  expect(await tracker!.stopTask('sleep 602')).toBe('ambiguous');
  // 止めていない（x を送っていない）
  expect(fake.writes.filter((w) => w === 'x')).toHaveLength(1);
  expect(fake.rows).toEqual(['sleep 602', 'sleep 602']);
  expect(tracker!.current.state.kind).toBe('prompt');
});

it('/tasks の一覧に無いものは、下へ・上へ探して、見つからなければ何も止めずに閉じる', async () => {
  const fake = fakeTasks(['sleep 1', 'sleep 2', 'sleep 3']);
  await ready();
  expect(await tracker!.stopTask('sleep 9')).toBe('not-found');
  expect(fake.writes.filter((w) => w === 'x')).toHaveLength(0);
  expect(fake.writes[fake.writes.length - 1]).toBe('\x1b');
  expect(fake.rows).toHaveLength(3);
});

it('1 つだけのときの詳細の画面でも、コマンドが合っていれば x を送る。画面が閉じたら Esc は送らない（作業を中断してしまうため）', async () => {
  const fake = fakeTasks(['echo only; sleep 600']);
  await ready();
  expect(await tracker!.stopTask('echo only; sleep 600')).toBe('stopped');
  expect(fake.writes).toEqual(['/tasks', '\r', 'x']);
});

it('1 つだけの詳細が、止めたいものと違うときは、x を送らずに閉じる', async () => {
  const fake = fakeTasks(['echo other']);
  await ready();
  expect(await tracker!.stopTask('echo only; sleep 600')).toBe('not-found');
  expect(fake.writes).toEqual(['/tasks', '\r', '\x1b']);
});

it('入力欄に書きかけの文字があるときと、入力欄が出ていないときは、何も打たない', async () => {
  const writes: string[] = [];
  tracker = new ScreenTracker(120, 40, (data) => writes.push(data), () => {});
  tracker.feed(paint(prompt('書きかけ')));
  for (let i = 0; i < 40 && tracker.current.draft !== '書きかけ'; i++) await sleep(25);
  expect(await tracker.stopTask('sleep 600')).toBe('draft');
  tracker.feed(paint(['', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel']));
  for (let i = 0; i < 60 && tracker.current.state.kind === 'prompt'; i++) await sleep(25);
  expect(await tracker.stopTask('sleep 600')).toBe('not-prompt');
  expect(writes).toEqual([]);
});

it('止めたいものを画面の名前から探すとき、同じ名前を先に選び、頭が同じだけの別のものと取り違えない', () => {
  // 「npm run dev」と「npm run dev:api」
  expect(findTaskRows('npm run dev:api', ['npm run dev', 'npm run dev:api'])).toEqual([1]);
  expect(findTaskRows('npm run dev', ['npm run dev', 'npm run dev:api'])).toEqual([0]);
  // 省略（…）された名前は、頭が同じものに当たる。空白の違いは見ない
  expect(findTaskRows('echo a;  sleep 1; sleep 2; sleep 3', ['echo a; sleep 1; sleep…', 'sleep 9'])).toEqual([0]);
  // 複数行のコマンドなど、省略の印なしに途中までしか出ないものは、ほかに当たるものが無いときだけ
  expect(findTaskRows('cd /tmp\nnpm test', ['cd /tmp'])).toEqual([0]);
  expect(findTaskRows('cd /tmp\nnpm test', ['cd /tmp', 'cd /tmp\nnpm test'])).toEqual([1]);
  // 同じ名前が 2 つあれば 2 つ返す（決められない）。無ければ空
  expect(findTaskRows('sleep 602', ['sleep 602', 'sleep 602'])).toEqual([0, 1]);
  expect(findTaskRows('sleep 9', ['sleep 1', 'sleep 2'])).toEqual([]);
});

it('/tasks の画面を、一覧・詳細・ワークフローの詳細として読み、それ以外（入力欄・メニュー）は読まない', () => {
  const lines = (rows: string[]) => rows.map((text) => ({ text, full: false }));
  const list = parseTasks(lines(listScreen(['echo two', 'echo one'], 1)));
  expect(list).toMatchObject({ view: 'list', canStop: true, rows: [{ label: 'echo two', pointed: false }, { label: 'echo one', pointed: true }] });
  expect(parseTasks(lines(detailsScreen('echo only')))).toMatchObject({ view: 'details', canStop: true, subjects: ['echo only'] });
  // エージェントの詳細は、先頭の行の「種類 › 説明」
  const agent = parseTasks(lines([TOP, '   general-purpose › 長い調べもの', '   4s · Opus 5.5', '   ← to go back · Esc/Enter/Space to close · x to stop · f to foreground']));
  expect(agent).toMatchObject({ view: 'details', canStop: true, subjects: ['長い調べもの'] });
  // ワークフローは名前が先頭の行。止めたあとは案内から x が消える
  const workflow = (hint: string) => lines([TOP, '   probe-flow', '   調査のワークフロー      0/1 agent · 4s', `   ${hint}`]);
  expect(parseTasks(workflow('↑↓ select · x stop workflow · p pause · esc back · s save'))).toMatchObject({ view: 'workflow', canStop: true, subjects: ['probe-flow'] });
  expect(parseTasks(workflow('↑↓ select · esc back · s save'))).toMatchObject({ view: 'workflow', canStop: false });
  expect(parseTasks(lines(prompt('')))).toBeNull();
  expect(parseTasks(lines([TOP, '   something else', '   Esc to close']))).toBeNull();
});
