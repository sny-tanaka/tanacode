import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASK_FILE_ENV } from '@shared/chat';
import { childEnv, ClaudeSession, transcriptPath } from '../src/main/claude-session';
import type { HostedPtyInfo } from '../src/main/pty-host-protocol';
import { STATUS_FILE_ENV } from '../src/main/statusline';
import { ScriptedHost } from './helpers/scripted-claude';

// claude の起動・引き継ぎ・止め方と、会話ログの追いかけ（ClaudeSession）。pty ホストは偽物（ScriptedHost）

let root: string;
let host: ScriptedHost;
const oldHome = process.env.HOME;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-claude-session-')));
  // 会話ログの場所（~/.claude/projects）は HOME から決まる
  process.env.HOME = join(root, 'home');
  host = new ScriptedHost();
});
afterEach(() => {
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, check: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`${label}: 時間切れ`);
    await sleep(20);
  }
}

const CLAUDE_ID = '11111111-0000-4000-8000-000000000001';

// 起動の指定（必要なところだけ変える）と、受け取ったもの
function session(patch: Partial<ConstructorParameters<typeof ClaudeSession>[1]> = {}, adopted: HostedPtyInfo | null = null) {
  const got = { data: [] as string[], exits: [] as number[], entries: [] as unknown[], history: 0, switches: [] as string[] };
  const claude = new ClaudeSession(
    host,
    {
      sessionId: 's1',
      cwd: join(root, 'work'),
      claudeSessionId: CLAUDE_ID,
      resume: false,
      remoteControlName: null,
      model: null,
      effort: null,
      permissionMode: null,
      settings: null,
      statusFile: '/status/s1.json',
      askFile: '/status/s1.ask.json',
      browser: null,
      cols: 120,
      rows: 40,
      ...patch,
    },
    {
      onData: (data) => got.data.push(data),
      onExit: (code) => got.exits.push(code),
      onEntry: (entry) => got.entries.push(entry),
      onHistoryLoaded: () => got.history++,
      onSwitch: (id) => got.switches.push(id),
    },
    adopted,
  );
  return { claude, got };
}

describe('起動', () => {
  it('セッションのフォルダで、アプリの statusLine と質問のファイルを環境変数で渡して起動する。Claude Code 上から起動したときの印は消す', () => {
    const before = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    try {
      const { claude } = session();
      claude.start();
      const pty = host.spawned[0];
      expect(pty.request).toMatchObject({ tag: 's1', file: 'claude', cwd: join(root, 'work'), cols: 120, rows: 40 });
      expect(pty.arg('--session-id')).toBe(CLAUDE_ID);
      expect(pty.request.env).toMatchObject({ [STATUS_FILE_ENV]: '/status/s1.json', [ASK_FILE_ENV]: '/status/s1.ask.json', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
      expect(pty.request.env.CLAUDECODE).toBeUndefined();
      expect(pty.request.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(pty.request.env.TANACODE_BROWSER_SOCKET).toBeUndefined();
      expect(childEnv().CLAUDECODE).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('新しい worktree の会話は、元のフォルダで claude --worktree <名前> を起動する。再開は worktree のフォルダで --resume', () => {
    const worktree = { worktree: 'tc-1007-abcd', worktreeRoot: join(root, 'repo'), cwd: join(root, 'repo', '.claude', 'worktrees', 'tc-1007-abcd') };
    session(worktree).claude.start();
    expect(host.spawned[0].request.cwd).toBe(join(root, 'repo'));
    expect(host.spawned[0].arg('--worktree')).toBe('tc-1007-abcd');
    session({ ...worktree, resume: true }).claude.start();
    expect(host.spawned[1].request.cwd).toBe(worktree.cwd);
    expect(host.spawned[1].arg('--resume')).toBe(CLAUDE_ID);
    expect(host.spawned[1].request.args).not.toContain('--worktree');
  });

  it('アプリ内ブラウザを足すときは、JavaScript の実行の確認のフックが使う環境変数も渡す', () => {
    const browser = { command: 'node', script: '/x/browser-mcp.js', socketPath: '/u/browser.sock', version: '1' };
    session({ browser }).claude.start();
    expect(host.spawned[0].request.env).toMatchObject({ TANACODE_BROWSER_SOCKET: '/u/browser.sock', TANACODE_BROWSER_SESSION: 's1' });
  });

  it('引き継ぐときは起動せず、今の画面を先に描き直してから、続きの出力を渡す', () => {
    const info: HostedPtyInfo = { id: 'p1', tag: 's1', pid: 1, startedAt: Date.now(), cols: 100, rows: 30, exitCode: null, screen: '画面' };
    const { claude, got } = session({ resume: true }, info);
    claude.start();
    expect(host.spawned).toEqual([]);
    expect(host.attached.map((p) => p.id)).toEqual(['p1']);
    host.attached[0].output('続き');
    expect(got.data).toEqual(['画面', '続き']);
    // 画面が空なら、描き直さない
    const empty = session({ resume: true }, { ...info, id: 'p2', screen: '' });
    empty.claude.start();
    host.attached[1].output('続き');
    expect(empty.got.data).toEqual(['続き']);
  });
});

describe('操作と終わり方', () => {
  it('打った文字と大きさの変更を pty に送り、出力と終了を受け取る。終わったあとは何も送らない', () => {
    const { claude, got } = session();
    claude.start();
    const pty = host.spawned[0];
    claude.write('abc');
    claude.resize(80, 24);
    pty.output('出力');
    expect(pty.writes).toEqual(['abc']);
    expect(pty.resizes).toEqual([[80, 24]]);
    expect(got.data).toEqual(['出力']);
    pty.exit(3);
    expect(got.exits).toEqual([3]);
    claude.write('def');
    claude.resize(100, 30);
    expect(pty.writes).toEqual(['abc']);
    expect(pty.resizes).toEqual([[80, 24]]);
  });

  it('kill: claude を止め、そのあとの出力と終了は受け取らない', () => {
    const { claude, got } = session();
    claude.start();
    const pty = host.spawned[0];
    claude.kill();
    expect(pty.killed).toBe(true);
    pty.output('遅れた出力');
    pty.exit(0);
    expect(got.data).toEqual([]);
    expect(got.exits).toEqual([]);
  });

  it('stop: 止めて、終わるのを待つ。終わらなければ、待つ上限で諦める。動いていなければすぐ返す', async () => {
    const { claude } = session();
    claude.start();
    const pty = host.spawned[0];
    let stopped = false;
    const stopping = claude.stop(5000).then(() => (stopped = true));
    expect(pty.killed).toBe(true);
    await sleep(50);
    expect(stopped).toBe(false);
    pty.exit(0);
    await stopping;

    const stuck = session();
    stuck.claude.start();
    const startedAt = Date.now();
    await stuck.claude.stop(100);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(host.spawned[1].killed).toBe(true);

    await claude.stop();
  });

  it('detach: claude を止めずに見るのをやめる（次のアプリが引き継ぐ）', () => {
    const { claude, got } = session();
    claude.start();
    const pty = host.spawned[0];
    claude.detach();
    expect(pty.detached).toBe(true);
    expect(pty.killed).toBe(false);
    claude.write('x');
    pty.exit(0);
    expect(pty.writes).toEqual([]);
    expect(got.exits).toEqual([]);
    // 動いていなければ何もしない
    claude.detach();
    claude.kill();
  });
});

describe('会話ログ', () => {
  const file = (claudeId: string) => transcriptPath(join(root, 'work'), claudeId);
  const line = (text: string) => JSON.stringify({ type: 'user', uuid: text, message: { role: 'user', content: text } });

  it('再開したときは、今ある行を読み直してから読み終わりを知らせ、そのあとの行も届ける', async () => {
    mkdirSync(dirname(file(CLAUDE_ID)), { recursive: true });
    writeFileSync(file(CLAUDE_ID), `${line('前の発言')}\n`);
    const { claude, got } = session({ resume: true });
    claude.start();
    await waitFor('読み終わり', () => got.history === 1);
    expect(got.entries).toMatchObject([{ uuid: '前の発言' }]);
    claude.kill();
  });

  it('followTranscript: statusLine が教えた、起動のあとにできた会話ログ（/clear）に乗り換える', async () => {
    const { claude, got } = session();
    claude.start();
    // ファイルの作成時刻は粗い時計（数 ms 遅れる）で付くので、起動の直後に作ると、起動より前にできたように見える。
    // 本物の /clear は起動のずっとあと
    await sleep(50);
    const next = '22222222-0000-4000-8000-000000000002';
    mkdirSync(dirname(file(next)), { recursive: true });
    writeFileSync(file(next), `${line('新しい会話')}\n`);
    claude.followTranscript(file(next));
    await waitFor('乗り換え', () => got.switches.length === 1);
    expect(got.switches).toEqual([next]);
    await waitFor('新しい会話の行', () => got.entries.length === 1);
    expect(got.entries).toMatchObject([{ uuid: '新しい会話' }]);
    claude.kill();
    // 止めたあとは乗り換えない
    claude.followTranscript(file('33333333-0000-4000-8000-000000000003'));
  });
});
