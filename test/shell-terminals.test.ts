import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShellTerminals } from '../src/main/shell-terminals';

// ユーザーが使うターミナル（右下のパネル）と、アプリがコマンドを動かすターミナルのタブ（worktree の npm install など）。
// 本物のシェル（/bin/sh）を node-pty で起動する

let dir: string;
let shells: ShellTerminals;
const data = new Map<string, string>();
const exits = new Map<string, number>();
const opened: { owner: string; id: string; name: string; task: boolean }[] = [];
const oldShell = process.env.SHELL;
const oldClaudeCode = process.env.CLAUDECODE;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-shell-')));
  process.env.SHELL = '/bin/sh';
  data.clear();
  exits.clear();
  opened.length = 0;
  shells = new ShellTerminals({
    onData: (id, chunk) => data.set(id, (data.get(id) ?? '') + chunk),
    onExit: (id, code) => exits.set(id, code),
    onOpened: (owner, id, name, task) => opened.push({ owner, id, name, task }),
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
    shells.write(id, "PS1='$ '; printf '\\033[31mred\\033[0m\\n'\r");
    await waitFor('色の付いた出力', () => (data.get(id) ?? '').includes('red'));
    await sleep(200);
    await shells.flush(id);
    expect(shells.tail(id, 5)).toContain('red');
    // 人が打ちかけた行
    shells.write(id, 'echo half');
    await waitFor('打ちかけ', () => (data.get(id) ?? '').includes('echo half'));
    await shells.flush(id);
    expect(shells.cursorLine(id)).toBe('$ echo half');
    const since = shells.markCursor(id)!;
    shells.write(id, ' 0123456789012345678901234567890\r');
    await waitFor('長い出力', () => (data.get(id) ?? '').includes('half 0123456789012345678901234567890\r\n'));
    await sleep(200);
    await shells.flush(id);
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

  it('知らない id への操作は何もしない（閉じたあとに届いた入力など）', () => {
    expect(() => {
      shells.write('shell-999', 'x');
      shells.resize('shell-999', 80, 24);
      shells.kill('shell-999');
    }).not.toThrow();
    expect(shells.tail('shell-999', 1)).toBeNull();
    expect(shells.cursorLine('shell-999')).toBeNull();
    expect(shells.markCursor('shell-999')).toBeNull();
  });
});
