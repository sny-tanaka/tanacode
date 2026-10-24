import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/main/mcp-bridge';
import { ShellTerminals, type TerminalInfo } from '../src/main/shell-terminals';
import { TERMINAL_GATE_REQUEST, readGateAnswer } from '../src/main/terminal-bridge';
import { TerminalControl, type TerminalSessions, type TerminalsApi } from '../src/main/terminal-control';

// Claude による人のターミナルの読み書き（terminal-control.ts）。本物のシェル（/bin/sh）を ShellTerminals で開き、
// 中継から届く呼び出し（ツールと、打つ前の確認のフックの問い合わせ）を直に渡して確かめる。
// - 読む: 自分と自分の子のターミナルだけ。行数は 1〜2000 にそろえ、3 万文字で切る
// - 打つ: フックが控えさせた確認済みの印が無ければ断る。印は 1 回だけ使え、15 分で失効する。子セッションからは打てない。改行は断る

const ME = '11111111-0000-4000-8000-000000000001';
const CHILD = '22222222-0000-4000-8000-000000000002';
const OTHER = '33333333-0000-4000-8000-000000000003';

let dir: string;
let shells: ShellTerminals;
let control: TerminalControl;
let enabled: boolean;
// 時計を進める（印の失効）。待ちは本物の時間で進むので、足すだけにする
let offset: number;
const opened: { owner: string; id: string; task: boolean }[] = [];
const oldShell = process.env.SHELL;

const sessions: TerminalSessions = {
  exists: (id) => [ME, CHILD, OTHER].includes(id),
  cwdOf: () => dir,
  parentOf: (id) => (id === CHILD ? ME : null),
  childrenOf: (id) => (id === ME ? [CHILD] : []),
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-terminal-')));
  process.env.SHELL = '/bin/sh';
  enabled = true;
  offset = 0;
  opened.length = 0;
  shells = new ShellTerminals({ onData: () => {}, onExit: () => {}, onOpened: (owner, id, _name, task) => opened.push({ owner, id, task }) });
  control = new TerminalControl({ terminals: shells, sessions, enabled: () => enabled, clock: () => Date.now() + offset, quietMs: 300, maxWaitMs: 2000 });
});
afterEach(() => {
  shells.killAll();
  process.env.SHELL = oldShell;
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (result: ToolResult) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

// プロンプトを決まった形（$ ）にしたシェルを開き、シェルが打つものを待つところまで待つ。
// シェルが起動する前に打つと、打った文字は pty がすぐ映し、プロンプトと出力はそのあとに続く。行の編集の無いシェル
// （Linux の /bin/sh の dash）は、それを描き直さないので、あとで打った文字がプロンプトより前に出る（「echo $ $」）。
// ready-2 はシェルが計算した出力にだけ出る（打った文字の映りは ready-$((1+1))）ので、映りでは待ち終わらない
async function openShell(owner = ME): Promise<string> {
  const { id } = shells.create(owner, dir, 80, 24);
  shells.write(id, "PS1='$ '; echo ready-$((1+1))\r");
  await waitForText(id, 'ready-2\n$');
  return id;
}

async function waitForText(id: string, text: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await shells.flush(id);
    if ((shells.tail(id, 200) ?? []).join('\n').includes(text)) return;
    if (Date.now() > until) throw new Error(`「${text}」が出ません`);
    await sleep(25);
  }
}

// フックの問い合わせ（確認済みの印を控えさせる）と、そのあとのツールの呼び出し
const gate = (input: Record<string, unknown>, caller = ME) => control.handle(caller, TERMINAL_GATE_REQUEST, input);
const type = (input: Record<string, unknown>, caller = ME) => control.handle(caller, 'type_in_terminal', input);

describe('読む', () => {
  it('list_terminals: このセッションのパネルのターミナルを、タブの並びと画面の名前で返す。画面に出していないコマンドも、番号なしで返し、出力を読める', async () => {
    const shell = await openShell();
    // 通った install は画面に出さない。失敗したものはタブに出る
    await shells.run(ME, dir, 'echo done', 'npm install');
    await shells.run(ME, dir, 'echo broken; exit 2', 'yarn install');
    await openShell(OTHER);
    const result = JSON.parse(textOf(await control.handle(ME, 'list_terminals', {}))) as { session_id: string; terminals: Record<string, unknown>[] };
    expect(result.session_id).toBe(ME);
    expect(result.terminals.map((t) => [t.id, t.tab, t.kind, t.label, t.running, t.exit_code])).toEqual([
      [shell, 1, 'shell', 'sh 1', true, null],
      [expect.stringMatching(/^task-/), null, 'command', 'npm install（完了）', false, 0],
      [expect.stringMatching(/^task-/), 2, 'command', 'yarn install（失敗 2）', false, 2],
    ]);
    expect(result.terminals[0]).toMatchObject({ cwd: dir, command: null, foreground: expect.any(String), last_output_at: expect.any(String) });
    const read = textOf(await control.handle(ME, 'read_terminal', { id: result.terminals[1].id }));
    expect(read).toContain('(not shown in the terminal panel, "npm install（完了）"): exited with code 0.');
    expect(read).toContain('done');
  });

  it('自分の子のターミナルは session_id で読める。子でないセッションのものは読めない', async () => {
    const child = await openShell(CHILD);
    shells.write(child, 'echo from-child\r');
    await waitForText(child, 'from-child');
    const listed = JSON.parse(textOf(await control.handle(ME, 'list_terminals', { session_id: CHILD.slice(0, 8) }))) as { terminals: { id: string }[] };
    expect(listed.terminals.map((t) => t.id)).toEqual([child]);
    expect(textOf(await control.handle(ME, 'read_terminal', { id: child, session_id: CHILD }))).toContain('from-child');
    // 子のターミナルを、session_id を付けずに（自分のものとして）は読めない
    expect(await control.handle(ME, 'read_terminal', { id: child })).toMatchObject({ isError: true });
    expect(textOf(await control.handle(ME, 'list_terminals', { session_id: OTHER }))).toContain('is not a child session of this session');
    expect(textOf(await control.handle(ME, 'list_terminals', { session_id: '1111' }))).toContain('at least its first 8 characters');
    // 子は、親のものを読めない
    expect(textOf(await control.handle(CHILD, 'list_terminals', { session_id: ME }))).toContain('is not a child session of this session');
  });

  it('read_terminal: 最後の行を地の文で返す。行数は 1〜2000 にそろえ、既定は 100 行', async () => {
    const id = await openShell();
    shells.write(id, "i=1; while [ $i -le 150 ]; do printf '\\033[32mline %s\\033[0m\\n' $i; i=$((i+1)); done\r");
    // 最後の行の次のプロンプトまで
    await waitForText(id, 'line 150\n$');
    const one = textOf(await control.handle(ME, 'read_terminal', { id, lines: 2 }));
    expect(one).toContain('Last 2 lines:');
    expect(one).toContain('line 150\n$');
    expect(one).not.toContain('\x1b');
    expect(textOf(await control.handle(ME, 'read_terminal', { id, lines: 0 }))).toContain('Last 1 lines:');
    const all = textOf(await control.handle(ME, 'read_terminal', { id }));
    expect(all).toContain('Last 100 lines:');
    expect(all).toContain('line 52\n');
    expect(all).not.toContain('line 51\n');
    // 2000 行より多くは読まない（控えにあるのは、まだ 151 行）
    expect(textOf(await control.handle(ME, 'read_terminal', { id, lines: 99999 }))).toContain('line 1\n');
  });

  it('read_terminal: 3 万文字を超えたら、後ろを残して切る', async () => {
    const id = await openShell();
    shells.write(id, "i=1; while [ $i -le 400 ]; do printf 'row %04d %0100d\\n' $i 0; i=$((i+1)); done\r");
    await waitForText(id, 'row 0400');
    await sleep(100);
    const text = textOf(await control.handle(ME, 'read_terminal', { id, lines: 2000 }));
    expect(text).toContain('(cut to the last 30000 characters)');
    expect(text).toContain('row 0400');
    expect(text).not.toContain('row 0001 ');
    expect(text.length).toBeLessThan(31_000);
  });

  it('知らない id・メニューでオフ・tanacode に無いセッションは断る', async () => {
    expect(textOf(await control.handle(ME, 'read_terminal', { id: 'shell-999' }))).toContain('No terminal shell-999');
    expect(textOf(await control.handle('44444444-0000-4000-8000-000000000004', 'list_terminals', {}))).toBe('This session is not in tanacode.');
    enabled = false;
    expect(textOf(await control.handle(ME, 'list_terminals', {}))).toBe('The user has turned off "ターミナル" under tanacode > MCP.');
  });
});

describe('打つ', () => {
  it('フックの問い合わせで、タブの名前と打つものを返して印を控える。呼び出しはその印を使って打ち、出た行と打つ前の行を返す', async () => {
    const id = await openShell();
    // 人が打ちかけた行
    shells.write(id, 'echo ');
    await waitForText(id, '$ echo');
    const answer = readGateAnswer(await gate({ id, text: 'hello-from-claude' }));
    expect(answer).toEqual({ tab: 'sh 1', typed: 'hello-from-claude ⏎' });
    const result = textOf(await type({ id, text: 'hello-from-claude' }));
    expect(result).toContain(`Typed "hello-from-claude" and Enter into terminal ${id} (tab 1, "sh 1").`);
    expect(result).toContain('Line the cursor was on before typing: "$ echo"');
    expect(result).toContain('$ echo hello-from-claude\nhello-from-claude\n$');
  });

  it('印が無い呼び出し（フックが動かなかった）は、何も打たずに断る', async () => {
    const id = await openShell();
    const result = await type({ id, text: 'echo should-not-run' });
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain("the user's confirmation for this input was not found");
    await sleep(300);
    await shells.flush(id);
    expect((shells.tail(id, 50) ?? []).join('\n')).not.toContain('should-not-run');
  });

  it('印は 1 回だけ使え、確かめた入力と同じものにしか使えない。15 分で失効する', async () => {
    const id = await openShell();
    await gate({ id, text: 'echo once' });
    // 違う入力（Enter の有無も）には使えない
    expect(await type({ id, text: 'echo other' })).toMatchObject({ isError: true });
    expect(await type({ id, text: 'echo once', enter: false })).toMatchObject({ isError: true });
    expect(await type({ id, text: 'echo once' })).not.toMatchObject({ isError: true });
    expect(await type({ id, text: 'echo once' })).toMatchObject({ isError: true });
    // 同じ入力を 2 回確かめたら、2 回打てる
    await gate({ id, text: 'echo twice' });
    await gate({ id, text: 'echo twice' });
    expect(await type({ id, text: 'echo twice' })).not.toMatchObject({ isError: true });
    expect(await type({ id, text: 'echo twice' })).not.toMatchObject({ isError: true });
    await gate({ id, text: 'echo late' });
    offset += 15 * 60_000 + 1;
    expect(await type({ id, text: 'echo late' })).toMatchObject({ isError: true });
  });

  it('改行は、確認でも呼び出しでも断る。制御文字は取り除き、確認に出したものを打つ', async () => {
    const id = await openShell();
    expect(textOf(await gate({ id, text: 'echo a\necho b' }))).toContain('text must be one line');
    expect(textOf(await type({ id, text: 'echo a\recho b' }))).toContain('text must be one line');
    const answer = readGateAnswer(await gate({ id, text: 'echo \x1b[31mred\x07\tdone' }));
    expect(answer?.typed).toBe('echo [31mreddone ⏎');
    const result = textOf(await type({ id, text: 'echo \x1b[31mred\x07\tdone' }));
    expect(result).toContain('Typed "echo [31mreddone" and Enter');
    expect(result).toContain('[31mreddone');
  });

  it('指定の足りない・重なる入力は断る', async () => {
    const id = await openShell();
    expect(textOf(await gate({ text: 'ls' }))).toContain('Pass id');
    expect(textOf(await gate({ id, new_tab: true, text: 'ls' }))).toContain('not both');
    expect(textOf(await gate({ id, text: 'ls', key: 'ctrl-c' }))).toContain('Pass text or key, not both.');
    expect(textOf(await gate({ id }))).toContain('Pass text to type, or key.');
    expect(textOf(await gate({ id, key: 'f1' }))).toContain('key must be one of');
    expect(textOf(await gate({ id, text: '', enter: false }))).toBe('Nothing to type.');
    expect(textOf(await gate({ id: 'shell-999', text: 'ls' }))).toContain('No terminal shell-999');
  });

  it('子セッションからは打てない（確認も、呼び出しも）', async () => {
    const id = await openShell(CHILD);
    expect(textOf(await gate({ id, text: 'ls' }, CHILD))).toBe("Child sessions cannot type into the user's terminal.");
    expect(textOf(await type({ id, text: 'ls' }, CHILD))).toBe("Child sessions cannot type into the user's terminal.");
    // 親も、子のターミナルには打てない（自分のパネルのものだけ）
    expect(textOf(await gate({ id, text: 'ls' }))).toContain(`No terminal ${id}`);
  });

  it('key: 動いているコマンドを Ctrl+C で止める', async () => {
    const id = await openShell();
    await gate({ id, text: 'sleep 30' });
    await type({ id, text: 'sleep 30' });
    expect(shells.info(id)?.foreground).toBe('sleep');
    expect(readGateAnswer(await gate({ id, key: 'ctrl-c' }))).toEqual({ tab: 'sh 1', typed: 'Ctrl+C' });
    expect(textOf(await type({ id, key: 'ctrl-c' }))).toContain('Typed the key ctrl-c');
    await sleep(300);
    expect(shells.info(id)?.foreground).not.toBe('sleep');
  });

  it('new_tab: このセッションのパネルに新しいシェルのタブを開いて打つ（画面には、ふつうのシェルとして知らせる）', async () => {
    expect(readGateAnswer(await gate({ new_tab: true, text: 'echo in-new-tab' }))).toEqual({ tab: '新しいターミナル', typed: 'echo in-new-tab ⏎' });
    const result = textOf(await type({ new_tab: true, text: 'echo in-new-tab' }));
    expect(opened).toEqual([{ owner: ME, id: expect.stringMatching(/^shell-/), task: false }]);
    expect(result).toContain(', a new shell tab.');
    expect(result).toContain('in-new-tab');
    expect(shells.list(ME).map((t) => t.id)).toEqual([opened[0].id]);
  });

  it('終わったコマンドのタブには打てない。画面に出していないコマンドにも打てない（人に見えない）', async () => {
    await shells.run(ME, dir, 'exit 2', 'npm install');
    const [task] = shells.list(ME);
    expect(textOf(await gate({ id: task.id, text: 'ls' }))).toContain('has exited with code 2');
    void shells.run(ME, dir, 'sleep 30', 'pnpm install');
    const quiet = shells.list(ME).find((t) => t.name === 'pnpm install')!;
    expect(quiet).toMatchObject({ tab: null, running: true });
    expect(textOf(await gate({ id: quiet.id, text: 'y' }))).toContain('runs without showing it in the terminal panel; it cannot take input.');
  });

  it('メニューでオフにしていると、確認の問い合わせも断る（フックは確認を出させる）', async () => {
    const id = await openShell();
    enabled = false;
    expect(await gate({ id, text: 'ls' })).toMatchObject({ isError: true });
  });
});

// ターミナルの作り物で、細かい分かれ目（キーの送り方・読めない指定・何も出ていない・終わったターミナル）を確かめる
describe('細かいところ（ターミナルの作り物）', () => {
  type Fake = TerminalInfo & { lines: string[] };
  const info = (over: Partial<Fake>): Fake => ({
    id: 't1',
    owner: ME,
    tab: 1,
    kind: 'shell',
    name: 'zsh',
    title: null,
    command: null,
    cwd: '/work',
    running: true,
    exitCode: null,
    foreground: null,
    openedAt: 0,
    lastOutputAt: null,
    lines: [],
    ...over,
  });
  let all: Fake[];
  let written: { id: string; data: string }[];
  let appCursor: boolean;
  let printed: string[] | null;
  let fakeControl: TerminalControl;
  beforeEach(() => {
    all = [info({})];
    written = [];
    appCursor = false;
    printed = null;
    const terminals = {
      list: (owner: string) => all.filter((t) => t.owner === owner),
      info: (id: string) => all.find((t) => t.id === id) ?? null,
      flush: () => Promise.resolve(),
      tail: (id: string) => all.find((t) => t.id === id)?.lines ?? null,
      cursorLine: () => null,
      markCursor: () => (printed === null ? null : () => printed!),
      applicationCursor: () => appCursor,
      write: (id: string, data: string) => void written.push({ id, data }),
      openShell: () => ({ id: 't1' }),
    } as unknown as TerminalsApi;
    fakeControl = new TerminalControl({ terminals, sessions, enabled: () => true, quietMs: 1, maxWaitMs: 5 });
  });
  const typeKey = async (key: string) => {
    await fakeControl.handle(ME, TERMINAL_GATE_REQUEST, { id: 't1', key });
    return fakeControl.handle(ME, 'type_in_terminal', { id: 't1', key });
  };

  it('キー: Ctrl+D・Esc・Tab と、矢印（前面のプログラムのモードに合わせる）を、決まった文字にして送る', async () => {
    for (const key of ['ctrl-d', 'escape', 'tab', 'up', 'down']) await typeKey(key);
    appCursor = true;
    for (const key of ['up', 'down']) await typeKey(key);
    expect(written.map((w) => w.data)).toEqual(['\x04', '\x1b', '\t', '\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB']);
    const result = textOf(await typeKey('tab'));
    expect(result).toContain('Typed the key tab into terminal t1');
    // 出力を控えられないときも、何も出なかったことにする
    expect(result).toContain('(nothing)');
  });

  it('打ったあとに閉じたターミナル・多すぎる出力は、そう書く', async () => {
    printed = Array.from({ length: 60 }, (_, i) => `行 ${i}`);
    await fakeControl.handle(ME, TERMINAL_GATE_REQUEST, { id: 't1', text: 'ls' });
    const promise = fakeControl.handle(ME, 'type_in_terminal', { id: 't1', text: 'ls' });
    all = [];
    const result = textOf(await promise);
    expect(result).toContain('the last 50 lines');
    expect(result).toContain('The terminal has closed.');
  });

  it('読む: 何も出ていない・終わった・前面のプログラムがあるターミナル。一覧が空なら、そう書く', async () => {
    expect(textOf(await fakeControl.handle(ME, 'read_terminal', { id: 't1' }))).toContain('The terminal shows nothing yet.');
    all = [info({ running: false, exitCode: 3, lines: ['a'], lastOutputAt: 1000 }), info({ id: 't2', tab: 2, foreground: 'vim', lines: ['b'] })];
    expect(textOf(await fakeControl.handle(ME, 'read_terminal', { id: 't1', lines: 'たくさん' }))).toContain('exited with code 3');
    expect(textOf(await fakeControl.handle(ME, 'read_terminal', { id: 't2' }))).toContain('running (foreground: vim)');
    const listed = JSON.parse(textOf(await fakeControl.handle(ME, 'list_terminals', {}))) as { terminals: { last_output_at: string | null }[] };
    expect(listed.terminals.map((t) => t.last_output_at)).toEqual([new Date(1000).toISOString(), null]);
    all = [];
    expect(textOf(await fakeControl.handle(ME, 'list_terminals', {}))).toContain('No terminal is open');
    // 終わったターミナルの終了コードが分からなければ、コードを書かない
    all = [info({ running: false, exitCode: null })];
    expect(textOf(await fakeControl.handle(ME, TERMINAL_GATE_REQUEST, { id: 't1', text: 'ls' }))).toContain('Terminal t1 has exited; it cannot take input.');
  });

  it('読めない指定: 数でない session_id・重なる子の ID・id の無い読み取り・知らないツール', async () => {
    expect(textOf(await fakeControl.handle(ME, 'list_terminals', { session_id: 42 }))).toContain('at least its first 8 characters');
    expect(textOf(await fakeControl.handle(ME, 'read_terminal', {}))).toContain('Pass the ID of a terminal');
    expect(textOf(await fakeControl.handle(ME, 'no_such_tool', {}))).toContain('Unknown tool');
    // 呼び出し元の ID のはじめを渡したら、自分のもの
    expect((JSON.parse(textOf(await fakeControl.handle(ME, 'list_terminals', { session_id: ME.slice(0, 8) }))) as { session_id: string }).session_id).toBe(ME);
    const ambiguous = new TerminalControl({
      terminals: {} as TerminalsApi,
      sessions: { ...sessions, exists: () => true, childrenOf: () => ['44444444-aaaa', '44444444-bbbb'] },
      enabled: () => true,
    });
    expect(textOf(await ambiguous.handle(ME, 'list_terminals', { session_id: '44444444' }))).toContain('More than one child session');
  });
});
