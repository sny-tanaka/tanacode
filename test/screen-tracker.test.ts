import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type { PermissionMode, ScreenLine } from '@shared/screen';
import { findTaskRows, parseTasks, showsCommandSuggestion } from '../src/main/screen-parser';
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

// 長い応答を書いている途中の進み具合。動作確認済のバージョンの控え（作業が終わったあとの pasted-draft）を元に、
// 入力欄より上の会話の行だけを差し替えて流し込む。
// 本物の Claude Code 2.1.292 を Linux で動かし、長い応答を流して見ると、タイマーの行は消え、応答の始まり（Linux の印は ●）の行は
// 画面の上へ流れて見えなくなり、画面のいちばん上から入力欄の上まで、応答の本文（字下げ 2）の行だけが並ぶ。
// この画面は控えに無い（クラウドの環境で見たもので、控えには残していない）ので、応答の行は作ったもの
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'claude-code', VERIFIED_CLAUDE_CODE_VERSION, 'screens', `${name}.json`), 'utf8')) as ScreenLine[];
// 1 行ずつ位置を決めて描く（端末の幅いっぱいの行で、次の行へ送られないように）
const draw = (rows: string[]) => `\x1b[2J${rows.map((row, y) => `\x1b[${y + 1};1H${row}`).join('')}`;

it('長い応答の始まり（⏺）が画面の外に流れても、書き終わるまで「応答を書いている」のままにする。中断したら作業中でなくなる', async () => {
  const done = fixture('pasted-draft').map((l) => l.text);
  // 完了の行（✻ Worked for 0s · done …）。ここから下（入力欄まで）は控えのまま
  const at = done.findIndex((text) => /^✻ \S+ for \d+s · done/.test(text));
  const below = done.slice(at + 1);
  const reply = (from: number) => Array.from({ length: at }, (_, i) => `  ${from + i}. 項目 ${from + i} を確かめました`);
  // 中断の行は、控え（tool-interrupted）のもの。上と同じく本物の 2.1.292 で見ると、応答の途中で中断したときも、応答の下にこの行が出る
  const interrupted = fixture('tool-interrupted').find((l) => /^\s+⎿\s+Interrupted/.test(l.text))!.text;
  tracker = new ScreenTracker(120, 40, () => {}, () => {});
  const phase = async (rows: string[]) => {
    expect(rows).toHaveLength(done.length);
    tracker!.feed(draw(rows));
    await sleep(200);
    return tracker!.currentActivity?.phase ?? null;
  };
  // 書き始め（⏺ が見えている）
  expect(await phase(['⏺ 調べた結果です。', ...reply(1).slice(1), '', ...below])).toBe('writing');
  // ⏺ が画面の外に流れた
  expect(await phase([...reply(5), '', ...below])).toBe('writing');
  expect(await phase([...reply(9), '', ...below])).toBe('writing');
  // 書き終わると、完了の行が出る
  expect(await phase(done)).toBeNull();
  // もう一度、長い応答を書いている途中で中断する
  expect(await phase(['⏺ 調べた結果です。', ...reply(1).slice(1), '', ...below])).toBe('writing');
  expect(await phase([...reply(5), '', ...below])).toBe('writing');
  expect(await phase([...reply(6).slice(1), interrupted, '', ...below])).toBeNull();
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

it('省略された名前（…）が頭の合うものを先に選び、省略されていない短い名前とは取り違えない。省略された別の名前は、頭が合わなければ当たらない', () => {
  // 「npm run dev」（そのままの名前）と、「npm run dev:api --port 3000」を省略した名前が並ぶ
  expect(findTaskRows('npm run dev:api --port 3000', ['npm run dev', 'npm run dev:api --po…'])).toEqual([1]);
  // 途中までしか出ない複数行のコマンドを探すとき、省略された別のコマンドは数えない
  expect(findTaskRows('cd /tmp\nnpm test', ['cd /tmp', 'npm run build -- --wat…'])).toEqual([0]);
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

it('/ の補完の候補の行を、入力欄の行と字下げで見分ける（選択中の候補の頭に ❯ が付く Claude Code 2.1.290 と、付かない 2.1.289）', () => {
  const lines = (rows: string[]) => rows.map((text) => ({ text, full: false }));
  // 打った直後で、まだ補完が出ていない（入力欄の行だけ）
  expect(showsCommandSuggestion(lines(prompt('/tasks')), '/tasks')).toBe(false);
  // 2.1.289
  expect(showsCommandSuggestion(lines(['  /tasks          List and manage background tasks', ...prompt('/tasks')]), '/tasks')).toBe(true);
  // 2.1.290
  expect(showsCommandSuggestion(lines(['  ❯ /clear                      Start a new session with empty context', ...prompt('/clear')]), '/clear')).toBe(true);
  // 名前が前だけ同じ別のコマンドは数えない
  expect(showsCommandSuggestion(lines(['  ❯ /tasks-list   ほかのコマンド', ...prompt('/tasks')]), '/tasks')).toBe(false);
});

// 選択メニューを選ぶ操作（choose）。Claude Code の代わりに、控え（動作確認済のバージョンで取った画面）を描く偽物を使う。
// 偽物は、本物の Claude Code（2.1.293）をモックの API で動かして確かめた振る舞いをまねる:
// - 直前の入力（指示の送信・前のメニューへの Enter）から graceMs（本物では約 250ms）たたないうちにメニューに届いた Enter は、
//   何も描かずに捨てる。あとから効くこともない（出たばかりの確認を、続けて押したキーで答えてしまわないための仕組み）
// - 受け付けた Enter は、メニューを閉じて（入力欄の画面を描いて）、roundtripMs のあとに次の画面を出す（API の応答を待つ間）
const screenAnsi = (name: string) => readFileSync(join(__dirname, 'fixtures', 'claude-code', VERIFIED_CLAUDE_CODE_VERSION, 'screens', `${name}.ansi`), 'utf8');
const repaint = (name: string) => `\x1b[2J\x1b[H${screenAnsi(name)}`;

function fakeMenus(screens: string[], { graceMs = 250, roundtripMs = 120 }: { graceMs?: number; roundtripMs?: number } = {}) {
  let index = 0;
  let lastInput = 0;
  const accepted: string[] = [];
  const ignored: string[] = [];
  const write = (data: string) => {
    const name = screens[index];
    if (data !== '\r' || !name) return;
    if (Date.now() - lastInput < graceMs) {
      ignored.push(name);
      return;
    }
    lastInput = Date.now();
    accepted.push(name);
    index++;
    setTimeout(() => tracker?.feed(repaint('prompt')), 30);
    const next = screens[index];
    if (next) setTimeout(() => tracker?.feed(repaint(next)), roundtripMs);
  };
  return { write, accepted, ignored, shown: () => screens[index] ?? null };
}

const menuKind = () => (tracker?.current.state.kind === 'menu' ? tracker.current.state.menu.kind : null);
const until = async (check: () => boolean, timeoutMs = 3000) => {
  for (const end = Date.now() + timeoutMs; !check() && Date.now() < end; ) await sleep(20);
  return check();
};

it('答えた直後に出た次の確認を、出てすぐ押しても、Claude Code が入力を受け付けない間に送って失わない', async () => {
  const claude = fakeMenus(['question', 'write-permission']);
  tracker = new ScreenTracker(120, 40, claude.write, () => {});
  tracker.feed(screenAnsi('question'));
  expect(await until(() => menuKind() === 'question')).toBe(true);
  const first = await tracker.choose('1', 'enter');
  expect(await until(() => menuKind() === 'permission')).toBe(true);
  // カードが出てすぐに押す（前の答えの Enter から間もない。本物の Claude Code は、この間の Enter を捨てる）
  const second = await tracker.choose('1', 'enter');
  await until(() => claude.shown() === null);
  expect(claude.accepted).toEqual(['question', 'write-permission']);
  expect([first, second]).toEqual(['chosen', 'chosen']);
});

it('Claude Code が思ったより長く入力を受け付けないときは、画面が少しも変わらないのを確かめてから送り直す', async () => {
  const claude = fakeMenus(['question', 'write-permission'], { graceMs: 900 });
  tracker = new ScreenTracker(120, 40, claude.write, () => {});
  tracker.feed(screenAnsi('question'));
  expect(await until(() => menuKind() === 'question')).toBe(true);
  await tracker.choose('1', 'enter');
  expect(await until(() => menuKind() === 'permission')).toBe(true);
  const result = await tracker.choose('1', 'enter');
  await until(() => claude.shown() === null);
  expect(claude.accepted).toEqual(['question', 'write-permission']);
  expect(claude.ignored).toEqual(['write-permission']);
  expect(result).toBe('chosen');
});

it('押した Enter が効いたあと、同じ確認がすぐまた出ても、もう一度は押さない（次の確認を勝手に選ばない）', async () => {
  const claude = fakeMenus(['bash-permission', 'bash-permission']);
  tracker = new ScreenTracker(120, 40, claude.write, () => {});
  tracker.feed(screenAnsi('bash-permission'));
  expect(await until(() => menuKind() === 'permission')).toBe(true);
  const result = await tracker.choose('1', 'enter');
  // 送り直すまで待つ時間より長く見る
  await sleep(2500);
  expect(claude.accepted).toEqual(['bash-permission']);
  expect(claude.shown()).toBe('bash-permission');
  expect(result).toBe('chosen');
});

it('押せなかったときは、黙って捨てずに理由を返す（メニューが無い・選択肢が無い・ほかの操作の途中・Claude Code が受け付けない）', async () => {
  const writes: string[] = [];
  tracker = new ScreenTracker(120, 40, (data) => writes.push(data), () => {});
  tracker.feed(screenAnsi('prompt'));
  expect(await until(() => tracker?.current.state.kind === 'prompt')).toBe(true);
  expect(await tracker.choose('1', 'enter')).toBe('gone');
  tracker.feed(repaint('bash-permission'));
  expect(await until(() => menuKind() === 'permission')).toBe(true);
  expect(await tracker.choose('9', 'enter')).toBe('missing');
  expect(writes).toEqual([]);
  // この偽物は Enter に何も描かない（Claude Code が受け付けない）。送っている間に押したものは、ほかの操作の途中として返す
  const pending = tracker.choose('1', 'enter');
  expect(await tracker.choose('4', 'enter')).toBe('busy');
  expect(await pending).toBe('ignored');
  // 画面が少しも変わらないのを確かめながら、3 回まで送る。それでも閉じなければ、受け付けられなかったと返す
  expect(writes).toEqual(['\r', '\r', '\r']);
});

// 起動直後のフォルダの信頼の確認の代わり。本物の Claude Code（2.1.293）で確かめた振る舞いをまねる:
// 出てから少しの間（本物では 0.13〜0.17 秒。重いときはもっと遅い）に ↓ を押すと、カーソルはいったん動くが、そのあと描き直されて
// 「No, exit」に戻る。その間に届いた Enter は、描き直したあとのメニュー（カーソルは No, exit）で選ばれる（claude は終わる）
function fakeTrust({ resetMs = 200 }: { resetMs?: number } = {}) {
  const rows = fixture('trust').map((l) => l.text);
  const labels = ['No, exit', 'Yes, I trust this folder'];
  const at = labels.map((label) => rows.findIndex((text) => text.trim().replace(/^❯\s+/, '') === label));
  let pointed = 0;
  let shownAt = 0;
  let queued = false;
  let answer: string | null = null;
  const paint = () => {
    if (answer !== null) return tracker?.feed('\x1b[2J\x1b[H');
    const screen = [...rows];
    at.forEach((row, i) => (screen[row] = `${i === pointed ? ' ❯ ' : '   '}${labels[i]}`));
    tracker?.feed(draw(screen));
  };
  const write = (data: string) => {
    if (answer !== null) return;
    if (data === '\x1b[B' || data === '\x1b[A') {
      pointed = data === '\x1b[B' ? Math.min(1, pointed + 1) : Math.max(0, pointed - 1);
      setTimeout(paint, 10);
    } else if (data === '\r') {
      if (Date.now() < shownAt + resetMs) queued = true;
      else {
        answer = labels[pointed];
        setTimeout(paint, 10);
      }
    }
  };
  const show = () => {
    shownAt = Date.now();
    paint();
    setTimeout(() => {
      pointed = 0;
      if (queued) answer = labels[0];
      paint();
    }, resetMs);
  };
  return { write, show, answer: () => answer };
}

it('出たばかりのメニューが描き直されてカーソルが戻っても、押したのと違う選択肢を選ばない（起動直後のフォルダの信頼の確認）', async () => {
  const claude = fakeTrust();
  tracker = new ScreenTracker(120, 40, claude.write, () => {});
  claude.show();
  expect(await until(() => menuKind() === 'other')).toBe(true);
  // カードが出てすぐに「Yes, I trust this folder」を押す
  const result = await tracker.choose('2', 'enter');
  await until(() => claude.answer() !== null);
  expect(claude.answer()).toBe('Yes, I trust this folder');
  expect(result).toBe('chosen');
});
