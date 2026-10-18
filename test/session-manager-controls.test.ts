import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptPath } from '../src/main/claude-session';
import { INIT_RESPONSE, line, ScriptedApp, stream } from './helpers/scripted-claude';

// 動いている Claude Code への操作（SessionManager。設計書 8 節）。画面にキーを送らず、どれも 1 つの制御の要求にする:
// 権限モード（set_permission_mode）・裏のタスクの停止（stop_task）・巻き戻し（rewind_files・rewind_conversation）・Remote Control（remote_control）。
// 入力欄の / の候補も、initialize の返事から作る

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

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
    // 返事の mode が、実際に切り替わったモード。頼んだものと違えば false
    pipe.answers.set('set_permission_mode', { mode: 'default' });
    expect(await app.manager.setMode(id, 'auto')).toBe(false);
    expect(app.manager.modeOf(id)).toBe('manual');
    pipe.answers.delete('set_permission_mode');
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
  // count 個めの stop_task が届いたら、そのタスクの終わりの知らせ（task_notification）を返す
  const stopsWith = async (pipe: ReturnType<typeof app.create>['pipe'], count: number) => {
    await app.waitFor('stop_task', () => pipe.requests('stop_task').length === count);
    const r = pipe.requests('stop_task')[count - 1];
    pipe.emit({ type: 'system', subtype: 'task_notification', task_id: r.request.task_id, status: 'stopped', output_file: '', summary: '', uuid: r.request_id });
  };

  it('task_started の task_id で stop_task を送り、そのタスクの終わりの知らせで止まったと確かめる。Bash は会話ログのタスクの ID でも止める。動いていないものは止めない', async () => {
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
    // 行は届いた順に読むので、あとに送った行が読まれたら、task_started も読み終えている
    pipe.emit(stream.status('plan'));
    await app.waitFor('task_started を読む', () => app.manager.modeOf(id) === 'plan');
    const agent = app.manager.stopTask(id, { kind: 'subagent', toolUseId: 'toolu_agent' });
    await stopsWith(pipe, 1);
    expect(await agent).toBeNull();
    // Bash は、task_started が無くても、会話ログのタスクの ID で止める
    const bash = app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_bg' });
    await stopsWith(pipe, 2);
    expect(await bash).toBeNull();
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

  it('stop_task が success でも、終わりの知らせが来なければ、止まったと確かめられなかったことを返す（知らない ID にも success を返すため）', async () => {
    app.manager.taskStopWaitMs = 50;
    const { id } = app.create();
    await app.ready(id);
    app.say(
      id,
      line.user('サーバーを起動して'),
      line.toolUse('toolu_bg', 'Bash', { command: 'npm run dev', run_in_background: true }),
      line.toolResult('toolu_bg', 'Command running in background with ID: b1. Output is being written to: /nonexistent/b1.output', {
        toolUseResult: { backgroundTaskId: 'b1' },
      }),
      line.text('動かしました'),
    );
    app.finish(id);
    await app.waitFor('裏のタスク', () => app.manager.summary(id)?.backgroundTasks === 1);
    expect(await app.manager.stopTask(id, { kind: 'bash', toolUseId: 'toolu_bg' })).toContain('確かめられませんでした');
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
    // 断られた理由の識別子は、そのまま出さずに画面の言語の文にする
    pipe.answers.set('rewind_conversation', { rewound: false, reason: 'target_not_found', error: 'target not found' });
    expect(await app.manager.rewind(id, first.uuid, { conversation: true, code: false })).toEqual({
      ok: false,
      prefillText: null,
      error: '巻き戻し先の発言が見つかりませんでした',
      codeRewound: false,
    });
    expect(pipe.requests('rewind_files')).toHaveLength(1);
    expect(app.events(id).some((e) => e.type === 'replace')).toBe(false);
    // 文を用意していない理由は、Claude Code の説明のまま
    pipe.answers.set('rewind_conversation', { rewound: false, reason: 'target_splits_tool_call', error: 'target splits a tool call' });
    expect((await app.manager.rewind(id, first.uuid, { conversation: true, code: false })).error).toBe('target splits a tool call');
    pipe.answers.set('rewind_files', { canRewind: false, error: 'No checkpoint' });
    expect(await app.manager.rewind(id, first.uuid, { conversation: true, code: true })).toEqual({ ok: false, prefillText: null, error: 'No checkpoint', codeRewound: false });
    expect(pipe.requests('rewind_conversation')).toHaveLength(2);
  });

  it('rewind: 会話とコードのうち、コードを戻したあとで会話を断られたら、コードは戻したことを返す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const first = line.user('ログインを直して');
    app.say(id, first, line.text('直しました'));
    app.finish(id);
    await app.waitFor('会話', () => app.events(id).some((e) => e.type === 'assistant-text'));
    pipe.answers.set('rewind_files', { canRewind: true });
    pipe.answers.set('rewind_conversation', { rewound: false, reason: 'unseen_later_turn', error: 'unseen later turn' });
    const outcome = await app.manager.rewind(id, first.uuid, { conversation: true, code: true });
    expect(outcome).toMatchObject({ ok: false, codeRewound: true });
    expect(outcome.error).toContain('あとの発言');
    expect(app.events(id).some((e) => e.type === 'replace')).toBe(false);
  });

  it('rewind: 作業中は、コードも戻さずに断る（会話を戻せないと分かっているため）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const first = line.user('ログインを直して');
    app.say(id, first, line.text('直しました'));
    app.finish(id);
    await app.waitFor('会話', () => app.events(id).some((e) => e.type === 'assistant-text'));
    await app.prompt(id, 'つぎ');
    const outcome = await app.manager.rewind(id, first.uuid, { conversation: true, code: true });
    expect(outcome).toMatchObject({ ok: false, codeRewound: false, error: 'Claude Code が作業中です' });
    expect(pipe.requests('rewind_files')).toEqual([]);
  });

  it('rewind: 最後に見た発言は、会話ログのいちばん新しい user の行（チャットの発言にならない、ツールの結果などの行も含む）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const first = line.user('ログインを直して');
    app.say(id, first, line.text('直しました'));
    app.finish(id);
    await app.waitFor('会話', () => app.events(id).some((e) => e.type === 'assistant-text'));
    const result = line.toolResult('toolu_late', 'done');
    app.append(id, line.toolUse('toolu_late', 'Bash', { command: 'true' }), result);
    await app.waitFor('ツールの結果を読む', () => app.events(id).some((e) => e.type === 'tool-result'));
    pipe.answers.set('rewind_conversation', { rewound: true, prefillText: 'ログインを直して' });
    await app.manager.rewind(id, first.uuid, { conversation: true, code: false });
    expect(pipe.requests('rewind_conversation').at(-1)?.request).toMatchObject({ last_seen_user_message_uuid: result.uuid });
  });

  it('巻き戻しの細かいところ: 要求の失敗（error の返事）・理由の無い断り・動いていない・今の会話に無い発言', async () => {
    expect(await app.manager.rewind('nope', 'x', { conversation: true, code: true })).toMatchObject({ ok: false, error: 'Claude Code が動いていません' });
    expect(await app.manager.rewindPreview('nope', 'x')).toBeNull();
    const { id, pipe } = app.create();
    await app.ready(id);
    const first = line.user('ログインを直して');
    app.say(id, first, line.text('直しました'));
    app.finish(id);
    await app.waitFor('会話', () => app.events(id).some((e) => e.type === 'assistant-text'));
    // 要求が error で返ったら、その理由
    pipe.answers.set('rewind_files', new Error('checkpoints are off'));
    expect(await app.manager.rewindPreview(id, first.uuid)).toEqual({ files: null, insertions: 0, deletions: 0, codeError: 'checkpoints are off' });
    expect(await app.manager.rewind(id, first.uuid, { conversation: false, code: true })).toMatchObject({ ok: false, error: 'checkpoints are off' });
    pipe.answers.set('rewind_conversation', new Error('busy'));
    expect((await app.manager.rewind(id, first.uuid, { conversation: true, code: false })).error).toBe('busy');
    // 戻せると答えたが、変わる数を言わない・戻せないが理由を言わない
    pipe.answers.set('rewind_files', { canRewind: true });
    expect(await app.manager.rewindPreview(id, first.uuid)).toEqual({ files: [], insertions: 0, deletions: 0, codeError: null });
    pipe.answers.set('rewind_files', { canRewind: false });
    expect(await app.manager.rewindPreview(id, first.uuid)).toMatchObject({ codeError: null });
    expect((await app.manager.rewind(id, first.uuid, { conversation: false, code: true })).error).toBe('巻き戻し先の発言が見つかりませんでした');
    // 今の会話の行に無い発言を戻せたと答えても、表示は変えない
    pipe.answers.set('rewind_conversation', { rewound: true, prefillText: null });
    expect(await app.manager.rewind(id, 'not-in-chain', { conversation: true, code: false })).toEqual({ ok: true, prefillText: null, error: null });
    expect(app.events(id).some((e) => e.type === 'replace')).toBe(false);
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

  it('止まっていたセッションを開き直してつなぐときも、前の Remote Control のセッションに付け直す（記録に残す）', async () => {
    app.answers.set('remote_control', { session_url: 'https://claude.ai/code/session_x', bridge_session_id: 'bridge-1' });
    const { id } = app.create({ remoteControl: true });
    await app.ready(id);
    await app.waitFor('つなぐ', () => app.manager.remoteConnectedOf(id) === true);
    // アーカイブして戻すと、動いている間の覚え（Runtime）は消え、記録から開き直す（アプリを起動し直したときと同じ）
    await app.manager.archive(id);
    app.manager.unarchive(id);
    await app.manager.open(id);
    await app.ready(id);
    await app.waitFor('つなぎ直す', () => app.pipe(id).requests('remote_control').length === 1);
    expect(app.pipe(id).requests('remote_control')[0].request).toEqual({ subtype: 'remote_control', enabled: true, name: 'tanacode-work', reattach_session_id: 'bridge-1' });
  });

  it('Remote Control を使えない環境（initialize の remote_control_available が false）では、起動が終わってもつなぎに行かない', async () => {
    app.answers.set('initialize', { ...INIT_RESPONSE, remote_control_available: false });
    const { id, pipe } = app.create({ remoteControl: true });
    await app.ready(id);
    // つなぐ要求は、起動が終わったとき（ready）にその場で送る
    expect(pipe.requests('remote_control')).toEqual([]);
  });

  it('つなげなかったら、指定を戻して理由を返す。使わない指定のセッションには送らない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    // つなぐ要求は、起動が終わったとき（ready）にその場で送る
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
    // 使用量は、ターンの終わりにその場で聞く
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

  it('/ のコマンドの一覧が途中で変わったら（commands_changed。スキルを足したなど）、起動し直さずに候補を差し替える', async () => {
    app.answers.set('initialize', { ...INIT_RESPONSE, commands: [{ name: 'compact', description: 'Free up context', argumentHint: '', builtin: true }] });
    const { id, pipe } = app.create();
    await app.ready(id);
    expect(app.manager.commandsOf(id)?.map((c) => c.name)).toEqual(['compact']);
    pipe.emit({
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'compact', description: 'Free up context', argumentHint: '', builtin: true },
        { name: 'deploy', description: 'デプロイする', argumentHint: '<env>', aliases: ['d'] },
      ],
      uuid: 'c1',
      session_id: 's',
    });
    expect(app.manager.commandsOf(id)).toEqual([
      expect.objectContaining({ name: 'compact', source: 'builtin' }),
      { name: 'deploy', description: 'デプロイする', source: 'skill', aliases: ['d'] },
    ]);
    // 形の違う一覧では差し替えない（読めない行として捨てる）
    pipe.emit({ type: 'system', subtype: 'commands_changed', commands: [{ name: 1 }], uuid: 'c2', session_id: 's' });
    expect(app.manager.commandsOf(id)?.map((c) => c.name)).toEqual(['compact', 'deploy']);
  });
});

describe('チェックリストを保存できないセッション', () => {
  it('一覧の印に出す。保存できないと分かったら、一覧を送り直す', () => {
    const unsaved = new Set<string>();
    app.manager.checklistUnsaved = (id) => unsaved.has(id);
    const { id } = app.create();
    expect(app.manager.summary(id)?.checklistUnsaved).toBeUndefined();
    unsaved.add(id);
    const before = app.sessionLists.length;
    app.manager.checklistUnsavedChanged(id);
    expect(app.sessionLists.length).toBe(before + 1);
    expect(app.sessionLists.at(-1)?.find((s) => s.id === id)?.checklistUnsaved).toBe(true);
  });
});
