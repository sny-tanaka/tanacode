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
const opened: { owner: string; id: string; name: string }[] = [];
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
    onOpened: (owner, id, name) => opened.push({ owner, id, name }),
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
    expect(opened).toEqual([{ owner: 'session-1', id: expect.stringMatching(/^task-/), name: 'npm install' }]);
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

  it('知らない id への操作は何もしない（閉じたあとに届いた入力など）', () => {
    expect(() => {
      shells.write('shell-999', 'x');
      shells.resize('shell-999', 80, 24);
      shells.kill('shell-999');
    }).not.toThrow();
  });
});
