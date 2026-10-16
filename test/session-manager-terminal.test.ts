import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostedPtyInfo } from '../src/main/pty-host-protocol';
import { DEFAULT_PTY_SIZE } from '../src/main/session-manager';
import { line, ScriptedApp, type ScriptedPty } from './helpers/scripted-claude';

// ターミナルモード（SessionManager。設計書 9 節）。セッションごとに、チャット（stream-json）とターミナルモード（TUI）を行き来する。
// 行き来はどちら向きも、今の claude を止めて終わりを確かめ、もう片方で --resume する。ターミナルモードの間は、チャット・親からの送信を
// 断り、TUI のターンと確認は会話ログと書くだけのフックで知る

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

// いちばん新しい TUI（止めたら終わるようにする）
const tui = (): ScriptedPty => {
  const pty = app.host.spawned.at(-1)!;
  pty.exitOnKill = true;
  return pty;
};

// チャットで動いていて、会話のあるセッション
async function chatting() {
  const { id, pipe } = app.create();
  await app.ready(id);
  await app.prompt(id, 'はじめ');
  app.say(id, line.text('はい'));
  app.finish(id);
  await app.waitFor('ターンの終わり', () => app.manager.stateOf(id) === 'idle');
  return { id, pipe };
}

describe('チャットからターミナルモードへ', () => {
  it('stream-json を止めて終わりを確かめ、TUI を --resume と今の権限モードで起動する。終了はチャットに出さない', async () => {
    const { id, pipe } = await chatting();
    await app.manager.setMode(id, 'acceptEdits');
    await app.manager.setTerminalMode(id, true);
    expect(pipe.requests('end_session')).toHaveLength(1);
    const pty = tui();
    expect(pty.arg('--resume')).toBe(app.claudeId(id));
    expect(pty.arg('--permission-mode')).toBe('acceptEdits');
    expect(pty.request.args).not.toContain('--input-format');
    expect(app.manager.stateOf(id)).toBe('terminal');
    expect(app.manager.summary(id)?.terminal).toBe(true);
    expect(app.events(id).some((e) => e.type === 'process-exit')).toBe(false);
  });

  it('作業中・答え待ちの要求・送る予定の発言があるときは切り替えない。裏のタスクが動いていれば、止まることを確かめたときだけ', async () => {
    const { id, pipe } = await chatting();
    await app.prompt(id, 'つぎ');
    await expect(app.manager.setTerminalMode(id, true)).rejects.toThrow(/作業中/);
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.manager.stateOf(id) === 'idle');
    // 裏の Bash が動いている
    app.say(
      id,
      line.toolUse('toolu_bg', 'Bash', { command: 'npm run dev', run_in_background: true }),
      line.toolResult('toolu_bg', 'Command running in background with ID: b1. Output is being written to: /nonexistent/b1.output', { toolUseResult: { backgroundTaskId: 'b1' } }),
    );
    app.finish(id);
    await app.waitFor('裏のタスク', () => app.manager.stateOf(id) === 'background');
    await expect(app.manager.setTerminalMode(id, true)).rejects.toThrow(/止まります/);
    expect(pipe.requests('end_session')).toHaveLength(0);
    await app.manager.setTerminalMode(id, true, { stopTasks: true });
    expect(app.manager.stateOf(id)).toBe('terminal');
  });
});

describe('ターミナルモードの間', () => {
  it('チャットの送信・親の指示・予約は断る（預からない）。裏のタスクは、ここからは止めず、画面の /tasks を案内する', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    await expect(app.manager.submit(id, 'チャットから')).rejects.toThrow(/ターミナルモード/);
    await expect(app.manager.submitWhenReady(id, '親から', 1000)).rejects.toThrow(/ターミナルモード/);
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_bg' })).toMatch(/\/tasks/);
    expect(tui().writes).toEqual([]);
  });

  it('TUI のターンは会話ログで知る。人の発言で始まり、ターンの終わりの行（か書くだけの Stop のフック）で終わって完了を知らせる', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    const before = app.turnsCompleted.length;
    app.append(id, line.user('TUI で打った指示'));
    await app.waitFor('会話に出る', () => app.events(id).some((e) => e.type === 'user' && e.text === 'TUI で打った指示'));
    // TUI のターンの途中は、チャットに戻さない
    await expect(app.manager.setTerminalMode(id, false)).rejects.toThrow(/作業中/);
    app.append(id, line.text('TUI の返事'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.turnsCompleted.length === before + 1);
    app.append(id, line.user('もう一つ'));
    await app.waitFor('次のターン', () => app.events(id).some((e) => e.type === 'user' && e.text === 'もう一つ'));
    // 書くだけの Stop のフックでも終わる
    app.manager.tuiIdle(id);
    const pty = tui();
    await app.manager.setTerminalMode(id, false);
    expect(pty.killed).toBe(true);
  });

  it('TUI が出した確認・質問（書くだけの PermissionRequest のフック）は、通知と一覧の印にする。答え（会話ログの user の行）で消える', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    const notified = app.attentions.length;
    app.manager.permissionRequested(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }, Date.now());
    expect(app.manager.summary(id)?.attention).toBe('permission');
    expect(app.manager.stateOf(id)).toBe('terminal');
    expect(app.attentions.length).toBe(notified + 1);
    app.append(id, line.toolResult('toolu_x', 'removed'));
    await app.waitFor('答えた', () => app.manager.summary(id)?.attention === null);
    app.manager.permissionRequested(id, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, Date.now() + 1);
    expect(app.manager.summary(id)?.attention).toBe('question');
  });

  it('ボタンで頼んだもの（チェックリストの通知など）は、TUI の入力欄に貼るだけ（Enter は送らない）', async () => {
    const { id } = await chatting();
    expect(app.manager.pasteIntoTerminal(id, 'x')).toBe(false);
    await app.manager.setTerminalMode(id, true);
    expect(app.manager.pasteIntoTerminal(id, '通知です\u001b')).toBe(true);
    expect(tui().writes).toEqual(['\u001b[200~通知です\u001b[201~']);
  });

  it('起動し直す（restart）と、TUI のまま起動し直す', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    tui();
    const spawned = app.host.spawned.length;
    await app.manager.restart(id);
    expect(app.host.spawned.length).toBe(spawned + 1);
    expect(app.manager.stateOf(id)).toBe('terminal');
  });
});

describe('ターミナルモードからチャットへ', () => {
  it('TUI を止めて終わりを確かめ、stream-json を --resume で起動する。TUI で変えた権限モード（会話ログ）を渡す', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    const pty = tui();
    // TUI で plan に切り替えた（会話ログの permission-mode の行）
    app.append(id, { type: 'permission-mode', permissionMode: 'plan', sessionId: app.claudeId(id) });
    await app.waitFor('モード', () => app.manager.modeOf(id) === 'plan');
    const pipes = app.host.allPipes.length;
    await app.manager.setTerminalMode(id, false);
    expect(pty.killed).toBe(true);
    expect(app.host.allPipes.length).toBe(pipes + 1);
    const pipe = app.pipe(id);
    expect(pipe.arg('--resume')).toBe(app.claudeId(id));
    expect(pipe.arg('--permission-mode')).toBe('plan');
    await app.ready(id);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(app.manager.summary(id)?.terminal).toBe(false);
    // 送信を受け付け直す
    await app.manager.submit(id, '戻ってきました');
    expect(pipe.prompts.at(-1)?.message.content).toBe('戻ってきました');
  });
});

describe('アプリの再起動', () => {
  it('前のアプリがターミナルモードで起動した claude（pty）は、止めずにターミナルモードとして引き継ぐ', async () => {
    const { id, pipe } = await chatting();
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    const info: HostedPtyInfo = { kind: 'pty', id: 'pty-1', tag: id, pid: 100, startedAt: Date.now() - 60_000, exitCode: null, cols: DEFAULT_PTY_SIZE.cols, rows: DEFAULT_PTY_SIZE.rows, screen: '画面' };
    app.host.hosted = [info];
    await app.manager.adopt();
    const pty = app.host.attached.at(-1)!;
    expect(pty.killed).toBe(false);
    expect(app.manager.stateOf(id)).toBe('terminal');
    expect(app.manager.summary(id)?.terminal).toBe(true);
    // 前のアプリが描いた画面は今の画面に届いていないので、最初に画面を出したとき（resize）に、大きさをずらして戻し、描き直させる
    app.manager.resize(id, 100, 30);
    expect(pty.resizes).toEqual([[100, 29]]);
    await app.waitFor('戻す', () => pty.resizes.length === 2);
    expect(pty.resizes[1]).toEqual([100, 30]);
    app.manager.resize(id, 90, 30);
    expect(pty.resizes.at(-1)).toEqual([90, 30]);
  });
});
