import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptPath } from '../src/main/claude-session';
import type { TurnStarter } from '../src/main/compact-notice';
import { handoffText, resumeText } from '../src/shared/optimized-compact';
import { QUESTION } from './scenario';
import { line, ScriptedApp, stream } from './helpers/scripted-claude';

// SessionManager の一覧・状態・読み取り（本物の claude なしで動かす。test/session-manager.test.ts の続き）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// チャットに出たターンの終わりの数（新しい会話では、読み直す会話ログが無いので、起動では出ない）
const turnEnds = (id: string) => app.events(id).filter((e) => e.type === 'turn-end').length;

// バックグラウンドで動き続ける Bash を起動した、ターンの途中の行
const backgroundBash = (id: string) => [
  line.user('サーバーを起動して'),
  line.toolUse(`toolu_${id}`, 'Bash', { command: 'npm run dev', run_in_background: true }),
  line.toolResult(`toolu_${id}`, `Command running in background with ID: ${id}. Output is being written to: /nonexistent/${id}.output`, {
    toolUseResult: { backgroundTaskId: id },
  }),
];

// Claude Code が答えを待つ要求（can_use_tool）
const canUseTool = (requestId: string, toolName: string, input: Record<string, unknown>) => ({
  type: 'control_request',
  request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: `toolu_${requestId}` },
});

describe('一覧と記録の読み取り', () => {
  it('watchState: 状態が変わったかもしれないセッションを知らせ、やめたあとは知らせない', async () => {
    const seen: string[] = [];
    const stop = app.manager.watchState((id) => seen.push(id));
    const { id } = app.create();
    expect(seen).toContain(id);
    stop();
    seen.length = 0;
    await app.manager.archive(id);
    expect(seen).toEqual([]);
  });

  it('状態が変わったら、一覧を送り直す（画面は、チャットの状態を一覧の state から決める）', async () => {
    const { id } = app.create();
    await app.ready(id);
    const states = () => app.sessionLists.map((list) => list.find((s) => s.id === id)?.state);
    expect(states().at(-1)).toBe('idle');
    app.say(id, line.user('はじめ'), line.text('考えています'));
    await app.waitFor('作業中', () => states().at(-1) === 'working');
    app.finish(id);
    await app.waitFor('待機中', () => states().at(-1) === 'idle');
    // 状態が変わらない知らせでは、一覧を送り直さない
    const lists = app.sessionLists.length;
    app.manager.notifyState(id);
    expect(app.sessionLists).toHaveLength(lists);
  });

  it('cwdOf・parentOf・childrenOf・claudeSessionIds・transcriptOf: 記録から読む。知らないセッションは cwdOf で失敗する', () => {
    const parent = app.create();
    const child = app.create({ mode: 'manual' }, parent.id);
    expect(app.manager.cwdOf(parent.id)).toBe(app.cwd);
    expect(() => app.manager.cwdOf('nope')).toThrow('unknown session: nope');
    expect(app.manager.parentOf(child.id)).toBe(parent.id);
    expect(app.manager.parentOf(parent.id)).toBeNull();
    expect(app.manager.parentOf('nope')).toBeNull();
    expect(app.manager.childrenOf(parent.id)).toEqual([child.id]);
    expect(app.manager.childrenOf(child.id)).toEqual([]);
    expect(app.manager.claudeSessionIds()).toEqual(new Set([parent.pipe.arg('--session-id'), child.pipe.arg('--session-id')]));
    expect(app.manager.transcriptOf(parent.id)).toBe(app.transcript(parent.id));
    expect(app.manager.transcriptOf('nope')).toBeNull();
    expect(app.manager.summary(child.id)?.parentId).toBe(parent.id);
  });

  it('recentCwd: アーカイブしていない、いちばん最近のセッションのフォルダ。無ければアーカイブしたもの、それも無ければホーム', async () => {
    expect(app.manager.recentCwd()).toBe(homedir());
    const other = join(app.root, 'other');
    mkdirSync(other);
    const opts = { model: null, effort: null, settingsFile: null, mode: null, remoteControl: false, worktree: false };
    const first = app.manager.create(app.cwd, opts);
    await sleep(5);
    const second = app.manager.create(other, opts);
    expect(app.manager.recentCwd()).toBe(other);
    await app.manager.archive(second);
    expect(app.manager.recentCwd()).toBe(app.cwd);
    await app.manager.archive(first);
    // どれもアーカイブしたら、いちばん最近のもの
    expect(app.manager.recentCwd()).toBe(other);
  });

  it('focus: 見ていないセッションのターンが終わると未読にし、開くと未読を消す。見ているセッションは未読にしない', async () => {
    const a = app.create();
    const b = app.create();
    await app.ready(a.id);
    await app.ready(b.id);
    app.manager.focus(b.id);
    expect(app.manager.isFocused(b.id)).toBe(true);
    for (const id of [a.id, b.id]) {
      app.say(id, line.user('やって'), line.text('しました'));
      app.finish(id);
    }
    await app.waitFor('ターンの終わり', () => app.turnsCompleted.length === 2);
    expect(app.manager.summary(a.id)?.unread).toBe(true);
    expect(app.manager.summary(b.id)?.unread).toBe(false);
    const lists = app.sessionLists.length;
    app.manager.focus(a.id);
    expect(app.manager.summary(a.id)?.unread).toBe(false);
    // 未読が変わったので一覧を送り直す。もう一度開いても送らない
    expect(app.sessionLists.length).toBe(lists + 1);
    app.manager.focus(a.id);
    app.manager.focus(null);
    expect(app.sessionLists.length).toBe(lists + 1);
    expect(app.manager.isFocused(a.id)).toBe(false);
  });

  it('snapshot・conversation・history: 動いている間は直近の起動からのイベント、止めたあとは会話ログから読む', async () => {
    expect(app.manager.snapshot('nope')).toEqual({ sessionId: 'nope', fromSeq: 0, events: [] });
    expect(await app.manager.history('nope')).toEqual([]);
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    const snapshot = app.manager.snapshot(id);
    expect(snapshot.fromSeq).toBe(0);
    expect(snapshot.events).toEqual(app.events(id));
    const conversation = await app.manager.conversation(id);
    expect(conversation).toEqual(app.events(id));
    // 写しを返す（あとから届いたイベントで変わらない）
    expect(conversation).not.toBe(snapshot.events);
    await app.manager.archive(id);
    const past = await app.manager.conversation(id);
    expect(past.filter((e) => e.type === 'user' || e.type === 'assistant-text').map((e) => ('text' in e ? e.text : ''))).toEqual(['はじめ', 'はい']);
    expect(past.at(-1)).toEqual({ type: 'turn-end' });
    expect(await app.manager.history(id)).toEqual(past);
  });

  it('exportSource: 会話ログを最初から読み直し、作業したブランチを出てきた順に返す。作業の途中なら最後のターンを終えない', async () => {
    await expect(app.manager.exportSource('nope')).rejects.toThrow('セッションが見つかりません');
    const { id } = app.create();
    await app.ready(id);
    app.say(id, { ...line.user('直して'), gitBranch: 'feature/a' }, { ...line.text('直します'), gitBranch: 'feature/b' }, { ...line.text('まだ'), gitBranch: 'feature/a' });
    await app.waitFor('応答', () => app.events(id).filter((e) => e.type === 'assistant-text').length === 2);
    const live = await app.manager.exportSource(id);
    expect(live.branches).toEqual(['feature/a', 'feature/b']);
    expect(live.home).toBe(homedir());
    expect(live.events.at(-1)?.type).toBe('assistant-text');
    await app.manager.archive(id);
    const archived = await app.manager.exportSource(id);
    expect(archived.events.at(-1)).toEqual({ type: 'turn-end' });
  });

  it('動いていないセッションの読み取りは、空の値を返す', async () => {
    expect(app.manager.subagents('nope')).toEqual([]);
    expect(app.manager.workflows('nope')).toEqual([]);
    expect(app.manager.bashTasks('nope')).toEqual([]);
    expect(app.manager.statusLine('nope')).toBeNull();
    expect(app.manager.knowledge('nope')).toEqual({ files: {}, contextTokens: null });
    expect(app.manager.progress('nope')).toBeNull();
    expect(app.manager.modeOf('nope')).toBeNull();
    expect(app.manager.stateOf('nope')).toBeNull();
    expect(await app.manager.context('nope')).toEqual({ items: [] });
    expect(await app.manager.setMode('nope', 'auto')).toBe(false);
    expect(await app.manager.rewindPreview('nope', 'u1')).toBeNull();
    expect(await app.manager.rewind('nope', 'u1', { conversation: true, code: false })).toMatchObject({ ok: false });
    expect(app.manager.pendingPermission('nope')).toBeNull();
    expect(app.manager.replyPermission('nope', 'r1', { kind: 'allow' })).toBe(false);
    // 知らないセッションへの操作は何もしない（失敗もしない）
    app.manager.write('nope', 'x');
    app.manager.interrupt('nope');
    app.manager.resize('nope', 80, 24);
    // 送信だけは、黙って成功にしない（画面は、送れなかった発言を預かりに戻す）
    await expect(app.manager.submit('nope', 'x')).rejects.toThrow('Claude Code が動いていません');
  });

  it('context: 動いている間はその場の集計、止めたあとは会話ログから集め直す', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('ログインを直して'), line.text('直しました'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    const live = await app.manager.context(id);
    expect(live.items.some((i) => i.kind === 'topic' && i.label.includes('ログインを直して'))).toBe(true);
    await app.manager.archive(id);
    expect(await app.manager.context(id)).toEqual(live);
  });
});

describe('状態（stateOf）と、一覧の状態の文言（liveSessions）', () => {
  const live = (title = '新しいセッション') => app.manager.liveSessions().find((s) => s.title === title)?.state;

  it('起動中 → 待機中 → 作業中 → 待機中。終わったら exited、アーカイブしたら archived で、liveSessions から外す', async () => {
    const { id, pipe } = app.create();
    expect(app.manager.stateOf(id)).toBe('starting');
    expect(app.manager.liveSessions()).toEqual([{ title: '新しいセッション', state: '起動中' }]);
    await app.ready(id);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(live()).toBe('待機中');
    await app.prompt(id, '作業して');
    expect(app.manager.stateOf(id)).toBe('working');
    await app.waitFor('一覧の題', () => live('作業して') === '作業中');
    app.say(id, line.text('しました'));
    app.finish(id);
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(app.manager.liveSessions()).toEqual([]);
    await app.manager.archive(id);
    expect(app.manager.stateOf(id)).toBe('archived');
  });

  it('送ったばかりで会話にまだ出ていない間も、作業中として扱う。result のあと、最後の応答が会話ログに出るまでも作業中', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, '作業して');
    expect(app.manager.stateOf(id)).toBe('working');
    pipe.emit(stream.lifecycle(uuid, 'started'));
    const answer = line.text('しました');
    // 応答は stream-json に先に出て、会話ログにはあとで書かれる
    pipe.emit(stream.assistant(answer));
    app.finish(id);
    await sleep(100);
    expect(app.manager.stateOf(id)).toBe('working');
    expect(turnEnds(id)).toBe(0);
    app.append(id, { ...line.user('作業して'), uuid }, answer);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    expect(app.manager.stateOf(id)).toBe('idle');
  });

  it('バックグラウンドのタスクが動いている間: 作業中（バックグラウンド n 件）→ ターンが終わると完了待ち（background）', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(id, ...backgroundBash('b1'));
    await app.waitFor('バックグラウンドの数', () => app.manager.summary(id)?.backgroundTasks === 1);
    expect(live('サーバーを起動して')).toBe('作業中（バックグラウンド 1件）');
    app.say(id, line.text('起動しました'));
    app.finish(id);
    await app.waitFor('完了待ち', () => app.manager.stateOf(id) === 'background');
    expect(live('サーバーを起動して')).toBe('バックグラウンド 1件の完了待ち');
    expect(app.manager.bashTasks(id).map((t) => [t.command, t.state])).toEqual([['npm run dev', 'running']]);
    expect(app.bashTasks.get(id)).toEqual(app.manager.bashTasks(id));
    // 最適化圧縮の再開の文に入れる、裏で動いているもの
    expect(app.manager.runningTasks(id).map((t) => t.kind)).toEqual(['bash']);
    expect(app.manager.runningTasks(id)[0].label).toContain('npm run dev');
    expect(app.manager.runningTasks('nope')).toEqual([]);
  });

  it('許可の確認・質問は、それぞれの状態と文言（AskUserQuestion の can_use_tool は質問、ほかは許可の確認）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('頼み'), line.toolUse('toolu_x', 'Bash', { command: 'make' }));
    pipe.emit(canUseTool('r1', 'Bash', { command: 'make' }));
    await app.waitFor('許可の確認', () => app.manager.stateOf(id) === 'permission');
    // 一覧の題（最初の発言）は、会話ログを読んでから
    await app.waitFor('一覧の文言', () => live('頼み') === '実行の許可待ち');
    pipe.emit({ type: 'control_cancel_request', request_id: 'r1' });
    pipe.emit(canUseTool('r2', 'AskUserQuestion', { questions: [QUESTION] }));
    await app.waitFor('質問', () => app.manager.stateOf(id) === 'question');
    expect(app.manager.summary(id)?.attention).toBe('question');
    expect(live('頼み')).toBe('質問への回答待ち');
    // claude が終わったら、待っている要求は消える
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(app.manager.summary(id)?.attention).toBeNull();
  });

  it('browserAskChanged: 頼んでいる間は一覧で「ブラウザでの操作待ち」。ターンが終わっても完了を知らせない。同じ知らせは繰り返さない', async () => {
    const { id } = app.create();
    await app.ready(id);
    const lists = app.sessionLists.length;
    // 状態の見張りにも知らせる（親の Claude に、子の状態 browser として見せて知らせるため。sessions-control.ts）
    const changed: string[] = [];
    const unwatch = app.manager.watchState((session) => changed.push(session));
    app.manager.browserAskChanged(id, true);
    app.manager.browserAskChanged(id, true);
    expect(app.sessionLists.length).toBe(lists + 1);
    expect(changed).toEqual([id]);
    expect(app.manager.browserAsking(id)).toBe(true);
    // stateOf は変えない（ほかの部品も使う）
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(app.manager.summary(id)?.attention).toBe('browser');
    expect(live()).toBe('ブラウザでの操作待ち');
    app.say(id, line.user('ログインして'), line.text('ブラウザで操作してください'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1 && app.manager.stateOf(id) === 'idle');
    await sleep(100);
    expect(app.turnsCompleted).toEqual([]);
    const before = app.sessionLists.length;
    changed.length = 0;
    app.manager.browserAskChanged(id, false);
    app.manager.browserAskChanged(id, false);
    unwatch();
    expect(app.manager.summary(id)?.attention).toBeNull();
    expect(app.sessionLists.length).toBe(before + 1);
    expect(changed).toEqual([id]);
    expect(app.manager.browserAsking(id)).toBe(false);
  });
});

describe('statusLine', () => {
  const info = (transcript: string | null) => ({
    model: { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    effort: 'high',
    version: '2.1.292',
    context: null,
    rateLimits: null,
    costUsd: 0.1,
    transcriptPath: transcript,
    updatedAt: 1,
  });

  it('動いているセッションの statusLine（ターミナルモードのファイル）だけを受け取り、画面に知らせる', async () => {
    app.manager.statusLineChanged('nope', info(null));
    expect(app.statusLineInfos.size).toBe(0);
    const { id } = app.create();
    app.manager.statusLineChanged(id, info(null));
    expect(app.manager.statusLine(id)).toEqual(info(null));
    expect(app.statusLineInfos.get(id)).toEqual(info(null));
  });

  it('今のモデルとエフォートは、statusLine があればその値、無ければ起動の指定。どちらも無ければ null', async () => {
    expect(app.manager.currentModel('nope')).toBeNull();
    expect(app.manager.currentEffort('nope')).toBeNull();
    const plain = app.create().id;
    expect([app.manager.currentModel(plain), app.manager.currentEffort(plain)]).toEqual([null, null]);
    const { id } = app.create({ model: 'sonnet', effort: 'low' });
    expect([app.manager.currentModel(id), app.manager.currentEffort(id)]).toEqual(['sonnet', 'low']);
    // /model・/effort で変えたあとは、statusLine の値（--model に渡せるモデル ID）
    app.manager.statusLineChanged(id, info(null));
    expect([app.manager.currentModel(id), app.manager.currentEffort(id)]).toEqual(['claude-opus-5-5', 'high']);
    // statusLine にモデルやエフォートが無ければ、起動の指定
    app.manager.statusLineChanged(id, { ...info(null), model: null, effort: null });
    expect([app.manager.currentModel(id), app.manager.currentEffort(id)]).toEqual(['sonnet', 'low']);
  });

  it('stream-json の行から作る: モデルは init と本体の応答、バージョンは init、エフォートは get_settings、コストは result', async () => {
    app.answers.set('get_settings', { applied: { model: 'claude-opus-5-5', effort: 'medium' } });
    const { id, pipe } = app.create();
    await app.ready(id);
    expect(app.statusLineInfos.get(id)).toMatchObject({ effort: 'medium' });
    pipe.emit(stream.init(app.claudeId(id), { model: 'claude-opus-5-5', claude_code_version: '2.1.301' }));
    await app.waitFor('init', () => app.statusLineInfos.get(id)?.version === '2.1.301');
    expect(app.statusLineInfos.get(id)?.model).toEqual({ id: 'claude-opus-5-5', name: 'Opus 5.5' });
    const model = (name: string) => ({ ...line.text('はい'), message: { ...line.text('はい').message, model: name } });
    app.say(id, line.user('はじめ'), model('claude-fable-5-1'));
    await app.waitFor('応答のモデル', () => app.statusLineInfos.get(id)?.model?.name === 'Fable 5.1');
    // サブエージェントの応答は、本体のモデルではない
    pipe.emit({ ...stream.assistant(model('claude-haiku-5-5')), parent_tool_use_id: 'toolu_agent' });
    // 読めない ID は、そのまま出す（別の接続先のモデルなど）
    app.say(id, model('custom-model'));
    await app.waitFor('読めない ID', () => app.statusLineInfos.get(id)?.model?.name === 'custom-model');
    app.finish(id, { total_cost_usd: 0.25 });
    await app.waitFor('コスト', () => app.statusLineInfos.get(id)?.costUsd === 0.25);
  });

  it('コンテキスト: 途中は本体の最後の応答の usage、ターンの終わりに get_context_usage で聞き直す（上限も）', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('はじめ'), line.text('はい'));
    app.finish(id);
    await app.waitFor('聞き直し', () => app.statusLineInfos.get(id)?.context?.size === 200_000);
    expect(app.statusLineInfos.get(id)?.context).toEqual({ size: 200_000, tokens: 12_000, usedPercent: 6 });
    const usage = { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: 49_000 };
    app.say(id, line.user('つぎ'), { ...line.text('はい'), message: { ...line.text('はい').message, usage } });
    await app.waitFor('途中の使用量', () => app.statusLineInfos.get(id)?.context?.tokens === 50_000);
    expect(app.statusLineInfos.get(id)?.context).toEqual({ size: 200_000, tokens: 50_000, usedPercent: 25 });
  });

  it('/clear で新しい会話になったら（init の session_id が変わる）、新しい会話ログに乗り換える（会話の ID を記録し直し、チャットを空にする）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('前の会話'), line.text('はい'));
    app.finish(id);
    await app.waitFor('前の会話', () => turnEnds(id) === 1);
    const next = '44444444-0000-4000-8000-000000000004';
    const file = transcriptPath(app.cwd, next);
    writeFileSync(file, `${JSON.stringify({ ...line.user('新しい会話'), sessionId: next, cwd: app.cwd })}\n`);
    pipe.emit({ type: 'conversation_reset', session_id: app.claudeId(id), new_conversation_id: 'other' });
    pipe.emit(stream.init(next));
    await app.waitFor('乗り換え', () => app.events(id).some((e) => e.type === 'reset'));
    expect(app.manager.transcriptOf(id)).toBe(file);
    await app.waitFor('新しい会話の発言', () => app.events(id).some((e) => e.type === 'user' && e.text === '新しい会話'));
    // 起動し直すと、新しい会話を再開する
    await app.manager.restart(id);
    expect(app.pipe(id).arg('--resume')).toBe(next);
  });

  it('最適化圧縮の流れが打った /clear で会話が替わったときは、reset に印を付ける（チャットの画面を消さない）。人の /clear には付けない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, line.user('前の会話'), line.text('はい'));
    app.finish(id);
    await app.waitFor('前の会話', () => turnEnds(id) === 1);
    const resets = () => app.events(id).filter((e) => e.type === 'reset');
    const switchTo = async (next: string) => {
      const file = transcriptPath(app.cwd, next);
      writeFileSync(file, `${JSON.stringify({ ...line.user('新しい会話'), sessionId: next, cwd: app.cwd })}\n`);
      const before = resets().length;
      pipe.emit(stream.init(next));
      await app.waitFor('乗り換え', () => resets().length > before);
    };
    const asked: string[] = [];
    app.manager.compactClearing = (session) => {
      asked.push(session);
      return true;
    };
    await switchTo('66666666-0000-4000-8000-000000000006');
    expect(resets()).toEqual([{ type: 'reset', compact: true }]);
    expect(asked).toEqual([id]);
    app.manager.compactClearing = () => false;
    await switchTo('77777777-0000-4000-8000-000000000007');
    expect(resets()).toEqual([{ type: 'reset', compact: true }, { type: 'reset' }]);
  });

  it('ターンの終わりごとに、出す通知の種類を 1 回だけ聞く（そのターンを始めたものを渡す）。null なら完了を知らせず、種類はそのまま知らせに渡す', async () => {
    const { id } = app.create();
    await app.ready(id);
    const asked: [string, TurnStarter][] = [];
    // 最適化圧縮の流れの途中のターン（仕上げ）では出さず、流れの最後のターン（報告して待つ再開）では、最適化の完了にする
    app.manager.turnNotice = (session, starter) => {
      asked.push([session, starter]);
      return starter === 'handoff' ? null : starter === 'resume' ? 'compact' : 'work';
    };
    let turns = 0;
    const turn = async (...lines: Record<string, unknown>[]) => {
      turns += 1;
      app.say(id, ...lines, line.text('はい'));
      app.finish(id);
      await app.waitFor('ターンの終わり', () => turnEnds(id) === turns);
    };
    const RESUME = { lists: [], messages: [], tasks: [] };
    await turn(line.user('税率を可変にして'));
    // 仕上げのターン（このあと /clear）: 聞くが、完了は知らせない。途中で届いた知らせ（タスクの完了など）では、仕上げのターンのまま
    await turn(line.user(handoffText()), line.user('<task-notification><summary>ビルドが終わりました</summary></task-notification>'));
    expect(app.turnNotices).toEqual(['work']);
    // 報告して待つ再開のターン
    await turn(line.user(resumeText(RESUME)));
    // ターンの途中で止めた切り替えの再開は、作業の続き
    await turn(line.user(resumeText({ ...RESUME, auto: { percent: 92, midTurn: true } })));
    // 仕上げの間に人が発言したら、その発言のターン
    await turn(line.user(handoffText()), line.user('やっぱり先に README を直して'));
    // ターンが終わったら、始めたものは持ち越さない（発言の行が無いまま終わったターン）
    await turn();
    expect(asked).toEqual([
      [id, 'other'],
      [id, 'handoff'],
      [id, 'resume'],
      [id, 'other'],
      [id, 'other'],
      [id, 'other'],
    ]);
    expect(app.turnNotices).toEqual(['work', 'compact', 'work', 'work', 'work']);
    // 完了を知らせないとき（ブラウザでの操作待ち）も聞く（流れの途中で出さなかったことを、覚えさせる）
    app.manager.browserAskChanged(id, true);
    await turn(line.user(handoffText()));
    expect(asked).toHaveLength(7);
    expect(app.turnNotices).toHaveLength(5);
  });

  it('何もつながなければ、ターンの終わりは、ふつうの完了として知らせる', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.say(id, line.user('頼み'), line.text('はい'));
    app.finish(id);
    await app.waitFor('完了の知らせ', () => app.turnsCompleted.length === 1);
    expect(app.turnNotices).toEqual(['work']);
  });

  describe('プランの利用枠に当たって止まったターン', () => {
    const RESET = Date.now() + 3 * 60 * 60_000;

    it('会話ログの行（apiError が usage_limit_reached）を正にして、ターンの終わりに枠が戻る時刻を知らせる。止まらずに終わったターンは null', async () => {
      const { id } = app.create();
      await app.ready(id);
      app.say(id, line.user('頼み'), line.text('はい'));
      app.finish(id);
      await app.waitFor('ふつうのターンの終わり', () => app.turnLimits.length === 1);
      // 枠に当たった: 断られた知らせ（rate_limit_event）→ 合成の応答の行 → result（api_error）。時刻は会話ログの行のものを使う
      await app.prompt(id, '続けて');
      app.pipe(id).emit(stream.rateLimit('rejected', RESET + 60_000));
      app.say(id, line.limit(RESET));
      app.pipe(id).emit(stream.limited(app.claudeId(id)));
      await app.waitFor('枠で止まったターンの終わり', () => app.turnLimits.length === 2);
      expect(app.turnLimits).toEqual([
        { id, limit: null },
        { id, limit: { resetsAt: RESET, window: 'five_hour' } },
      ]);
      // チャットには、枠が戻る時刻の付いた API エラーを、ターンの終わりの前に出す。完了の知らせ（onTurnCompleted）は、いつもどおり聞く
      const shown = app.events(id).slice(-2);
      expect(shown[0]).toMatchObject({ type: 'api-error', retrying: false, limit: { resetsAt: RESET, window: 'five_hour' } });
      expect(shown[1]).toEqual({ type: 'turn-end' });
      expect(app.turnNotices).toEqual(['work', 'work']);
    });

    it('会話ログの行が間に合わなくても、result の api_error で止まったと分かる。時刻は断られた知らせから取り、それも無ければ分からない。次のターンに持ち越さない', async () => {
      const { id } = app.create();
      await app.ready(id);
      await app.prompt(id, '続けて');
      // 枠を使ってよい知らせ（allowed）は、時刻の補いにしない
      app.pipe(id).emit(stream.rateLimit('allowed', RESET + 600_000));
      app.pipe(id).emit(stream.rateLimit('rejected', RESET));
      app.pipe(id).emit(stream.limited(app.claudeId(id)));
      await app.waitFor('1 回め', () => app.turnLimits.length === 1);
      await app.prompt(id, 'もう一度');
      app.pipe(id).emit(stream.limited(app.claudeId(id)));
      await app.waitFor('2 回め', () => app.turnLimits.length === 2);
      await app.prompt(id, '戻りましたか');
      app.say(id, line.text('はい'));
      app.finish(id);
      await app.waitFor('3 回め', () => app.turnLimits.length === 3);
      expect(app.turnLimits.map((t) => t.limit)).toEqual([{ resetsAt: RESET, window: 'five_hour' }, { resetsAt: null, window: null }, null]);
    });

    it('止まらずに、モデルが応答しないまま終わったターン（応答の前の中断など）では知らせない（再開の予約を、作業が進んだとして消させない）', async () => {
      const { id } = app.create();
      await app.ready(id);
      await app.prompt(id, '続けて');
      app.say(id, line.limit(RESET));
      app.pipe(id).emit(stream.limited(app.claudeId(id)));
      await app.waitFor('枠で止まる', () => app.turnLimits.length === 1);
      await app.prompt(id, 'やっぱり待って');
      app.pipe(id).emit(stream.interrupted(app.claudeId(id)));
      await app.waitFor('中断したターンの終わり', () => app.turnsCompleted.length === 2);
      expect(app.turnLimits).toHaveLength(1);
    });

    it('ターンが終わったあとに遅れて出た利用枠の行は、次のターンに数えない', async () => {
      const { id } = app.create();
      await app.ready(id);
      app.say(id, line.user('頼み'), line.text('はい'));
      app.finish(id);
      await app.waitFor('ターンの終わり', () => app.turnLimits.length === 1);
      app.append(id, line.limit(RESET));
      await app.waitFor('遅れて出た行', () => app.events(id).some((e) => e.type === 'api-error'));
      app.say(id, line.user('次'), line.text('はい'));
      app.finish(id);
      await app.waitFor('次のターンの終わり', () => app.turnLimits.length === 2);
      expect(app.turnLimits.map((t) => t.limit)).toEqual([null, null]);
    });
  });

  it('最後に終わったターンが、人の中断で終わったかが分かる（result の terminal_reason が aborted_…）。外から見た状態が変わったことを、見張っている先に知らせられる', async () => {
    const { id } = app.create();
    await app.ready(id);
    expect(app.manager.lastTurnInterrupted(id)).toBe(false);
    expect(app.manager.lastTurnInterrupted('nope')).toBe(false);
    app.say(id, line.user('頼み'), line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    expect(app.manager.lastTurnInterrupted(id)).toBe(false);
    app.say(id, line.user('次の頼み'), line.text('途中'), line.user('[Request interrupted by user]'));
    app.pipe(id).emit(stream.interrupted(app.claudeId(id), 'aborted_tools'));
    await app.waitFor('中断', () => app.events(id).some((e) => e.type === 'turn-end' && e.interrupted));
    expect(app.manager.lastTurnInterrupted(id)).toBe(true);
    app.say(id, line.user('その次'), line.text('はい'));
    app.finish(id);
    await app.waitFor('次のターンの終わり', () => turnEnds(id) === 3);
    expect(app.manager.lastTurnInterrupted(id)).toBe(false);
    const seen: string[] = [];
    const unwatch = app.manager.watchState((session) => seen.push(session));
    app.manager.notifyState(id);
    unwatch();
    expect(seen).toEqual([id]);
  });

  it('/clear などのスラッシュコマンドは、送信中として数えない（発言として会話ログに出ない。次の送信を待たせない）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.manager.submitWhenReady(id, '/clear', 2000);
    expect(app.manager.stateOf(id)).toBe('idle');
    await app.manager.submitWhenReady(id, '次の発言', 500);
    expect(pipe.prompts.map((p) => p.message.content)).toEqual(['/clear', '次の発言']);
  });
});

describe('作業中の進み具合', () => {
  it('書いている途中の行から、考えている・書いている・ツールの実行中と、受け取ったトークン数を知らせる。ターンが終わったら null', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    // 手が空いている間に届いた書いている途中の行で、ターンが始まる
    pipe.emit(stream.blockStart('thinking'));
    await app.waitFor('考えている', () => app.progress.get(id)?.phase === 'thinking');
    expect(app.manager.stateOf(id)).toBe('working');
    // 経過は 1 秒ごとに増える（重いときは 1 秒の区切りをまたぐ）
    expect(app.progress.get(id)).toEqual({ phase: 'thinking', elapsed: expect.stringMatching(/^\d+s$/), tokens: null });
    pipe.emit(stream.blockStart('text'));
    pipe.emit(stream.tokens(1234));
    await app.waitFor('書いている', () => app.progress.get(id)?.tokens === '1.2k');
    expect(app.progress.get(id)?.phase).toBe('writing');
    expect(app.manager.progress(id)).toMatchObject({ phase: 'writing', tokens: '1.2k' });
    pipe.emit({ type: 'tool_progress', tool_use_id: 'toolu_1', tool_name: 'Bash', elapsed_time_seconds: 3, uuid: 'p1' });
    await app.waitFor('ツール', () => app.progress.get(id)?.phase === 'working');
    // サブエージェントの行は数えない
    pipe.emit(stream.blockStart('thinking', 'toolu_agent'));
    await sleep(50);
    expect(app.progress.get(id)?.phase).toBe('working');
    app.finish(id);
    await app.waitFor('終わり', () => app.progress.get(id) === null);
    expect(app.manager.progress(id)).toBeNull();
  });

  // 圧縮の行（2.1.302 の実測の形）。自動の圧縮の compacting にだけ compact_output_chars が付く
  const compacting = (auto = false) => ({ type: 'system', subtype: 'status', status: 'compacting', ...(auto ? { compact_output_chars: 0 } : {}), uuid: randomUUID() });
  const compacted = (extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'status', status: null, ...extra, uuid: randomUUID() });

  it('圧縮の間（status の compacting から null まで）は、圧縮中にする。応答を頼んだ知らせ（requesting）・権限モードの変化では終えない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, '/compact');
    await app.waitFor('応答待ち', () => app.progress.get(id)?.phase === 'waiting');
    pipe.emit(compacting());
    await app.waitFor('圧縮中', () => app.progress.get(id)?.phase === 'compacting');
    pipe.emit({ type: 'system', subtype: 'status', status: 'requesting', uuid: randomUUID() });
    pipe.emit(stream.status('acceptEdits'));
    await sleep(50);
    expect(app.progress.get(id)?.phase).toBe('compacting');
    pipe.emit(compacted({ compact_result: 'success' }));
    await app.waitFor('圧縮の終わり', () => app.progress.get(id)?.phase === 'waiting');
    // 成功は、会話ログの区切りで出るので、ここでは何も出さない
    expect(app.events(id).filter((e) => e.type === 'api-error')).toEqual([]);
  });

  it('アプリの圧縮の前のフックが止める自動の圧縮は、圧縮中にしない（止めたあと、compact_result の無い null が来る）。手動の /compact は圧縮中にする', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const blocked: string[] = [];
    app.manager.compactBlocked = (sessionId) => {
      blocked.push(sessionId);
      return true;
    };
    await app.prompt(id, '続けて');
    await app.waitFor('応答待ち', () => app.progress.get(id)?.phase === 'waiting');
    pipe.emit(compacting(true));
    pipe.emit(compacted());
    pipe.emit(stream.messageStart('msg_1'));
    pipe.emit(stream.blockStart('text'));
    await app.waitFor('書いている', () => app.progress.get(id)?.phase === 'writing');
    expect(blocked).toEqual([id]);
    expect(app.events(id).filter((e) => e.type === 'api-error')).toEqual([]);
    // 手動の /compact（compact_output_chars が無い）は、フックが止めないので圧縮中にする
    pipe.emit(compacting());
    await app.waitFor('圧縮中', () => app.progress.get(id)?.phase === 'compacting');
    expect(blocked).toEqual([id]);
  });

  it('auto モードの判定を待つ間（permission_check_status の checking から done まで）は、判定待ちにする。サブエージェントの中の判定は数えない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'コマンドを動かして');
    pipe.emit(stream.blockStart('tool_use'));
    await app.waitFor('ツール', () => app.progress.get(id)?.phase === 'working');
    pipe.emit({ type: 'system', subtype: 'permission_check_status', tool_use_id: 'toolu_sub', agent_id: 'a1', status: 'checking', uuid: randomUUID() });
    await sleep(50);
    expect(app.progress.get(id)?.phase).toBe('working');
    pipe.emit({ type: 'system', subtype: 'permission_check_status', tool_use_id: 'toolu_1', status: 'checking', uuid: randomUUID() });
    await app.waitFor('判定待ち', () => app.progress.get(id)?.phase === 'checking');
    expect(app.manager.progress(id)?.phase).toBe('checking');
    pipe.emit({ type: 'system', subtype: 'permission_check_status', tool_use_id: 'toolu_1', status: 'done', uuid: randomUUID() });
    await app.waitFor('判定の終わり', () => app.progress.get(id)?.phase === 'working');
  });
});

describe('最適化圧縮を自動で始めるか（セッションごと）', () => {
  it('新しいセッションはオン。切り替えると覚えて、一覧と状態の変化を知らせる。知らないセッションでは何もしない', () => {
    const { id } = app.create();
    expect(app.manager.summary(id)?.autoCompact).toBe(true);
    const changed: string[] = [];
    app.manager.watchState((changedId) => changed.push(changedId));
    app.manager.setAutoCompact(id, false);
    expect(app.manager.summary(id)?.autoCompact).toBe(false);
    expect(changed).toContain(id);
    app.manager.setAutoCompact(id, true);
    expect(app.manager.summary(id)?.autoCompact).toBe(true);
    expect(() => app.manager.setAutoCompact('nope', false)).not.toThrow();
  });
});

describe('中断', () => {
  it('interrupt: interrupt の要求を送る', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.manager.interrupt(id);
    await app.waitFor('中断', () => pipe.requests('interrupt').length === 1);
  });
});

describe('会話ログの読み取り', () => {
  it('巻き戻し（/rewind）で前の行から枝分かれしたら、枝分かれより後の表示を捨てる', async () => {
    const { id } = app.create();
    await app.ready(id);
    const u1 = { ...line.user('はじめ'), parentUuid: null };
    const a1 = { ...line.text('はい'), parentUuid: u1.uuid };
    const t1 = { ...line.turnEnd(), parentUuid: a1.uuid };
    const u2 = { ...line.user('次'), parentUuid: t1.uuid };
    const a2 = { ...line.text('了解'), parentUuid: u2.uuid };
    // サブエージェントの行（isSidechain）は、本体の会話のつながりに入れない
    const side = { ...line.user('サブエージェントへの指示'), parentUuid: null, isSidechain: true };
    app.append(id, u1, a1, t1, u2, side, a2);
    await app.waitFor('次の応答', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === '了解'));
    expect(app.events(id).some((e) => e.type === 'replace')).toBe(false);
    // 巻き戻して、はじめの応答のあとから言い直す
    app.append(id, { ...line.user('やり直し'), parentUuid: a1.uuid });
    await app.waitFor('置き換え', () => app.events(id).some((e) => e.type === 'replace'));
    const texts = app.manager.snapshot(id).events.flatMap((e) => (e.type === 'user' || e.type === 'assistant-text' ? [e.text] : []));
    expect(texts).toEqual(['はじめ', 'はい', 'やり直し']);
  });

  it('claude が終わったら、送信中を空にし、動いていたバックグラウンドのタスクを止まったことにする', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.say(id, ...backgroundBash('b2'));
    await app.waitFor('バックグラウンド', () => app.manager.summary(id)?.backgroundTasks === 1);
    await app.send(id, 'あとで');
    pipe.exit(0);
    await app.waitFor('終了', () => app.events(id).some((e) => e.type === 'process-exit'));
    const queues = app.events(id).filter((e) => e.type === 'queue');
    expect(queues.at(-1)).toEqual({ type: 'queue', prompts: [] });
    expect(app.manager.bashTasks(id).map((t) => t.state)).toEqual(['stopped']);
  });

  it('会話ログの先頭に大きな行があっても、発言の行があれば --resume で再開する', async () => {
    const { id, pipe } = app.create();
    const file = app.transcript(id);
    mkdirSync(dirname(file), { recursive: true });
    // 読む区切り（256KB）を超える行のあとに発言がある
    writeFileSync(file, `${JSON.stringify({ type: 'summary', summary: 'x'.repeat(300 * 1024) })}\n${JSON.stringify({ ...line.user('はじめ') })}\n`);
    const conversation = pipe.arg('--session-id');
    await app.manager.restart(id);
    expect(app.pipe(id).arg('--resume')).toBe(conversation);
  });

  it('会話ログに発言が無ければ、--resume できないので新しい会話の ID で始め直す', async () => {
    const { id, pipe } = app.create();
    const file = app.transcript(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ type: 'summary', summary: 'x'.repeat(300 * 1024) })}\n`);
    const conversation = pipe.arg('--session-id');
    await app.manager.restart(id);
    expect(app.pipe(id).arg('--resume')).toBeNull();
    expect(app.pipe(id).arg('--session-id')).not.toBe(conversation);
  });

  it('会話ログの、行として読めないもの（オブジェクトでない JSON）は読み飛ばす', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'));
    appendFileSync(app.transcript(id), '42\n"文字"\n');
    app.say(id, line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => turnEnds(id) === 1);
    expect(app.events(id).filter((e) => e.type === 'user' || e.type === 'assistant-text').map((e) => ('text' in e ? e.text : ''))).toEqual(['はじめ', 'はい']);
  });
});

describe('起動のモードと子', () => {
  it('modeOf: 起動したばかりは、起動に渡したモード（指定が無ければ auto）', () => {
    const a = app.create();
    const b = app.create({ mode: 'plan' });
    expect(app.manager.modeOf(a.id)).toBe('auto');
    expect(app.manager.modeOf(b.id)).toBe('plan');
  });

  it('archive: 先にアーカイブしていた子は、親をアーカイブしても止め直さない', async () => {
    const parent = app.create();
    const child = app.create({ mode: 'manual' }, parent.id);
    await app.manager.archive(child.id);
    const changed: string[] = [];
    app.manager.watchState((id) => changed.push(id));
    await app.manager.archive(parent.id);
    expect(changed).toEqual([parent.id]);
    expect(app.manager.stateOf(child.id)).toBe('archived');
  });
});
