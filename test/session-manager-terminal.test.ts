import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StatusLineInfo } from '@shared/statusline';
import { transcriptPath } from '../src/main/claude-session';
import type { HostedPtyInfo } from '../src/main/pty-host-protocol';
import { DEFAULT_PTY_SIZE } from '../src/main/session-manager';
import { SessionStore } from '../src/main/session-store';
import type { SettingsFiles } from '../src/main/settings-files';
import { INIT_RESPONSE, line, ScriptedApp, type ScriptedPty } from './helpers/scripted-claude';

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
async function chatting(options: Parameters<ScriptedApp['create']>[0] = {}, parentId?: string) {
  const { id, pipe } = app.create(options, parentId);
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

  it('切り替えの間、一覧に一度も「終了」を出さない（止めた claude が終わってから、もう片方を起動するまでの間も起動中）', async () => {
    const { id } = await chatting();
    const before = app.sessionLists.length;
    await app.manager.setTerminalMode(id, true);
    const states = app.sessionLists.slice(before).map((list) => list.find((s) => s.id === id)?.state);
    expect(states).not.toContain('exited');
    expect(states.at(-1)).toBe('terminal');
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

  it('TUI のターンは会話ログで知る。人の発言で始まり、ターンの終わりの行で終わって完了を知らせる', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    const before = app.turnsCompleted.length;
    app.append(id, line.user('TUI で打った指示'));
    await app.waitFor('会話に出る', () => app.events(id).some((e) => e.type === 'user' && e.text === 'TUI で打った指示'));
    // 一覧には「ターミナルモード・作業中」と出す
    expect(app.sessions.find((s) => s.id === id)?.terminalWorking).toBe(true);
    // TUI のターンの途中は、チャットに戻さない
    await expect(app.manager.setTerminalMode(id, false)).rejects.toThrow(/作業中/);
    app.append(id, line.text('TUI の返事'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.turnsCompleted.length === before + 1);
    expect(app.sessions.find((s) => s.id === id)?.terminalWorking).toBe(false);
    app.append(id, line.user('もう一つ'));
    await app.waitFor('次のターン', () => app.events(id).some((e) => e.type === 'user' && e.text === 'もう一つ'));
    app.append(id, line.text('もう一つの返事'), line.turnEnd());
    await app.waitFor('次のターンの終わり', () => app.turnsCompleted.length === before + 2);
    const pty = tui();
    await app.manager.setTerminalMode(id, false);
    expect(pty.killed).toBe(true);
  });

  it('書くだけの Stop のフックが動いても、ターンの終わりの行が出るまでは作業中のまま（チェックリストの Stop のフックが続けさせることがある）', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    const pty = tui();
    const before = app.turnsCompleted.length;
    app.append(id, line.user('TUI で打った指示'), line.toolUse('toolu_w', 'Write', { file_path: '/tmp/a.txt', content: 'a' }), line.toolResult('toolu_w', 'ok'), line.text('作業を終えました'));
    await app.waitFor('会話に出る', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === '作業を終えました'));
    // Stop のフックが動いた。同時に動いたチェックリストの Stop のフックが、文を渡して続けさせる
    app.manager.tuiStopHook(id, { hook_event_name: 'Stop', permission_mode: 'auto' });
    expect(app.sessions.find((s) => s.id === id)?.terminalWorking).toBe(true);
    // 続きを作業中の TUI を止めない
    await expect(app.manager.setTerminalMode(id, false)).rejects.toThrow(/作業中/);
    expect(pty.killed).toBe(false);
    // 続きの応答のあと、ターンの終わりの行で終わる
    app.append(
      id,
      { ...line.turnEnd(), subtype: 'stop_hook_summary', hookCount: 2, hookInfos: [], hookErrors: [], hookAdditionalContext: ['Before you end this turn'], preventedContinuation: false },
      line.text('チェックリストを直しました'),
    );
    await app.waitFor('続きの応答', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === 'チェックリストを直しました'));
    app.manager.tuiStopHook(id, { hook_event_name: 'Stop', stop_hook_active: true });
    expect(app.sessions.find((s) => s.id === id)?.terminalWorking).toBe(true);
    app.append(id, line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.turnsCompleted.length === before + 1);
    expect(app.sessions.find((s) => s.id === id)?.terminalWorking).toBe(false);
    await app.manager.setTerminalMode(id, false);
    expect(pty.killed).toBe(true);
  });

  it('TUI のターンが利用枠で止まり、ターンの終わりの行が無いまま次のターンが始まっても、止まったことを次のターンに持ち越さない', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    const before = app.turnLimits.length;
    app.append(id, line.user('TUI で打った指示'), line.limit(Date.now() + 3_600_000));
    await app.waitFor('止まった', () => app.events(id).some((e) => e.type === 'api-error'));
    app.append(id, line.user('もう一度'), line.text('はい'), line.turnEnd());
    await app.waitFor('次のターンの終わり', () => app.turnLimits.length === before + 1);
    expect(app.turnLimits.at(-1)?.limit).toBeNull();
  });

  it('人の発言の無いターン（スキル・裏のタスクの完了の知らせなど）も、モデルの応答の行で始まりを知る', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    app.append(id, line.text('裏のタスクが終わったので続けます'));
    await app.waitFor('会話に出る', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === '裏のタスクが終わったので続けます'));
    await expect(app.manager.setTerminalMode(id, false)).rejects.toThrow(/作業中/);
    app.append(id, line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.manager.summary(id)?.attention === null && app.turnsCompleted.length > 0);
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
    // TUI が確認のメニューを出している間は貼らない（貼った文字がメニューの選択になる）
    app.manager.permissionRequested(id, { tool_name: 'Bash', tool_input: { command: 'ls' } }, Date.now());
    expect(app.manager.pasteIntoTerminal(id, 'もう一つ')).toBe(false);
    expect(tui().writes).toHaveLength(1);
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

// TUI が書いた statusLine（モデル・エフォート）
const statusOf = (model: string, effort: string | null): StatusLineInfo => ({
  model: { id: model, name: model },
  effort,
  version: null,
  context: null,
  rateLimits: null,
  costUsd: null,
  transcriptPath: null,
  updatedAt: Date.now(),
});

describe('切り替えられないとき・切り替えた先が起動できないとき', () => {
  // 登録した設定ファイルの作り物。broken なら確かめで、failPrepare 回めの準備で失敗する
  const settings = { broken: false, prepared: 0, failPrepare: 0 };
  const files = {
    check: () => {
      if (settings.broken) throw new Error('設定ファイルを読めません');
    },
    prepare: (sessionId: string) => {
      settings.prepared += 1;
      if (settings.prepared === settings.failPrepare) throw new Error('設定ファイルを書けません');
      return { settingsFile: `/run/${sessionId}.json`, model: null };
    },
    release: () => {},
  } as unknown as SettingsFiles;
  beforeEach(() => {
    Object.assign(settings, { broken: false, prepared: 0, failPrepare: 0 });
    app.dispose();
    app = new ScriptedApp({ settingsFiles: files });
  });

  it('登録した設定ファイルを読めなければ、今の Claude Code を止める前に断る', async () => {
    const { id, pipe } = await chatting({ settingsFile: 'work' });
    settings.broken = true;
    await expect(app.manager.setTerminalMode(id, true)).rejects.toThrow('設定ファイルを読めません');
    expect(pipe.requests('end_session')).toEqual([]);
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  it('もう片方を起動できなければ、元の種類で開き直して、わけを返す', async () => {
    const { id } = await chatting({ settingsFile: 'work' });
    settings.failPrepare = settings.prepared + 1;
    const pipes = app.host.allPipes.length;
    await expect(app.manager.setTerminalMode(id, true)).rejects.toThrow(/元に戻しました.*設定ファイルを書けません/);
    expect(app.host.allPipes.length).toBe(pipes + 1);
    expect(app.pipe(id).arg('--resume')).toBe(app.claudeId(id));
    await app.ready(id);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(app.manager.summary(id)?.terminal).toBe(false);
  });

  it('チャットに戻した先が起動を終える前に終わったら、ターミナルモードで開き直し、わけ（標準エラーの末尾も）を、起動の知らせで消さずに出す。ターミナルモードの画面の下にも出す', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    tui();
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', null));
    // チャットの Claude Code が、initialize に答える前に終わる
    app.answers.set('initialize', null);
    await app.manager.setTerminalMode(id, false);
    const spawned = app.host.spawned.length;
    app.pipe(id).exit(1, 'Error: settings are invalid\n');
    await app.waitFor('ターミナルモードで開き直す', () => app.host.spawned.length === spawned + 1 && app.manager.stateOf(id) === 'terminal');
    expect(app.manager.summary(id)?.terminal).toBe(true);
    // 起動の知らせ（画面はチャットを空にする）のあとに、わけが出る
    await app.waitFor('わけ', () => {
      const events = app.events(id);
      const start = events.map((e) => e.type).lastIndexOf('process-start');
      return events.slice(start + 1).some((e) => e.type === 'info' && /起動の途中で終了/.test(e.text));
    });
    const reason = app.manager.snapshot(id).events.find((e) => e.type === 'info' && /起動の途中で終了/.test(e.text));
    expect(reason).toMatchObject({ warning: true, screen: true, detail: 'Error: settings are invalid' });
  });

  it('ターミナルモードの Claude Code が起動を終える前に終わったら（フォルダの信頼の確認で「No, exit」など）、チャットで開き直さず、ターミナルモードのまま止めてわけを出す', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    const pipes = app.host.allPipes.length;
    tui().exit(1);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(app.host.allPipes.length).toBe(pipes);
    // わけは終了の表示に出す（チャットは隠れているので、会話には足さない）
    const exit = app.events(id).find((e) => e.type === 'process-exit');
    expect(exit).toMatchObject({ exitCode: 1, reason: expect.stringContaining('起動を終える前に終わりました') });
    expect(app.events(id).some((e) => e.type === 'info')).toBe(false);
    expect(app.manager.summary(id)?.terminal).toBe(true);
  });

  it('起動を終えた（statusLine が届いた）あとに終わったら（/exit など）、チャットに戻さず、ターミナルモードのまま止める。記録にも残す', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    const pipes = app.host.allPipes.length;
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', null));
    tui().exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(app.events(id).some((e) => e.type === 'process-exit')).toBe(true);
    expect(app.host.allPipes.length).toBe(pipes);
    expect(app.manager.summary(id)?.terminal).toBe(true);
    // アプリを起動し直しても、ターミナルモードとして開く（記録に残る。記録は少しまとめてから書く）
    await app.waitFor('記録', () => new SessionStore(join(app.userData, 'sessions.json')).get(id)?.terminal === true);
  });

  it('ターミナルモードで止まったセッションは、アプリを起動し直しても、ターミナルモードのまま止まった状態で開き、「再開」もターミナルモードで起動する', async () => {
    const { id } = await chatting();
    const claudeId = app.claudeId(id);
    await app.manager.setTerminalMode(id, true);
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', null));
    tui().exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.waitFor('記録', () => new SessionStore(join(app.userData, 'sessions.json')).get(id)?.terminal === true);
    const records = new SessionStore(join(app.userData, 'sessions.json')).all();
    const log = readFileSync(app.transcript(id), 'utf8');
    app.dispose();
    app = new ScriptedApp({ records });
    // 会話ログも、起動し直したアプリの作業フォルダの会話として置く（会話の無いセッションは --resume しないため）
    const file = transcriptPath(app.cwd, claudeId, null);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, log);
    expect(app.manager.summary(id)).toMatchObject({ terminal: true, running: false });
    expect(app.manager.stateOf(id)).toBe('exited');
    await app.manager.open(id);
    expect(app.host.allPipes).toHaveLength(0);
    expect(app.host.spawned.at(-1)!.arg('--resume')).toBe(claudeId);
    expect(app.manager.stateOf(id)).toBe('terminal');
  });

  it('止まったターミナルモードの「再開」は、ターミナルモード（TUI）で --resume する', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', null));
    tui().exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    const pipes = app.host.allPipes.length;
    const spawned = app.host.spawned.length;
    await app.manager.open(id);
    expect(app.host.spawned.length).toBe(spawned + 1);
    expect(app.host.allPipes.length).toBe(pipes);
    expect(app.host.spawned.at(-1)!.arg('--resume')).toBe(app.claudeId(id));
    expect(app.manager.stateOf(id)).toBe('terminal');
  });

  it('止まったターミナルモードから、切り替えボタンでチャットに戻すと、チャット（stream-json）で --resume する', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', null));
    tui().exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    const pipes = app.host.allPipes.length;
    await app.manager.setTerminalMode(id, false);
    expect(app.host.allPipes.length).toBe(pipes + 1);
    expect(app.pipe(id).arg('--resume')).toBe(app.claudeId(id));
    expect(app.manager.summary(id)?.terminal).toBe(false);
    await app.waitFor('記録', () => new SessionStore(join(app.userData, 'sessions.json')).get(id)?.terminal === false);
    await app.ready(id);
    expect(app.manager.stateOf(id)).toBe('idle');
  });
});

describe('TUI で変えたものを、チャットに戻すときに引き継ぐ', () => {
  it('モデル・エフォート（/model・/effort。TUI の statusLine で分かる）は、チャットを起動する指定に写す', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    tui();
    // TUI は起動を終えたときに statusLine を書く（起動したときのモデル・エフォート）
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', 'high'));
    app.manager.statusLineChanged(id, statusOf('claude-fable-5-1', 'max'));
    await app.manager.setTerminalMode(id, false);
    const pipe = app.pipe(id);
    expect(pipe.arg('--model')).toBe('claude-fable-5-1');
    expect(pipe.arg('--effort')).toBe('max');
    expect(app.manager.summary(id)).toMatchObject({ model: 'claude-fable-5-1', effort: 'max' });
  });

  it('権限モードは、書くだけのフック（Stop・PermissionRequest）の permission_mode からも知り、チャットに戻すときに渡す', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    tui();
    app.manager.tuiStopHook(id, { hook_event_name: 'Stop', permission_mode: 'acceptEdits' });
    expect(app.manager.modeOf(id)).toBe('acceptEdits');
    app.manager.permissionRequested(id, { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'plan' }, Date.now());
    expect(app.manager.modeOf(id)).toBe('plan');
    app.append(id, line.toolResult('toolu_x', 'ok'));
    await app.waitFor('答えた', () => app.manager.summary(id)?.attention === null);
    await app.manager.setTerminalMode(id, false);
    expect(app.pipe(id).arg('--permission-mode')).toBe('plan');
  });

  it('子は、TUI で起動のモードより強いモードにしても、チャットに戻すときは起動のモードにする（親より緩くしない）。下げたことはチャットに注意の行で知らせる', async () => {
    const parent = app.create();
    const { id } = await chatting({ mode: 'manual' }, parent.id);
    await app.manager.setTerminalMode(id, true);
    tui();
    app.append(id, { type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: app.claudeId(id) });
    await app.waitFor('モード', () => app.manager.modeOf(id) === 'acceptEdits');
    await app.manager.setTerminalMode(id, false);
    expect(app.pipe(id).arg('--permission-mode')).toBe('manual');
    // 会話を読み直したあと（チャットの最後）に出す
    await app.waitFor('注意の行', () => app.events(id).at(-1)?.type === 'info');
    expect(app.events(id).at(-1)).toMatchObject({ type: 'info', warning: true, screen: true, text: expect.stringMatching(/編集は自動.*都度確認/) });
    expect(app.events(id).filter((e) => e.type === 'info')).toHaveLength(1);
  });

  it('bypassPermissions は、起動し直すと引き継がない。下げたことはチャットに注意の行で知らせる（下げなければ出さない）', async () => {
    const { id } = await chatting({ mode: 'acceptEdits' });
    await app.manager.setTerminalMode(id, true);
    tui().exitOnKill = true;
    // 下げないときは出さない
    await app.manager.restart(id);
    await app.waitFor('起動し直す', () => app.manager.stateOf(id) === 'terminal');
    tui();
    app.append(id, { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: app.claudeId(id) });
    await app.waitFor('モード', () => app.manager.modeOf(id) === 'bypassPermissions');
    await app.manager.restart(id);
    expect(app.host.spawned.at(-1)!.arg('--permission-mode')).toBe('auto');
    await app.waitFor('注意の行', () => app.events(id).some((e) => e.type === 'info'));
    expect(app.events(id).filter((e) => e.type === 'info')).toEqual([
      expect.objectContaining({ warning: true, screen: true, text: expect.stringMatching(/「auto」.*すべて許可/) }),
    ]);
  });
});

describe('起動し直したときの、下げた権限モードの知らせ（チャット）', () => {
  it('下げた先のモードは、受け付けられるようになったときのもので書く（auto を使えないモデルなら、起動の途中で manual に戻る）', async () => {
    const { id } = await chatting({ mode: 'bypassPermissions' });
    expect(app.manager.modeOf(id)).toBe('bypassPermissions');
    app.answers.set('initialize', { ...INIT_RESPONSE, models: [{ ...INIT_RESPONSE.models[0], supportsAutoMode: false }] });
    app.pipe(id).exitOnEnd = true;
    await app.manager.restart(id);
    expect(app.pipe(id).arg('--permission-mode')).toBe('auto');
    await app.ready(id);
    await app.waitFor('注意の行', () => app.events(id).some((e) => e.type === 'info'));
    expect(app.manager.modeOf(id)).toBe('manual');
    expect(app.events(id).filter((e) => e.type === 'info')).toEqual([expect.objectContaining({ warning: true, text: expect.stringMatching(/「都度確認」.*すべて許可/) })]);
  });
});

describe('アプリを起動し直したあとの、ターミナルモードからチャットへの切り替え', () => {
  // アプリを起動し直す（記録と会話ログを、新しいアプリの作業フォルダに写す。前のアプリで覚えていたモデルなどは無くなる）
  async function restartApp(id: string) {
    await app.waitFor('記録', () => new SessionStore(join(app.userData, 'sessions.json')).get(id)?.terminal === true);
    const records = new SessionStore(join(app.userData, 'sessions.json')).all();
    const claudeId = app.claudeId(id);
    const log = readFileSync(app.transcript(id), 'utf8');
    app.dispose();
    app = new ScriptedApp({ records });
    const file = transcriptPath(app.cwd, claudeId, null);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, log);
  }

  // 前のアプリがターミナルモードで起動した claude（pty）を引き継ぐ。statusLine: 引き継ぐ前に TUI が書いていた statusLine
  async function adopted(statusLine: StatusLineInfo | null) {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    await restartApp(id);
    if (statusLine) {
      const raw = { model: { id: statusLine.model!.id, display_name: statusLine.model!.name }, ...(statusLine.effort ? { effort: { level: statusLine.effort } } : {}) };
      writeFileSync(app.statusLines.fileFor(id), JSON.stringify(raw));
    }
    app.host.hosted = [{ kind: 'pty', id: 'pty-1', tag: id, pid: 100, startedAt: Date.now() - 60_000, exitCode: null, cols: DEFAULT_PTY_SIZE.cols, rows: DEFAULT_PTY_SIZE.rows, screen: '' }];
    await app.manager.adopt();
    expect(app.manager.stateOf(id)).toBe('terminal');
    app.host.attached.at(-1)!.exitOnKill = true;
    return id;
  }

  it('引き継いだ TUI で変えていなければ、モデル・エフォートは写さない（「既定」のまま）', async () => {
    const id = await adopted(statusOf('claude-opus-5-5', 'high'));
    // 引き継いだあとに TUI が書いた statusLine（引き継ぐ前と同じ）
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', 'high'));
    await app.manager.setTerminalMode(id, false);
    expect(app.pipe(id).arg('--model')).toBe('default');
    expect(app.pipe(id).arg('--effort')).toBeNull();
    expect(app.manager.summary(id)).toMatchObject({ model: null, effort: null });
  });

  it('引き継いだあとに TUI で変えたモデル・エフォートは写す', async () => {
    const id = await adopted(statusOf('claude-opus-5-5', 'high'));
    app.manager.statusLineChanged(id, statusOf('claude-fable-5-1', 'high'));
    await app.manager.setTerminalMode(id, false);
    expect(app.pipe(id).arg('--model')).toBe('claude-fable-5-1');
    expect(app.pipe(id).arg('--effort')).toBeNull();
  });

  it('引き継ぐ前の statusLine が無ければ、引き継いだ TUI の最初の statusLine を基準にする', async () => {
    const id = await adopted(null);
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', 'high'));
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', 'max'));
    await app.manager.setTerminalMode(id, false);
    expect(app.pipe(id).arg('--model')).toBe('default');
    expect(app.pipe(id).arg('--effort')).toBe('max');
  });

  it('止まったターミナルモードを開き直した TUI（前のモデルが分からない）でも、変えていなければ写さない', async () => {
    const { id } = await chatting();
    await app.manager.setTerminalMode(id, true);
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', null));
    tui().exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await restartApp(id);
    await app.manager.open(id);
    tui();
    app.manager.statusLineChanged(id, statusOf('claude-opus-5-5', 'high'));
    await app.manager.setTerminalMode(id, false);
    expect(app.pipe(id).arg('--model')).toBe('default');
    expect(app.pipe(id).arg('--effort')).toBeNull();
    expect(app.manager.summary(id)).toMatchObject({ model: null, effort: null });
  });
});

describe('Remote Control を使わないセッション', () => {
  it('つながっていなくても、TUI にする前に切る（TUI は会話ログに残った前のつながりにつなぎ直すため）。切れなければ切り替えない', async () => {
    const { id, pipe } = await chatting();
    await app.manager.setTerminalMode(id, true);
    expect(pipe.requests('remote_control').map((r) => r.request)).toEqual([{ subtype: 'remote_control', enabled: false }]);
    const other = await chatting();
    other.pipe.answers.set('remote_control', new Error('bridge is busy'));
    await expect(app.manager.setTerminalMode(other.id, true)).rejects.toThrow(/Remote Control を切れなかった.*bridge is busy/);
    expect(other.pipe.requests('end_session')).toEqual([]);
    expect(app.manager.stateOf(other.id)).toBe('idle');
  });

  it('切り替えの途中（Remote Control を切っている間）に claude が自分で終わったら、終了を出し、切り替えずに止まったままにする', async () => {
    const { id, pipe } = await chatting();
    // 切る要求に答えないまま、claude が落ちる
    pipe.answers.set('remote_control', null);
    const switching = app.manager.setTerminalMode(id, true);
    await app.waitFor('切る要求', () => pipe.requests('remote_control').length === 1);
    const spawned = app.host.spawned.length;
    pipe.exit(1);
    await expect(switching).rejects.toThrow(/切り替えの途中で Claude Code が終了しました/);
    // 黙って消えない（チャットに終了を出す。止まっているので、送った発言は「再開したら送る」で預かる）
    expect(app.events(id).find((e) => e.type === 'process-exit')).toMatchObject({ exitCode: 1 });
    expect(app.manager.stateOf(id)).toBe('exited');
    expect(app.host.spawned.length).toBe(spawned);
    expect(app.manager.summary(id)?.terminal).toBe(false);
  });

  it('Remote Control を使えない環境（initialize の remote_control_available が false）では、切る要求を送らない', async () => {
    app.answers.set('initialize', { ...INIT_RESPONSE, remote_control_available: false });
    const { id, pipe } = await chatting();
    await app.manager.setTerminalMode(id, true);
    expect(pipe.requests('remote_control')).toEqual([]);
    expect(app.manager.stateOf(id)).toBe('terminal');
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
    // 前のアプリが描いた画面は今の画面に届いていないので、最初に画面を出したとき（resize）に、ホストが持つ今の画面を取り直して、
    // 端末を初期化してから流す
    const before = app.ptyData.length;
    app.manager.resize(id, 100, 30);
    expect(pty.resizes).toEqual([[100, 30]]);
    await app.waitFor('取り直した画面', () => app.ptyData.length > before);
    expect(app.ptyData.slice(before)).toEqual([{ id, data: '\x1bc画面' }]);
    // 2 回めからは、大きさを変えるだけ
    app.manager.resize(id, 90, 30);
    expect(pty.resizes.at(-1)).toEqual([90, 30]);
    // 取り直すかは resize のときにその場で決める（2 回めは取り直さない）
    expect(app.ptyData.length).toBe(before + 1);
  });

  it('引き継いだ TUI が済ませたターンは、読み直しても完了を知らせない（流し直した行は通知しない）', async () => {
    const { id, pipe } = await chatting();
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    // 前のアプリのターミナルモードの間に、TUI が済ませたターン
    app.append(id, line.user('TUI で頼んだこと'), line.text('済みました'), line.turnEnd());
    const completed = app.turnsCompleted.length;
    const notified = app.attentions.length;
    app.host.hosted = [{ kind: 'pty', id: 'pty-1', tag: id, pid: 100, startedAt: Date.now() - 60_000, exitCode: null, cols: DEFAULT_PTY_SIZE.cols, rows: DEFAULT_PTY_SIZE.rows, screen: '' }];
    await app.manager.adopt();
    await app.waitFor('読み直す', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === '済みました'));
    expect(app.turnsCompleted.length).toBe(completed);
    expect(app.attentions.length).toBe(notified);
    // ターンの外なので、チャットに戻せる
    app.host.attached.at(-1)!.exitOnKill = true;
    await app.manager.setTerminalMode(id, false);
    expect(app.manager.summary(id)?.terminal).toBe(false);
  });

  // 前のアプリのターミナルモードの間に、TUI が確認を出した（書くだけの PermissionRequest のフックがファイルに書いた）。
  // answered: その確認に答えた（会話ログのツールの結果の行）
  async function adoptAsking(answered: boolean) {
    const { id, pipe } = await chatting();
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    const earlier = (ms: number) => new Date(Date.now() - ms).toISOString();
    app.append(
      id,
      { ...line.user('build を消して'), timestamp: earlier(5000) },
      { ...line.toolUse('toolu_rm', 'Bash', { command: 'rm -rf build' }), timestamp: earlier(4000) },
    );
    writeFileSync(app.statusLines.permissionFileFor(id), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, permission_mode: 'manual' }));
    if (answered) app.append(id, line.toolResult('toolu_rm', 'removed'), line.text('消しました'), line.turnEnd());
    const notified = app.attentions.length;
    app.host.hosted = [{ kind: 'pty', id: 'pty-1', tag: id, pid: 100, startedAt: Date.now() - 60_000, exitCode: null, cols: DEFAULT_PTY_SIZE.cols, rows: DEFAULT_PTY_SIZE.rows, screen: '' }];
    await app.manager.adopt();
    await app.waitFor('読み直す', () => app.events(id).some((e) => e.type === 'tool-use'));
    if (answered) await app.waitFor('答えを読み直す', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === '消しました'));
    return { id, notified };
  }

  it('引き継いだ TUI が確認・質問のメニューを出したままなら、一覧の印と、TUI に貼らない守りを戻す（流し直しなので通知はしない）', async () => {
    const { id, notified } = await adoptAsking(false);
    await app.waitFor('確認待ち', () => app.manager.summary(id)?.attention === 'permission');
    expect(app.attentions.length).toBe(notified);
    expect(app.manager.pasteIntoTerminal(id, '通知です')).toBe(false);
    // 答えた（会話ログのツールの結果の行）ら消え、貼れるようになる
    app.append(id, line.toolResult('toolu_rm', 'removed'));
    await app.waitFor('答えた', () => app.manager.summary(id)?.attention === null);
    expect(app.manager.pasteIntoTerminal(id, '通知です')).toBe(true);
  });

  it('引き継ぐ前に答え終えた確認は、戻さない', async () => {
    const { id } = await adoptAsking(true);
    expect(app.manager.summary(id)?.attention).toBeNull();
    expect(app.manager.pasteIntoTerminal(id, '通知です')).toBe(true);
  });
});
