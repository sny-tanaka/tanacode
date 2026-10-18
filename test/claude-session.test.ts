import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASK_FILE_ENV } from '@shared/chat';
import { TERMINAL_GATED_TOOL } from '../src/main/terminal-bridge';
import { childEnv, claudeArgs, claudeEnv, ClaudeSession, transcriptPath } from '../src/main/claude-session';
import type { HostedPipeInfo, HostedPtyInfo } from '../src/main/pty-host-protocol';
import { RETAIN_RULES, STREAM_ARGS, TRANSIENT_KINDS } from '../src/main/stream/protocol';
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
      kind: 'tui',
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
    } as ConstructorParameters<typeof ClaudeSession>[1],
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

describe('子に渡す環境変数', () => {
  it('親の Claude Code がセッションのために付けた変数と、親の tanacode のつなぎ先（TANACODE_*）・チャットの Claude Code に付けた変数は渡さない。ユーザーの設定は残す', () => {
    const names = [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_BRIDGE_SESSION_ID',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_SESSION_ATTENDED',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'AI_AGENT',
      'TANACODE_BROWSER_SOCKET',
      'TANACODE_STATUS_FILE',
      'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
      'CLAUDE_CODE_CLASSIFIER_SUMMARY',
      'CLAUDE_CODE_USE_BEDROCK',
      'ANTHROPIC_MODEL',
    ];
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = 'from-parent';
    try {
      const env = childEnv();
      expect(names.filter((name) => env[name] !== undefined)).toEqual(['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_MODEL']);
      // stream-json の claude にも
      expect(claudeEnv('stream').CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
      // チャットの Claude Code に付ける変数は、この tanacode が起動の種類ごとに付け直す（親の tanacode のチャットの中で起動しても、TUI には付かない）
      expect(claudeEnv('stream')).toMatchObject({ CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1', CLAUDE_CODE_CLASSIFIER_SUMMARY: '0' });
      expect(claudeEnv('tui').CLAUDE_CODE_CLASSIFIER_SUMMARY).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

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

  it('チェックリストを足すときは、チェックリストを使い続けさせるフックが使う環境変数を渡し、設定にフックを入れる', () => {
    const checklist = { command: 'node', script: '/x/checklist-mcp.js', socketPath: '/u/checklist.sock', version: '1' };
    session({ checklist }).claude.start();
    const { env, args } = host.spawned[0].request;
    expect(env).toMatchObject({ TANACODE_CHECKLIST_SOCKET: '/u/checklist.sock', TANACODE_CHECKLIST_SESSION: 's1', TANACODE_CHECKLIST_COMMAND: 'node', TANACODE_CHECKLIST_SCRIPT: '/x/checklist-mcp.js' });
    expect(Object.keys(JSON.parse(args[args.indexOf('--settings') + 1]).hooks)).toEqual([
      'PreToolUse',
      'PermissionRequest',
      'Notification',
      'UserPromptSubmit',
      'Stop',
      'SessionStart',
      'PreCompact',
      'PostToolUse',
    ]);
    session().claude.start();
    expect(host.spawned[1].request.env.TANACODE_CHECKLIST_SOCKET).toBeUndefined();
    expect(Object.keys(JSON.parse(host.spawned[1].arg('--settings')!).hooks)).toEqual(['PreToolUse', 'PermissionRequest', 'Notification', 'Stop']);
  });

  it('人のターミナルを足すときは、打つ前の確認のフックが使う環境変数を渡し、設定にフックを入れる。子セッションには、どちらも渡さない', () => {
    const terminal = { command: 'node', script: '/x/terminal-mcp.js', socketPath: '/u/terminal.sock', version: '1' };
    const gateHooks = (args: string[]) =>
      (JSON.parse(args[args.indexOf('--settings') + 1]) as { hooks: { PreToolUse: { matcher: string }[] } }).hooks.PreToolUse.filter((h) => h.matcher === TERMINAL_GATED_TOOL);
    session({ terminal }).claude.start();
    const parent = host.spawned[0].request;
    expect(parent.env).toMatchObject({ TANACODE_TERMINAL_SOCKET: '/u/terminal.sock', TANACODE_TERMINAL_SESSION: 's1', TANACODE_TERMINAL_COMMAND: 'node', TANACODE_TERMINAL_SCRIPT: '/x/terminal-mcp.js' });
    expect(gateHooks(parent.args)).toHaveLength(1);
    session({ terminal: { ...terminal, child: true } }).claude.start();
    const child = host.spawned[1].request;
    expect(child.env.TANACODE_TERMINAL_SOCKET).toBeUndefined();
    expect(gateHooks(child.args)).toEqual([]);
    expect(child.args[child.args.indexOf('--mcp-config') + 1]).toContain('"TANACODE_TERMINAL_CHILD":"1"');
  });

  it('引き継ぐときは起動せず、今の画面を先に描き直してから、続きの出力を渡す', () => {
    const info: HostedPtyInfo = { kind: 'pty', id: 'p1', tag: 's1', pid: 1, startedAt: Date.now(), cols: 100, rows: 30, exitCode: null, screen: '画面' };
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

  it('kill: claude を止める。そのあとの出力は表示に流さないが、終わりは知らせる（待っている要求の後始末のため）。stop は終わるまで待つ', async () => {
    const { claude, got } = session();
    claude.start();
    const pty = host.spawned[0];
    claude.kill();
    expect(pty.killed).toBe(true);
    pty.output('遅れた出力');
    let stopped: boolean | null = null;
    const stopping = claude.stop(5000).then((ok) => (stopped = ok));
    await sleep(50);
    // まだ終わっていないので、stop は待っている（kill で終わったことにしない）
    expect(stopped).toBeNull();
    pty.exit(0);
    expect(await stopping).toBe(true);
    expect(got.data).toEqual([]);
    expect(got.exits).toEqual([0]);
  });

  it('stop: 止めて、終わるのを待つ（終わったら true）。終わらなければ、SIGTERM・SIGKILL と強めていき、それでも終わらなければ false。動いていなければすぐ返す', async () => {
    const { claude, got } = session();
    claude.start();
    const pty = host.spawned[0];
    let stopped: boolean | null = null;
    const stopping = claude.stop(5000).then((ok) => (stopped = ok));
    expect(pty.kills).toEqual([undefined]);
    await sleep(50);
    expect(stopped).toBeNull();
    pty.exit(0);
    await stopping;
    expect(stopped).toBe(true);
    // 止めて終わったときも、終わりを知らせる
    expect(got.exits).toEqual([0]);

    const stuck = session();
    stuck.claude.start();
    const startedAt = Date.now();
    expect(await stuck.claude.stop(30)).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
    expect(host.spawned[1].kills).toEqual([undefined, 'SIGTERM', 'SIGKILL']);

    // SIGTERM で終わる
    const late = session();
    late.claude.start();
    host.spawned[2].onWrite = null;
    const lateStop = late.claude.stop(30);
    await waitFor('SIGTERM', () => host.spawned[2].kills.length === 2);
    host.spawned[2].exit(143);
    expect(await lateStop).toBe(true);

    expect(await claude.stop()).toBe(true);
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

describe('stream-json（チャット）', () => {
  const stream = (patch: Partial<ConstructorParameters<typeof ClaudeSession>[1]> = {}, adopted: HostedPipeInfo | null = null) => {
    const got = { messages: [] as [string, boolean][], permissions: [] as string[], cancels: [] as string[], exits: [] as [number, string | undefined][] };
    const claude = new ClaudeSession(
      host,
      {
        sessionId: 's1',
        kind: 'stream',
        cwd: join(root, 'work'),
        claudeSessionId: CLAUDE_ID,
        resume: false,
        remoteControlName: 'tanacode-work',
        model: 'opus',
        effort: 'high',
        permissionMode: 'auto',
        settings: null,
        statusFile: '/status/s1.json',
        askFile: '/status/s1.ask.json',
        browser: null,
        cols: 120,
        rows: 40,
        ...patch,
      } as ConstructorParameters<typeof ClaudeSession>[1],
      {
        onData: () => {},
        stream: {
          onMessage: (message, past) => got.messages.push([message.type, past]),
          onPermission: (id) => got.permissions.push(id),
          onCancel: (id) => got.cancels.push(id),
        },
        onExit: (code, stderr) => got.exits.push([code, stderr]),
        onEntry: () => {},
        onHistoryLoaded: () => {},
        onSwitch: () => {},
      },
      adopted,
    );
    return { claude, got };
  };

  it('パイプで claude -p を stream-json で起動する。--remote-control は付けず、モード・モデル・エフォートは渡す。端末の変数は渡さず、ファイルの控えを有効にし、Remote Control の要約をモデルで作らせない', () => {
    const { claude } = stream();
    claude.start();
    expect(host.spawned).toEqual([]);
    const pipe = host.pipes[0];
    expect(claude.kind).toBe('stream');
    expect(pipe.request).toMatchObject({ tag: 's1', file: 'claude', cwd: join(root, 'work'), retain: RETAIN_RULES, transient: TRANSIENT_KINDS });
    expect(pipe.request.args.slice(0, STREAM_ARGS.length)).toEqual([...STREAM_ARGS]);
    expect(pipe.request.args).not.toContain('--remote-control');
    expect(pipe.arg('--session-id')).toBe(CLAUDE_ID);
    expect(pipe.arg('--permission-mode')).toBe('auto');
    expect(pipe.arg('--model')).toBe('opus');
    expect(pipe.arg('--effort')).toBe('high');
    expect(pipe.request.env.TERM).toBeUndefined();
    expect(pipe.request.env.COLORTERM).toBeUndefined();
    expect(pipe.request.env).toMatchObject({ CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1', CLAUDE_CODE_CLASSIFIER_SUMMARY: '0', [ASK_FILE_ENV]: '/status/s1.ask.json' });
    // TUI は --remote-control を付ける（前のセッションに自動でつながり直す）
    expect(claudeArgs({ claudeSessionId: CLAUDE_ID, resume: true, remoteControlName: 'tanacode-work', model: null, effort: null, permissionMode: 'manual' })).toContain('--remote-control');
    expect(claudeEnv('tui').TERM).toBe('xterm-256color');
    // TUI は要約を裏で作る（ターンの終わりを待たせない）ので、Claude Code のとおりモデルで作らせる
    expect(claudeEnv('tui').CLAUDE_CODE_CLASSIFIER_SUMMARY).toBeUndefined();
  });

  it('出力の行・答えを待つ要求・取り下げ・終わり（標準エラーの末尾つき）を渡す', () => {
    const { claude, got } = stream();
    claude.start();
    const pipe = host.pipes[0];
    pipe.emit({ type: 'system', subtype: 'status', status: null });
    pipe.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 't' } });
    pipe.emit({ type: 'control_cancel_request', request_id: 'r1' });
    expect(claude.client).not.toBeNull();
    pipe.exit(1, 'Error creating worktree');
    expect(got).toEqual({ messages: [['system', false]], permissions: ['r1'], cancels: ['r1'], exits: [[1, 'Error creating worktree']] });
  });

  it('引き継ぐときは起動せず、控えている行を送り直してもらう（前の頃の行は past）', () => {
    const info: HostedPipeInfo = { kind: 'pipe', id: 'q1', tag: 's1', pid: 1, startedAt: Date.now(), exitCode: null, lastSeq: 2, firstSeq: 1, retained: [], pending: [], ended: false, stderr: '' };
    const { claude, got } = stream({ resume: true }, info);
    claude.start();
    expect(host.pipes).toEqual([]);
    const pipe = host.attachedPipes[0];
    expect(pipe.id).toBe('q1');
    expect(pipe.replays).toEqual([1]);
    pipe.emit({ type: 'system', subtype: 'status' }, 2);
    pipe.emit({ type: 'system', subtype: 'status' }, 3);
    expect(got.messages).toEqual([
      ['system', true],
      ['system', false],
    ]);
  });

  it('stop: end_session を送って終わるのを待つ。終わらなければ SIGTERM・SIGKILL（プロセスグループごと）', async () => {
    const { claude, got } = stream();
    claude.start();
    const pipe = host.pipes[0];
    pipe.onSend = (line) => {
      const message = JSON.parse(line) as { type: string; request_id: string; request: { subtype: string } };
      if (message.request?.subtype !== 'end_session') return;
      pipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
      pipe.exit(0);
    };
    expect(await claude.stop(1000)).toBe(true);
    expect(pipe.kills).toEqual([]);
    expect(got.exits).toEqual([[0, '']]);

    // end_session を受け付けなかった（受け口が無い古いバージョン）ら、待たずに SIGTERM
    const unsupported = stream();
    unsupported.claude.start();
    const unsupportedPipe = host.pipes[1];
    unsupportedPipe.onSend = (line) => {
      const message = JSON.parse(line) as { request_id: string };
      unsupportedPipe.emit({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported control request subtype: end_session' } });
    };
    const quick = unsupported.claude.stop(5000);
    await waitFor('SIGTERM', () => unsupportedPipe.kills.length === 1, 1000);
    expect(unsupportedPipe.kills).toEqual(['SIGTERM']);
    unsupportedPipe.exit(143);
    expect(await quick).toBe(true);

    // end_session を受け付けても終わらなければ、SIGTERM・SIGKILL と強めていく
    const stuck = stream();
    stuck.claude.start();
    const stuckPipe = host.pipes[2];
    stuckPipe.onSend = (line) => {
      const message = JSON.parse(line) as { request_id: string };
      stuckPipe.emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    };
    const stopping = stuck.claude.stop(30);
    await waitFor('SIGKILL', () => stuckPipe.kills.length === 2);
    expect(stuckPipe.kills).toEqual(['SIGTERM', 'SIGKILL']);
    stuckPipe.exit(137);
    expect(await stopping).toBe(true);
  });

  it('kill: すぐ SIGTERM で止める。detach: 止めずに見るのをやめる', () => {
    const { claude } = stream();
    claude.start();
    claude.kill();
    expect(host.pipes[0].kills).toEqual(['SIGTERM']);
    const kept = stream();
    kept.claude.start();
    kept.claude.detach();
    expect(host.pipes[1].detached).toBe(true);
    expect(host.pipes[1].kills).toEqual([]);
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
