import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellTerminals } from '../src/main/shell-terminals';

// ユーザーが使うターミナル（右下のパネル）と、アプリがコマンドを動かすターミナルのタブ（worktree の npm install など）。
// 本物のシェル（/bin/sh）を node-pty で起動する

let dir: string;
let shells: ShellTerminals;
let data: Map<string, string>;
let exits: Map<string, number>;
let opened: { owner: string; id: string; name: string; task: boolean }[];
const oldShell = process.env.SHELL;
const oldClaudeCode = process.env.CLAUDECODE;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-shell-')));
  process.env.SHELL = '/bin/sh';
  // 知らせは、テストごとに別の控えに書く。前のテストで止めたシェルが終わった知らせは、次のテストが始まってから届くことがあり、
  // id（shell-1 など）も同じなので、同じ控えに書くと、次のテストのシェルが終わったように見えてしまう
  const mine = { data: new Map<string, string>(), exits: new Map<string, number>(), opened: [] as typeof opened };
  ({ data, exits, opened } = mine);
  shells = new ShellTerminals({
    onData: (id, chunk) => mine.data.set(id, (mine.data.get(id) ?? '') + chunk),
    onExit: (id, code) => mine.exits.set(id, code),
    onOpened: (owner, id, name, task) => mine.opened.push({ owner, id, name, task }),
  });
});
afterEach(() => {
  shells.killAll();
  process.env.SHELL = oldShell;
  if (oldClaudeCode === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = oldClaudeCode;
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`${label}: 時間切れ`);
    await sleep(25);
  }
}

// 控えの画面に書き終えてから（flush）読んだ行が、check に合うまで待つ
async function waitForLines(label: string, id: string, check: (lines: string[]) => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await shells.flush(id);
    const lines = shells.tail(id, 1000) ?? [];
    if (check(lines)) return;
    if (Date.now() > until) throw new Error(`${label}: 時間切れ（${JSON.stringify(lines)}）`);
    await sleep(25);
  }
}

// プロンプトを決まった形（$ ）にして、シェルが打つものを待つところまで待つ。
// シェルが起動する前に打つと、打った文字は pty がすぐ映し、プロンプトと出力はそのあとに続く。行の編集の無いシェル
// （Linux の /bin/sh の dash）は、それを描き直さないので、プロンプトと出力が同じ行に並ぶ（「$ red」）。macOS の /bin/sh（bash）は、
// プロンプトのあとに描き直す。どちらでも同じ画面で確かめられるよう、起動を待ってから打つ。
// ready-2 はシェルが計算した出力にだけ出る（打った文字の映りは ready-$((1+1))）ので、映りでは待ち終わらない
async function waitForPrompt(id: string): Promise<void> {
  shells.write(id, "PS1='$ '; echo ready-$((1+1))\r");
  await waitForLines('プロンプト', id, (lines) => lines.at(-2)?.endsWith('ready-2') === true && lines.at(-1) === '$');
}

// 打って、シェルが次のプロンプトを出すまで待つ（打った文字の映りや、出力の途中では待ち終わらない）
async function typeAndWait(id: string, data: string): Promise<void> {
  await shells.flush(id);
  const before = (shells.tail(id, 1000) ?? []).length;
  shells.write(id, data);
  await waitForLines('次のプロンプト', id, (lines) => lines.length > before && lines.at(-1) === '$');
}

describe('ShellTerminals', () => {
  it('create: セッションのフォルダでログインシェルを開き、打った文字が届く。Claude Code の子セッションの印は渡さない', async () => {
    // tanacode を Claude Code の中から起動したときの印。シェルから claude を起動したとき、子セッション扱いにならないよう外す
    process.env.CLAUDECODE = '1';
    const { id, name } = shells.create('session-1', dir, 80, 24);
    expect(name).toBe('sh');
    shells.write(id, 'echo "[$(pwd)] [$TERM_PROGRAM] [${CLAUDECODE:-none}]"\r');
    await waitFor('出力', () => (data.get(id) ?? '').includes(`[${dir}] [tanacode] [none]`));
  });

  it('resize: 大きさを変える。0 の大きさは無視する（パネルを畳んだとき）', async () => {
    const { id } = shells.create('session-1', dir, 80, 24);
    shells.resize(id, 0, 0);
    shells.resize(id, 100, 30);
    await sleep(100);
    shells.write(id, 'stty size\r');
    await waitFor('大きさ', () => (data.get(id) ?? '').includes('30 100'));
  });

  it('run: コマンドをタブに出しながら実行し、終了コードを返す', async () => {
    const code = await shells.run('session-1', dir, 'echo installing; exit 7', 'npm install');
    expect(code).toBe(7);
    expect(opened).toEqual([{ owner: 'session-1', id: expect.stringMatching(/^task-/), name: 'npm install', task: true }]);
    const id = opened[0].id;
    expect(data.get(id)).toContain('installing');
    expect(exits.get(id)).toBe(7);
  });

  it('killOwner: 一覧から消したセッションのシェルだけを閉じる', async () => {
    const mine = shells.create('session-1', dir, 80, 24);
    const other = shells.create('session-2', dir, 80, 24);
    shells.killOwner('session-1');
    await waitFor('閉じる', () => exits.has(mine.id));
    await sleep(200);
    expect(exits.has(other.id)).toBe(false);
    shells.write(other.id, 'echo still-here\r');
    await waitFor('残ったシェル', () => (data.get(other.id) ?? '').includes('still-here'));
  });

  it('list: 持ち主のターミナルを開いた順（パネルの並び）に返す。終わったコマンドのタブは、kill まで出力の控えごと残す', async () => {
    const shell = shells.create('session-1', dir, 80, 24);
    await shells.run('session-1', dir, 'echo built; exit 3', 'npm install');
    shells.create('session-2', dir, 80, 24);
    const list = shells.list('session-1');
    expect(list.map((t) => [t.id, t.tab, t.kind, t.name, t.command, t.cwd, t.running, t.exitCode])).toEqual([
      [shell.id, 1, 'shell', 'sh', null, dir, true, null],
      [opened[0].id, 2, 'command', 'npm install', 'echo built; exit 3', dir, false, 3],
    ]);
    expect(list[0].foreground).toBeTruthy();
    expect(list[1].foreground).toBeNull();
    expect(list[1].lastOutputAt).toBeGreaterThan(0);
    await shells.flush(opened[0].id);
    expect(shells.tail(opened[0].id, 10)).toEqual(['built']);
    // 終わったタブを閉じたら（kill）、控えも捨てる
    shells.kill(opened[0].id);
    expect(shells.list('session-1').map((t) => t.id)).toEqual([shell.id]);
    expect(shells.info(opened[0].id)).toBeNull();
  });

  it('終わったコマンドのタブの控えは、持ち主ごとに 20 個まで（古いものから捨てる）', async () => {
    for (let i = 1; i <= 22; i++) await shells.run('session-1', dir, `exit 0`, `task ${i}`);
    expect(shells.list('session-1').map((t) => t.name)).toEqual(Array.from({ length: 20 }, (_, i) => `task ${i + 3}`));
  });

  it('シェルが終わったら控えを捨てる。動いているコマンドを人が止めたときも捨てる', async () => {
    const shell = shells.create('session-1', dir, 80, 24);
    shells.write(shell.id, 'exit\r');
    await waitFor('シェルの終わり', () => exits.has(shell.id));
    expect(shells.info(shell.id)).toBeNull();
    const running = shells.run('session-1', dir, 'sleep 30', 'sleep');
    const task = opened.at(-1)!.id;
    shells.kill(task);
    await running;
    expect(shells.info(task)).toBeNull();
  });

  it('tail・cursorLine・markCursor: 色を除いた地の文で読み、折り返した行はつなぐ。打つ前の行と、そのあとに出た行を分けて読める', async () => {
    const { id } = shells.create('session-1', dir, 20, 10);
    await waitForPrompt(id);
    // 打った文字の映りにも red が入っているので、出力そのものではなく、次のプロンプトが出るのを待つ
    await typeAndWait(id, "printf '\\033[31mred\\033[0m\\n'\r");
    expect(shells.tail(id, 5)).toContain('red');
    // 人が打ちかけた行
    shells.write(id, 'echo half');
    await waitFor('打ちかけ', () => (data.get(id) ?? '').includes('echo half'));
    await shells.flush(id);
    expect(shells.cursorLine(id)).toBe('$ echo half');
    const since = shells.markCursor(id)!;
    await typeAndWait(id, ' 0123456789012345678901234567890\r');
    // 20 桁で折り返した行も 1 行として読む
    expect(since()).toEqual(['$ echo half 0123456789012345678901234567890', 'half 0123456789012345678901234567890', '$']);
  });

  it('openShell: Claude が打つために、新しいシェルを開いて画面に知らせる（コマンドのタブではない）', async () => {
    const { id, name } = shells.openShell('session-1', dir);
    expect(opened).toEqual([{ owner: 'session-1', id, name, task: false }]);
    expect(shells.info(id)).toMatchObject({ kind: 'shell', tab: 1, running: true });
    shells.write(id, 'stty size\r');
    await waitFor('大きさ', () => (data.get(id) ?? '').includes('30 100'));
  });

  it('detach・attach: 画面を読み込み直す間は画面に知らせず、引き継ぐ画面に、開いた順のターミナルと今の画面を渡す。引き継いだら、また知らせる', async () => {
    const shell = shells.create('session-1', dir, 40, 12);
    await waitForPrompt(shell.id);
    await typeAndWait(shell.id, 'echo before-$((1+1))\r');
    await shells.run('session-2', dir, 'echo built; exit 3', 'npm install');
    const npm = opened[0].id;
    shells.detach();
    const forwarded = data.get(shell.id);
    // 読み込み直している間の出力・開いたタブ・終わったタブは、画面に知らせない（控えには書く）
    await typeAndWait(shell.id, 'echo during-$((2+1))\r');
    const yarn = shells.run('session-1', dir, 'echo linked; exit 5', 'yarn');
    await yarn;
    expect(data.get(shell.id)).toBe(forwarded);
    expect(opened).toHaveLength(1);
    expect([...exits.keys()]).toEqual([npm]);

    const list = shells.attach();
    const yarnId = list.find((s) => s.name === 'yarn')?.id;
    expect(list.map((s) => [s.owner, s.id, s.name, s.title, s.task, s.exitCode, s.cols, s.rows])).toEqual([
      ['session-1', shell.id, 'sh', null, false, null, 40, 12],
      ['session-2', npm, 'npm install', null, true, 3, 100, 24],
      ['session-1', yarnId, 'yarn', null, true, 5, 100, 24],
    ]);
    // 渡した画面を xterm に書くと、読み込み直す前と、その間の出力が見える
    const screenOf = async (screen: string, cols: number, rows: number) => {
      const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
      await new Promise<void>((resolve) => term.write(screen, resolve));
      const buffer = term.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '');
      term.dispose();
      return lines.join('\n');
    };
    const shown = await screenOf(list[0].screen, 40, 12);
    expect(shown).toContain('before-2');
    expect(shown).toContain('during-3');
    expect(await screenOf(list[2].screen, 100, 24)).toContain('linked');
    // 引き継いだあとは、また画面に知らせる
    shells.write(shell.id, 'echo after-$((3+1))\r');
    await waitFor('引き継いだあとの出力', () => (data.get(shell.id) ?? '').includes('after-4'));
    shells.kill(shell.id);
    await waitFor('引き継いだあとの終わり', () => exits.has(shell.id));
  });

  it('attach: 止めている途中（kill したが、まだ終わっていない）のシェルは渡さない', async () => {
    const stopping = shells.create('session-1', dir, 80, 24);
    const kept = shells.create('session-1', dir, 80, 24);
    shells.detach();
    shells.kill(stopping.id);
    expect(shells.attach().map((s) => s.id)).toEqual([kept.id]);
    await waitFor('止めたシェルの終わり', () => exits.has(stopping.id));
  });

  it('kill: 止めたシェルは、終わる前でも一覧・情報に出さない（Claude から読めず、打てない）。SIGHUP で終わらないもの（trap）は、しばらくして強く止める', async () => {
    // 強く止めるまでの待ちは、テストが進める
    const later: (() => void)[] = [];
    shells = new ShellTerminals(
      {
        onData: (id, chunk) => data.set(id, (data.get(id) ?? '') + chunk),
        onExit: (id, code) => exits.set(id, code),
      },
      null,
      Date.now,
      (fn) => {
        later.push(fn);
        return () => {};
      },
    );
    const { id } = shells.create('session-1', dir, 80, 24);
    try {
      await waitForPrompt(id);
      // SIGHUP を受けても終わらず、受けたことを出力で知らせるシェルにする。入力を待っている間の dash（CI の /bin/sh）は、
      // trap を次の入力まで後回しにする（止めたシェルには打てない）ので、ループを回させ、コマンドの切れ目で trap を動かす。
      // ループは 200 回（約 20 秒）で終える（テストを流している所が落ちても、SIGHUP を受けないシェルを残さないため）
      shells.write(id, "trap 'echo hup-$((1+1))' HUP; echo loop-$((2+1)); i=0; while [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done; exit\r");
      await waitFor('ループに入った印', () => (data.get(id) ?? '').includes('loop-3'));
      shells.kill(id);
      expect(shells.list('session-1')).toEqual([]);
      expect(shells.info(id)).toBeNull();
      // SIGHUP を受けたあとも動いている（受けたことを出力し、終わっていない）。時間でなく、シェルの出力で確かめる
      await waitFor('SIGHUP を受けた知らせ', () => (data.get(id) ?? '').includes('hup-2'));
      expect(exits.has(id)).toBe(false);
      // 待ちが過ぎたら、強く止める
      expect(later).toHaveLength(1);
      later[0]();
      await waitFor('強く止めたシェルの終わり', () => exits.has(id));
    } finally {
      // 途中で落ちても、ループを回すシェルを残さない（afterEach の killAll は SIGHUP しか送らず、trap が受ける。
      // 強く止める待ちはこのテストが持っているので、ここで流す。待ちは、終わっていなければ SIGKILL を送る）
      shells.kill(id);
      later.forEach((fn) => fn());
    }
  });

  it('kill: SIGHUP で終わったシェルには、あとで強く止める知らせ（SIGKILL）を送らない', async () => {
    const later: (() => void)[] = [];
    shells = new ShellTerminals({ onData: () => {}, onExit: (id, code) => exits.set(id, code) }, null, Date.now, (fn) => {
      later.push(fn);
      return () => {};
    });
    const { id } = shells.create('session-1', dir, 80, 24);
    shells.kill(id);
    await waitFor('止めたシェルの終わり', () => exits.has(id));
    // node-pty は、止める知らせを process.kill で送る
    const kill = vi.spyOn(process, 'kill');
    try {
      later.forEach((fn) => fn());
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it('知らない id への操作は何もしない（閉じたあとに届いた入力など）', () => {
    expect(() => {
      shells.write('shell-999', 'x');
      shells.resize('shell-999', 80, 24);
      shells.kill('shell-999');
    }).not.toThrow();
    expect(shells.tail('shell-999', 1)).toBeNull();
    expect(shells.cursorLine('shell-999')).toBeNull();
    expect(shells.markCursor('shell-999')).toBeNull();
    expect(shells.info('shell-999')).toBeNull();
    expect(shells.applicationCursor('shell-999')).toBe(false);
    return expect(shells.flush('shell-999')).resolves.toBeUndefined();
  });

  it('前面のプログラムが付けた題名と、矢印キーのアプリのモードを読む。空の題名は、無いことにする', async () => {
    const { id } = shells.create('session-1', dir, 80, 24);
    await waitForPrompt(id);
    expect(shells.applicationCursor(id)).toBe(false);
    await typeAndWait(id, "printf '\\033]0;build\\007\\033[?1h'\r");
    expect(shells.info(id)?.title).toBe('build');
    expect(shells.applicationCursor(id)).toBe(true);
    await typeAndWait(id, "printf '\\033]0;\\007\\033[?1l'\r");
    expect(shells.info(id)?.title).toBeNull();
    expect(shells.applicationCursor(id)).toBe(false);
  });

  it('markCursor: シェルが終わって控えを捨てたあとは、何も読めない', async () => {
    const { id } = shells.create('session-1', dir, 80, 24);
    await waitForPrompt(id);
    const since = shells.markCursor(id)!;
    shells.write(id, 'exit\r');
    await waitFor('シェルの終わり', () => exits.has(id));
    expect(since()).toEqual([]);
  });
});
