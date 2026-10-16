import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptPath } from '../src/main/claude-session';
import type { UnsentPrompt } from '@shared/chat';
import { INIT_RESPONSE, line, ScriptedApp, stream } from './helpers/scripted-claude';

// 動いている Claude Code への操作（SessionManager。設計書 8 節）。画面にキーを送らず、どれも 1 つの制御の要求にする:
// 権限モード（set_permission_mode）・裏のタスクの停止（stop_task）・巻き戻し（rewind_files・rewind_conversation）・Remote Control（remote_control）。
// 入力欄の / の候補も、initialize の返事から作る。入力欄の「!」のコマンドは、アプリがシェルで動かしてターンを始めずに会話に足す

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('権限モード', () => {
  it('動いている claude は set_permission_mode で切り替え（作業中でも）、子は起動のモードも変える。断られたら false', async () => {
    const parent = app.create();
    const { id, pipe } = app.create({ mode: 'manual' }, parent.id);
    await app.ready(id);
    // 作業中でも切り替える
    app.say(id, line.user('はじめ'), line.text('考えています'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    expect(await app.manager.setMode(id, 'acceptEdits')).toBe(true);
    expect(pipe.requests('set_permission_mode').map((r) => r.request)).toEqual([{ subtype: 'set_permission_mode', mode: 'acceptEdits' }]);
    expect(app.manager.modeOf(id)).toBe('acceptEdits');
    expect(app.manager.summary(id)?.mode).toBe('acceptEdits');
    // manual は Claude Code の名前（default）で送る
    expect(await app.manager.setMode(id, 'manual')).toBe(true);
    expect(pipe.requests('set_permission_mode').at(-1)?.request).toEqual({ subtype: 'set_permission_mode', mode: 'default' });
    // 子は、起動し直しても切り替えたモードで起動する
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await app.manager.open(id);
    expect(app.pipe(id).arg('--permission-mode')).toBe('manual');
    // bypassPermissions は、起動したときに許していなければ断られる
    await app.ready(id);
    app.pipe(id).answers.set('set_permission_mode', new Error('Cannot set permission mode to bypassPermissions'));
    expect(await app.manager.setMode(id, 'bypassPermissions')).toBe(false);
    expect(app.manager.modeOf(id)).toBe('manual');
  });
});

describe('裏のタスクの停止', () => {
  it('task_started の task_id で stop_task を送る。Bash は会話ログのタスクの ID でも止める。動いていないものは止めない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(
      id,
      line.user('サーバーを起動して'),
      line.toolUse('toolu_bg', 'Bash', { command: 'npm run dev', run_in_background: true }),
      line.toolResult('toolu_bg', 'Command running in background with ID: b1. Output is being written to: /nonexistent/b1.output', {
        toolUseResult: { backgroundTaskId: 'b1' },
      }),
      line.toolUse('toolu_agent', 'Agent', { description: '調べる', prompt: '調べて', run_in_background: true }),
      line.toolResult('toolu_agent', 'Async agent launched successfully.\nagentId: a1', { toolUseResult: { isAsync: true, agentId: 'a1', status: 'async_launched' } }),
      line.text('動かしました'),
    );
    app.finish(id);
    await app.waitFor('裏のタスク', () => app.manager.summary(id)?.backgroundTasks === 2);
    // サブエージェントは、task_started の task_id で止める
    pipe.emit({ type: 'system', subtype: 'task_started', task_id: 'task-agent-1', tool_use_id: 'toolu_agent', description: '調べる', task_type: 'local_agent', uuid: 's1' });
    await sleep(20);
    expect(await app.manager.stopTask(id, { kind: 'subagent', toolUseId: 'toolu_agent' })).toBeNull();
    // Bash は、task_started が無くても、会話ログのタスクの ID で止める
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_bg' })).toBeNull();
    expect(pipe.requests('stop_task').map((r) => r.request)).toEqual([
      { subtype: 'stop_task', task_id: 'task-agent-1' },
      { subtype: 'stop_task', task_id: 'b1' },
    ]);
    // 知らない・動いていないものは送らない
    expect(await app.manager.stopTask(id, { kind: 'workflow', toolUseId: 'toolu_none' })).toBe('止められるもの（動いているバックグラウンドのタスク）が見つかりません');
    // 断られたら理由を返す
    pipe.answers.set('stop_task', new Error('Task not found'));
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_bg' })).toBe('止められませんでした（Task not found）');
    expect(await app.manager.stopTask('nope', { kind: 'bash', toolUseId: 'toolu_bg' })).toBe('セッションが動いていないため、止められません');
  });
});

describe('巻き戻し', () => {
  it('rewindPreview は rewind_files の dry_run で変わるファイルを調べる。今の会話に無い発言・コードを戻せないときも答える', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const first = line.user('ログインを直して');
    app.say(id, first, line.text('直しました'));
    app.finish(id);
    await app.waitFor('会話', () => app.events(id).some((e) => e.type === 'assistant-text'));
    app.answers.set('rewind_files', null);
    pipe.answers.set('rewind_files', { canRewind: true, filesChanged: ['/repo/src/login.ts'], insertions: 4, deletions: 1 });
    expect(await app.manager.rewindPreview(id, first.uuid)).toEqual({ files: ['/repo/src/login.ts'], insertions: 4, deletions: 1, codeError: null });
    expect(pipe.requests('rewind_files').map((r) => r.request)).toEqual([{ subtype: 'rewind_files', user_message_id: first.uuid, dry_run: true }]);
    pipe.answers.set('rewind_files', { canRewind: false, error: 'File rewinding is not enabled.' });
    expect(await app.manager.rewindPreview(id, first.uuid)).toEqual({ files: null, insertions: 0, deletions: 0, codeError: 'File rewinding is not enabled.' });
    expect(await app.manager.rewindPreview(id, 'not-in-conversation')).toBeNull();
  });

  it('rewind は、コードを戻してから会話を戻し（最後に見た発言を添える）、チャットの表示もその発言の前にする。戻した発言の文を返す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const first = line.user('ログインを直して');
    const second = line.user('テストも足して');
    app.say(id, first, line.text('直しました'), second, line.text('足しました'));
    app.finish(id);
    await app.waitFor('会話', () => app.events(id).filter((e) => e.type === 'assistant-text').length === 2);
    pipe.answers.set('rewind_files', { canRewind: true, filesChanged: ['/repo/test/login.test.ts'] });
    pipe.answers.set('rewind_conversation', { rewound: true, prefillText: 'テストも足して' });
    const outcome = await app.manager.rewind(id, second.uuid, { conversation: true, code: true });
    expect(outcome).toEqual({ ok: true, prefillText: 'テストも足して', error: null });
    expect(pipe.requests().filter((r) => r.request.subtype.startsWith('rewind')).map((r) => r.request)).toEqual([
      { subtype: 'rewind_files', user_message_id: second.uuid },
      { subtype: 'rewind_conversation', target_message_uuid: second.uuid, last_seen_user_message_uuid: second.uuid },
    ]);
    // チャットは、戻した発言の前の時点（2 つめの発言と、その応答が消える）
    const replaced = [...app.events(id)].reverse().find((e) => e.type === 'replace');
    expect(replaced?.type === 'replace' && replaced.events.filter((e) => e.type === 'user').map((e) => (e.type === 'user' ? e.text : ''))).toEqual(['ログインを直して']);
    expect(app.manager.snapshot(id).events.some((e) => e.type === 'user' && e.text === 'テストも足して')).toBe(false);
  });

  it('rewind: 会話だけ・コードだけも選べる。戻せなかったら理由を返し、表示は変えない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const first = line.user('ログインを直して');
    app.say(id, first, line.text('直しました'));
    app.finish(id);
    await app.waitFor('会話', () => app.events(id).some((e) => e.type === 'assistant-text'));
    pipe.answers.set('rewind_files', { canRewind: true });
    expect(await app.manager.rewind(id, first.uuid, { conversation: false, code: true })).toEqual({ ok: true, prefillText: null, error: null });
    expect(pipe.requests('rewind_conversation')).toEqual([]);
    pipe.answers.set('rewind_conversation', { rewound: false, reason: 'target_not_found' });
    expect(await app.manager.rewind(id, first.uuid, { conversation: true, code: false })).toEqual({ ok: false, prefillText: null, error: 'target_not_found' });
    expect(pipe.requests('rewind_files')).toHaveLength(1);
    expect(app.events(id).some((e) => e.type === 'replace')).toBe(false);
    pipe.answers.set('rewind_files', { canRewind: false, error: 'No checkpoint' });
    expect(await app.manager.rewind(id, first.uuid, { conversation: true, code: true })).toEqual({ ok: false, prefillText: null, error: 'No checkpoint' });
    expect(pipe.requests('rewind_conversation')).toHaveLength(1);
  });
});

describe('Remote Control', () => {
  it('使う指定のセッションは、起動が終わったら remote_control でつなぎ、URL をチャットに出す。切ると enabled: false', async () => {
    app.answers.set('remote_control', { session_url: 'https://claude.ai/code/session_x', bridge_session_id: 'bridge-1' });
    const { id, pipe } = app.create({ remoteControl: true });
    await app.ready(id);
    await app.waitFor('つなぐ', () => app.manager.remoteConnectedOf(id) === true);
    expect(pipe.requests('remote_control').map((r) => r.request)).toEqual([{ subtype: 'remote_control', enabled: true, name: 'tanacode-work' }]);
    expect(app.events(id)).toContainEqual({ type: 'remote-control', url: 'https://claude.ai/code/session_x' });
    expect(await app.manager.setRemoteControl(id, false)).toBeNull();
    expect(pipe.requests('remote_control').at(-1)?.request).toEqual({ subtype: 'remote_control', enabled: false });
    expect(app.manager.remoteConnectedOf(id)).toBe(false);
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
    // つなぎ直すときは、前の Remote Control のセッションに付け直す
    expect(await app.manager.setRemoteControl(id, true)).toBeNull();
    expect(pipe.requests('remote_control').at(-1)?.request).toEqual({ subtype: 'remote_control', enabled: true, name: 'tanacode-work', reattach_session_id: 'bridge-1' });
    // bridge_state で切れたと分かったら、つながっていないにする
    pipe.emit({ type: 'system', subtype: 'bridge_state', state: 'failed', detail: 'network' });
    await app.waitFor('切れた', () => app.manager.remoteConnectedOf(id) === false);
  });

  it('つなげなかったら、指定を戻して理由を返す。使わない指定のセッションには送らない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await sleep(50);
    expect(pipe.requests('remote_control')).toEqual([]);
    pipe.answers.set('remote_control', new Error('Remote Control is only available when using Claude via api.anthropic.com.'));
    expect(await app.manager.setRemoteControl(id, true)).toBe('Remote Control を切り替えられませんでした（Remote Control is only available when using Claude via api.anthropic.com.）');
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
    expect(app.manager.remoteConnectedOf(id)).toBe(false);
  });

  it('開発版（Remote Control を使わない）では、切り替えずに理由を返す', async () => {
    app.dispose();
    app = new ScriptedApp({ remoteControlAvailable: false });
    const { id, pipe } = app.create({ remoteControl: true });
    await app.ready(id);
    expect(await app.manager.setRemoteControl(id, true)).toContain('開発版');
    expect(pipe.requests('remote_control')).toEqual([]);
  });
});

describe('/compact と /clear', () => {
  it('/clear のあとの新しい会話（init の session_id が変わる）に、会話ログを乗り換える', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    await app.manager.submitWhenReady(id, '/clear', 1000);
    const next = '44444444-0000-4000-8000-000000000004';
    // Claude Code は、新しい会話の会話ログに書き始める
    const file = transcriptPath(app.cwd, next);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...line.user('新しい会話'), sessionId: next, cwd: app.cwd })}\n`);
    pipe.emit({ type: 'conversation_reset', session_id: app.claudeId(id), uuid: 'r1' });
    pipe.emit(stream.init(next));
    await app.waitFor('乗り換え', () => app.manager.claudeSessionOf(id) === next);
    expect(app.events(id).some((e) => e.type === 'reset')).toBe(true);
  });

  it('/clear のあと、新しい会話の最初の応答までは、コンテキストの量を分からないとする（空の会話の見積もりを聞かない）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    // 起動のあとに聞いた量（台本は 12000 / 200000）
    await app.waitFor('コンテキスト', () => app.statusLineInfos.get(id)?.context?.tokens === 12_000);
    const asked = () => pipe.requests('get_context_usage').length;
    const before = asked();
    // /clear（Claude Code の中で済むコマンド。モデルを呼ばない result）
    const clear = await app.send(id, '/clear');
    pipe.emit(stream.lifecycle(clear, 'started'));
    pipe.emit({ type: 'conversation_reset', session_id: app.claudeId(id), uuid: 'r1' });
    app.finish(id, { num_turns: 0, terminal_reason: null });
    await app.waitFor('量を空にする', () => app.statusLineInfos.get(id)?.context === null);
    await app.waitFor('/clear のターンの終わり', () => app.manager.stateOf(id) === 'idle');
    await sleep(50);
    expect(asked()).toBe(before);
    // 新しい会話の最初の応答の使用量から、上限（前に聞いたもの）で割合を出す。そのあとは、ターンの終わりにまた聞く
    await app.prompt(id, '再開の文');
    const reply = line.text('引き継ぎました');
    app.say(id, { ...reply, message: { ...reply.message, usage: { input_tokens: 170_000 } } });
    await app.waitFor('応答の使用量', () => app.statusLineInfos.get(id)?.context?.tokens === 170_000);
    expect(app.statusLineInfos.get(id)?.context?.size).toBe(200_000);
    app.finish(id);
    await app.waitFor('聞き直す', () => asked() === before + 1);
  });
});

describe('initialize の返事から作るもの', () => {
  it('入力欄の / の候補は、動いている Claude Code の commands。起動の前・止まったあとは null（フォルダから集める）', async () => {
    app.answers.set('initialize', {
      ...INIT_RESPONSE,
      commands: [
        { name: 'compact', description: 'Free up context', argumentHint: '', builtin: true },
        { name: '__remote-workflow', description: 'internal', argumentHint: '', builtin: true },
        { name: 'deploy', description: 'デプロイする', argumentHint: '<env>' },
      ],
    });
    const { id, pipe } = app.create();
    expect(app.manager.commandsOf(id)).toBeNull();
    await app.ready(id);
    expect(app.manager.commandsOf(id)?.map((c) => [c.name, c.source])).toEqual([
      ['compact', 'builtin'],
      ['deploy', 'skill'],
    ]);
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(app.manager.commandsOf(id)).toBeNull();
  });
});

describe('入力欄の「!」のコマンド', () => {
  let configDir: string;
  beforeEach(() => {
    // 設定のフォルダ（シェルのスナップショットを探す場所）を使い捨てにする（ふだんの Claude Code のものを読まない）
    app.dispose();
    configDir = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-bang-config-')));
    app = new ScriptedApp({ claudeDir: configDir });
    mkdirSync(join(app.cwd, 'sub'), { recursive: true });
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  const queue = (id: string): UnsentPrompt[] => {
    const last = [...app.events(id)].reverse().find((e) => e.type === 'queue');
    return last?.type === 'queue' ? last.prompts : [];
  };
  const appended = (id: string) => app.pipe(id).prompts.filter((p) => (p as { shouldQuery?: boolean }).shouldQuery === false);
  // Claude Code が、足した行を受け付けて会話ログに書く（受け付けの知らせ・モデルを呼ばない空の result）
  const accept = (id: string, lines: { uuid: string; message: { content: unknown } }[]) => {
    for (const sent of lines) {
      for (const state of ['queued', 'started', 'completed'] as const) app.pipe(id).emit(stream.lifecycle(sent.uuid, state));
      app.append(id, { ...line.user(String(sent.message.content)), uuid: sent.uuid });
      app.finish(id, { num_turns: 0, terminal_reason: null });
    }
  };

  it('動かした結果を、TUI と同じ形の 2 行で、ターンを始めずに足す。ターンは開かず、行が会話に出たら送信中から外れる。cd は次の「!」に続く', async () => {
    const shell = process.env.SHELL || '/bin/zsh';
    // Claude Code が起動のときに作るシェルのスナップショット（別名・関数）を読む
    mkdirSync(join(configDir, 'shell-snapshots'), { recursive: true });
    writeFileSync(join(configDir, 'shell-snapshots', `snapshot-${basename(shell)}-${Date.now()}-abcd.sh`), "alias tanahello='echo from-snapshot'\n");
    const { id } = app.create();
    await app.ready(id);
    const states: string[] = [];
    const watching = setInterval(() => states.push(queue(id)[0]?.state ?? '-'), 5);
    await app.manager.runShell(id, 'tanahello; echo "<&>"; echo $CLAUDECODE $GIT_EDITOR; cd sub');
    clearInterval(watching);
    const first = appended(id);
    expect(first.map((p) => p.message.content)).toEqual([
      '<bash-input>tanahello; echo "<&>"; echo $CLAUDECODE $GIT_EDITOR; cd sub</bash-input>',
      '<bash-stdout>from-snapshot\n&lt;&amp;&gt;\n1 true</bash-stdout><bash-stderr></bash-stderr>',
    ]);
    expect(first.every((p) => (p as { client_composed?: boolean }).client_composed === true)).toBe(true);
    expect(queue(id)).toMatchObject([{ id: first[0].uuid, text: 'tanahello; echo "<&>"; echo $CLAUDECODE $GIT_EDITOR; cd sub', shell: true, state: 'sending' }]);
    expect(states).toContain('running');
    accept(id, first);
    await app.waitFor('会話に出る', () => queue(id).length === 0);
    // ターンは開かない（ターンの終わり・完了の知らせを出さない）
    await new Promise((r) => setTimeout(r, 50));
    expect(app.events(id).filter((e) => e.type === 'turn-end')).toEqual([]);
    expect(app.turnsCompleted).toHaveLength(0);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(app.events(id).find((e) => e.type === 'shell')).toMatchObject({ command: 'tanahello; echo "<&>"; echo $CLAUDECODE $GIT_EDITOR; cd sub' });
    // cd が続く
    await app.manager.runShell(id, 'pwd; false');
    expect(appended(id).at(-1)?.message.content).toBe(`<bash-stdout></bash-stdout><bash-stderr>${join(app.cwd, 'sub')}\n</bash-stderr>`);
  });

  it('作業中は、ターンが終わってから動かす（待っている間は順番待ち）', async () => {
    const { id } = app.create();
    await app.ready(id);
    await app.prompt(id, 'はじめ');
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    const running = app.manager.runShell(id, 'echo later');
    await app.waitFor('順番待ち', () => queue(id).some((p) => p.shell && p.state === 'queued'));
    await new Promise((r) => setTimeout(r, 150));
    expect(appended(id)).toEqual([]);
    app.say(id, line.text('はい'));
    app.finish(id);
    await running;
    expect(appended(id).map((p) => p.message.content)).toEqual(['<bash-input>echo later</bash-input>', '<bash-stdout>later</bash-stdout><bash-stderr></bash-stderr>']);
  });

  it('止めると、会話に何も足さず、送信中から外す。claude が終わったら、動いている「!」も止める', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const running = app.manager.runShell(id, 'sleep 30');
    await app.waitFor('実行中', () => queue(id)[0]?.state === 'running');
    expect(app.manager.stopShell(id, queue(id)[0].id)).toBe(true);
    await running;
    expect(appended(id)).toEqual([]);
    expect(queue(id)).toEqual([]);
    expect(app.manager.stopShell(id, 'unknown')).toBe(false);
    // claude が終わった
    const second = app.manager.runShell(id, 'sleep 30');
    await app.waitFor('実行中', () => queue(id)[0]?.state === 'running');
    pipe.exit(0);
    await second;
    expect(appended(id)).toEqual([]);
  });

  it('止まっているセッションは、起動し直してから動かす', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    const running = app.manager.runShell(id, 'echo again');
    await app.waitFor('起動し直す', () => app.pipe(id) !== pipe);
    await running;
    expect(appended(id).map((p) => p.message.content)).toEqual(['<bash-input>echo again</bash-input>', '<bash-stdout>again</bash-stdout><bash-stderr></bash-stderr>']);
  });
});
