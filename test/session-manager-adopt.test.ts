import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionEventText } from '@shared/session-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostedPipeInfo, HostedPtyInfo } from '../src/main/pty-host-protocol';
import { DEFAULT_PTY_SIZE } from '../src/main/session-manager';
import { SessionStore } from '../src/main/session-store';
import { line, ScriptedApp, stream } from './helpers/scripted-claude';

// アプリを起動し直したとき、前のアプリが起動して動き続けている claude を引き継ぐ（adopt）。アプリの終了（closeAll）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 常駐のホストが持っている stream-json の claude。lastSeq: 最後の行の通し番号（送り直しは firstSeq から）
const hosted = (tag: string, patch: Partial<HostedPipeInfo> = {}): HostedPipeInfo => ({
  kind: 'pipe',
  id: `pipe-${tag}`,
  tag,
  pid: 100,
  startedAt: Date.now() - 60_000,
  exitCode: null,
  lastSeq: 0,
  firstSeq: 1,
  retained: [],
  pending: [],
  ended: false,
  stderr: '',
  ...patch,
});

// 前のアプリがターミナルモード（TUI）で起動した claude
const hostedPty = (tag: string): HostedPtyInfo => ({
  kind: 'pty',
  id: `pty-${tag}`,
  tag,
  pid: 100,
  startedAt: Date.now() - 60_000,
  exitCode: null,
  cols: DEFAULT_PTY_SIZE.cols,
  rows: DEFAULT_PTY_SIZE.rows,
  screen: '',
});

// 前のアプリで起動していた（今のアプリでは動いていない）セッション。会話ログを書いておく
async function previous(...entries: Record<string, unknown>[]): Promise<string> {
  const { id, pipe } = app.create();
  if (entries.length > 0) {
    const file = app.transcript(id);
    mkdirSync(dirname(file), { recursive: true });
    const claudeId = pipe.arg('--session-id');
    writeFileSync(file, entries.map((e) => JSON.stringify({ sessionId: claudeId, cwd: app.cwd, ...e })).join('\n') + '\n');
  }
  await app.ready(id);
  pipe.exit(0);
  await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
  return id;
}

// Remote Control のつながりの行。Claude Code はこの行に時刻を書かない（引き継いだ claude が書いたものか分からない）
const bridgeSession = (bridgeSessionId: string) => ({ ...line.turnEnd(), type: 'bridge-session', subtype: undefined, timestamp: undefined, bridgeSessionId });

const attached = (id: string) => app.host.attachedPipes.find((p) => p.request.tag === id);
// 送ったが、まだ会話に出ていない発言（チャットに知らせた最後のもの）
const queue = (id: string) => {
  const last = [...app.manager.snapshot(id).events].reverse().find((e) => e.type === 'queue');
  return last?.type === 'queue' ? last.prompts : [];
};

describe('adopt', () => {
  it('終わったものは記録を捨て、知らない・アーカイブした・もう動いているセッションは止め、ほかは起動し直さずに引き継ぐ（TUI の claude はターミナルモードとして）', async () => {
    const adopted = await previous(line.user('はじめ'), line.text('はい'));
    const archived = await previous();
    await app.manager.archive(archived);
    const running = app.create().id;
    const terminal = await previous(line.user('ターミナルモード'));
    app.host.hosted = [hosted('exited', { exitCode: 0 }), hosted('unknown'), hosted(archived), hosted(running), hostedPty(terminal), hosted(adopted)];
    const spawned = app.host.pipes.length;
    await app.manager.adopt();
    expect(app.host.forgotten).toEqual(['pipe-exited']);
    expect(attached('unknown')?.kills).toEqual(['SIGTERM']);
    expect(attached(archived)?.kills).toEqual(['SIGTERM']);
    expect(attached(running)?.kills).toEqual(['SIGTERM']);
    expect(app.host.attached.find((p) => p.request.tag === terminal)?.killed).toBe(false);
    expect(app.manager.stateOf(terminal)).toBe('terminal');
    expect(attached(adopted)?.kills).toEqual([]);
    expect(app.host.pipes).toHaveLength(spawned);
    expect(app.manager.summary(adopted)?.running).toBe(true);
    // 引き継いだ claude には initialize を送り直さない（前のアプリが済ませている）
    expect(attached(adopted)?.requests('initialize')).toEqual([]);
    // 送った発言は、引き継いだ claude に届く
    await app.ready(adopted);
    await app.manager.submit(adopted, 'つづき');
    expect(attached(adopted)?.prompts.map((p) => p.message.content)).toEqual(['つづき']);
  });

  it('控えている行の送り直しを頼み、前のアプリの頃の行から状態を組み立て直す（通知は出さない）。読み終えてからターンの終わりを決める', async () => {
    const id = await previous(line.user('はじめ'), line.text('はい'));
    app.host.hosted = [hosted(id, { lastSeq: 3, firstSeq: 1 })];
    await app.manager.adopt();
    const pipe = attached(id)!;
    expect(pipe.replays).toEqual([1]);
    // 前のアプリの頃に終わったターン
    pipe.emit(stream.assistant(line.text('はい')), 1);
    pipe.emit(stream.result(), 2);
    pipe.emit(stream.init(app.claudeId(id), { model: 'claude-fable-5-1' }), 3);
    await app.waitFor('読み直し', () => app.manager.snapshot(id).events.some((e) => e.type === 'user'));
    await sleep(100);
    expect(app.manager.snapshot(id).events.some((e) => e.type === 'turn-end')).toBe(false);
    pipe.replayed();
    await app.waitFor('読み終わり', () => app.manager.snapshot(id).events.some((e) => e.type === 'turn-end'));
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
    expect(app.turnsCompleted).toEqual([]);
    expect(app.manager.statusLine(id)?.model?.name).toBe('Fable 5.1');
  });

  it('前のアプリの頃に始まって、まだ終わっていないターンは、作業中のまま。そのあと届いた result で終わる', async () => {
    const id = await previous(line.user('はじめ'));
    app.host.hosted = [hosted(id, { lastSeq: 2, firstSeq: 1 })];
    await app.manager.adopt();
    const pipe = attached(id)!;
    pipe.emit(stream.lifecycle('u1', 'started'), 1);
    pipe.emit(stream.blockStart('thinking'), 2);
    pipe.replayed();
    await app.waitFor('起動済み', () => app.manager.snapshot(id).events.some((e) => e.type === 'ready'));
    await sleep(200);
    expect(app.manager.stateOf(id)).toBe('working');
    expect(app.manager.snapshot(id).events.some((e) => e.type === 'turn-end')).toBe(false);
    // 前のアプリの頃の行では進み具合を作らないが、読み終えたらターンの途中として進み具合を始める
    expect(app.progress.get(id)).toMatchObject({ phase: 'waiting' });
    expect(app.manager.progress(id)).toMatchObject({ phase: 'waiting' });
    pipe.emit(stream.blockStart('text'));
    await app.waitFor('書いている', () => app.progress.get(id)?.phase === 'writing');
    pipe.emit(stream.result(), 4);
    await app.waitFor('ターンの終わり', () => app.manager.stateOf(id) === 'idle');
    expect(app.turnsCompleted.map((s) => s.id)).toEqual([id]);
  });

  it('控えの頭より前の、種類ごとの最新の行（retained）も、前のアプリの頃の行として読む', async () => {
    const id = await previous(line.user('はじめ'));
    const init = { seq: 2, line: JSON.stringify(stream.init('x', { model: 'claude-sonnet-5', permissionMode: 'plan' })) };
    app.host.hosted = [hosted(id, { lastSeq: 40, firstSeq: 30, retained: [init] })];
    await app.manager.adopt();
    await app.waitFor('組み立て直し', () => app.manager.statusLine(id)?.model?.name === 'Sonnet 5');
    expect(app.manager.modeOf(id)).toBe('plan');
    expect(attached(id)?.replays).toEqual([30]);
  });

  it('アプリを止めている間に /clear で会話が変わっていたら、送り直しの行（新しい会話の init）で、新しい会話ログに乗り換える', async () => {
    const id = await previous(line.user('はじめ'));
    const before = app.claudeId(id);
    // 止めている間に、claude が新しい会話を始めて書いた会話ログ
    const next = '99999999-0000-4000-8000-000000000009';
    const file = join(dirname(app.transcript(id)), `${next}.jsonl`);
    writeFileSync(file, JSON.stringify({ ...line.user('止めている間の発言'), sessionId: next, cwd: app.cwd }) + '\n');
    const init = { seq: 2, line: JSON.stringify(stream.init(next)) };
    app.host.hosted = [hosted(id, { lastSeq: 40, firstSeq: 30, retained: [init], startedAt: Date.now() - 60_000 })];
    await app.manager.adopt();
    attached(id)!.replayed();
    await app.waitFor('乗り換え', () => app.claudeId(id) === next);
    expect(app.claudeId(id)).not.toBe(before);
    await app.waitFor('新しい会話', () => app.events(id).some((e) => e.type === 'user' && e.text === '止めている間の発言'));
    // はじめの会話ログを読み終える前に乗り換えても、乗り換えた先を読み終えたら、過去の会話の終わりを決める（作業中のまま残さない）
    const types = () => app.events(id).map((e) => e.type);
    await app.waitFor('過去の会話の終わり', () => types().lastIndexOf('turn-end') > types().lastIndexOf('reset'));
  });

  it('まだ答えていない要求（pending）は、出し直す', async () => {
    const id = await previous(line.user('はじめ'));
    const request = {
      type: 'control_request',
      request_id: 'req-old',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'make' }, tool_use_id: 'toolu_1' },
    };
    app.host.hosted = [hosted(id, { lastSeq: 1, firstSeq: 1, pending: [{ seq: 1, line: JSON.stringify(request) }] })];
    await app.manager.adopt();
    await app.waitFor('許可の確認', () => app.manager.stateOf(id) === 'permission');
    expect(app.manager.summary(id)?.attention).toBe('permission');
  });

  it('出し直した要求では、もう一度は通知しない。プランの承認の本文は、会話ログを読み直してから出し直す。質問は質問のまま', async () => {
    const planFile = join(app.home, '.claude', 'plans', 'adopted.md');
    mkdirSync(dirname(planFile), { recursive: true });
    writeFileSync(planFile, '# 引き継いだ計画\n');
    const id = await previous(line.user('計画して'), { ...line.turnEnd(), type: 'attachment', subtype: undefined, attachment: { type: 'plan_mode', planFilePath: planFile, planExists: true } });
    const pending = (requestId: string, body: Record<string, unknown>, seq: number) => ({
      seq,
      line: JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_use_id: `toolu_${requestId}`, ...body } }),
    });
    const questions = [{ question: 'どちらにしますか?', header: '方式', multiSelect: false, options: [{ label: 'A', description: '' }] }];
    app.host.hosted = [
      hosted(id, {
        lastSeq: 2,
        firstSeq: 1,
        pending: [pending('req-q', { tool_name: 'AskUserQuestion', input: { questions } }, 1), pending('req-plan', { tool_name: 'ExitPlanMode', input: {} }, 2)],
      }),
    ];
    const before = app.attentions.length;
    await app.manager.adopt();
    attached(id)!.replayed();
    await app.waitFor('プランの本文', () => app.manager.pendingPermission(id)?.plan === '# 引き継いだ計画\n');
    expect(app.manager.pendingPermission(id)).toMatchObject({ id: 'req-plan', tool: 'ExitPlanMode' });
    expect(app.permissionLog.at(-1)?.permission?.plan).toBe('# 引き継いだ計画\n');
    expect(app.manager.pendingQuestion(id)?.questions[0].question).toBe('どちらにしますか?');
    expect(app.attentions.length).toBe(before);
  });

  it('引き継いだ claude には initialize を送らずに起動済みにし、エフォートとコンテキストの使用量を聞き直す（聞けなくても起動済み）', async () => {
    const id = await previous(line.user('はじめ'), line.text('はい'));
    app.answers.set('get_settings', new Error('timeout'));
    app.host.hosted = [hosted(id)];
    await app.manager.adopt();
    attached(id)!.replayed();
    await app.waitFor('起動済み', () => app.manager.stateOf(id) === 'idle');
    expect(app.manager.snapshot(id).events.some((e) => e.type === 'ready')).toBe(true);
    expect(attached(id)!.requests().map((r) => r.request.subtype)).toEqual(['get_settings', 'get_context_usage']);
    // コンテキストは、次のターンの終わりを待たずに出す
    await app.waitFor('コンテキスト', () => app.manager.statusLine(id)?.context?.tokens === 12_000);
    // initialize の返事（/ の候補・モデル）は、前のアプリが受け取ったものを記録から戻す
    expect(app.manager.modelsOf(id)?.map((m) => m.value)).toEqual(['default']);
    expect(app.manager.commandsOf(id)).not.toBeNull();
    await expect(app.manager.configure(id, { model: null, effort: 'max', settingsFile: null })).rejects.toThrow('max');
  });

  it('claude を動かしたままアプリを終えるときは、送信中・順番待ちの発言を記録に残す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    const uuid = await app.send(id, '待っている発言');
    pipe.emit(stream.lifecycle(uuid, 'queued'));
    await app.waitFor('順番待ち', () => queue(id)[0]?.state === 'queued');
    app.manager.closeAll(false);
    const record = new SessionStore(join(app.userData, 'sessions.json')).get(id);
    expect(record?.unsent).toEqual([{ id: uuid, text: '待っている発言', pastes: [], images: 0, state: 'queued', shown: true }]);
  });

  it('引き継いだら、前のアプリが残した送信中・順番待ちの発言を戻す。前のアプリの頃に済んだもの・会話に出たものは外す', async () => {
    const id = await previous(line.user('はじめ'));
    const store = (app.manager as unknown as { store: SessionStore }).store;
    const prompt = (uuid: string, text: string, shown = true) => ({ id: uuid, text, pastes: [], images: 0, state: 'queued' as const, shown });
    store.update(id, {
      unsent: [prompt('u-done', '済んだ発言'), prompt('u-wait', '待っている発言'), prompt('u-event', sessionEventText(['abcdef12'], '子の作業が終わりました'), false)],
    });
    app.host.hosted = [hosted(id, { lastSeq: 3, firstSeq: 1 })];
    await app.manager.adopt();
    const pipe = attached(id)!;
    pipe.emit(stream.lifecycle('u-done', 'started'), 1);
    pipe.emit(stream.result(), 2);
    pipe.emit(stream.lifecycle('u-done', 'completed'), 3);
    pipe.replayed();
    await app.waitFor('戻した', () => queue(id).map((p) => p.id).join() === 'u-wait');
    expect(store.get(id)?.unsent).toBeNull();
    // 順番待ちが残っているので、作業中
    await app.waitFor('起動済み', () => app.manager.snapshot(id).events.some((e) => e.type === 'ready'));
    expect(app.manager.stateOf(id)).toBe('working');
    pipe.emit(stream.lifecycle('u-event', 'completed'));
    app.append(id, { ...line.user('待っている発言'), uuid: 'u-wait' });
    await app.waitFor('会話に出た', () => queue(id).length === 0);
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
  });

  it('引き継いだ claude が起動してから書いた行は、読み直した履歴でも今のもの（バックグラウンドのタスクを追う）として扱う', async () => {
    const startedAt = Date.now() - 10_000;
    const at = (ms: number) => new Date(startedAt + ms).toISOString();
    const id = await previous(
      { ...line.user('前の起動の発言'), timestamp: at(-5000) },
      { ...line.text('はい'), timestamp: at(-4000) },
      // ここから、今も動いている claude が書いた
      { ...line.user('サーバーを起動して'), timestamp: at(1000) },
      { ...line.toolUse('toolu_b1', 'Bash', { command: 'npm run dev', run_in_background: true }), timestamp: at(1500) },
      {
        ...line.toolResult('toolu_b1', 'Command running in background with ID: b1. Output is being written to: /nonexistent/b1.output', {
          toolUseResult: { backgroundTaskId: 'b1' },
        }),
        timestamp: at(2000),
      },
    );
    app.host.hosted = [hosted(id, { startedAt })];
    await app.manager.adopt();
    attached(id)!.replayed();
    await app.waitFor('バックグラウンド', () => app.manager.summary(id)?.backgroundTasks === 1);
  });

  it('読み直した会話ログの最後のつながり（bridge-session）を、今の Remote Control のつながりとして出す', async () => {
    const id = await previous(line.user('はじめ'), bridgeSession('cse_abc'));
    app.host.hosted = [hosted(id)];
    await app.manager.adopt();
    attached(id)!.replayed();
    await app.waitFor('つながり', () => app.manager.snapshot(id).events.some((e) => e.type === 'remote-control'));
    expect(app.manager.snapshot(id).events.filter((e) => e.type === 'remote-control')).toEqual([
      { type: 'remote-control', url: 'https://claude.ai/code/session_abc' },
    ]);
  });

  it('切れていた（空の bridge-session）なら、つながっていないと出す', async () => {
    const id = await previous(line.user('はじめ'), bridgeSession(''));
    app.host.hosted = [hosted(id)];
    await app.manager.adopt();
    attached(id)!.replayed();
    await app.waitFor('つながり', () => app.manager.snapshot(id).events.some((e) => e.type === 'remote-control'));
    expect(app.manager.snapshot(id).events.filter((e) => e.type === 'remote-control')).toEqual([{ type: 'remote-control', url: null }]);
  });

  it('前のアプリが分かっていた権限モードを引き継ぐ。Claude Code が今のモードを知らせたら、そちらにする', async () => {
    const launched = app.create({ mode: 'acceptEdits' });
    const told = app.create({ mode: 'manual' });
    await app.ready(told.id);
    told.pipe.emit(stream.status('plan'));
    await app.waitFor('今のモード', () => app.manager.modeOf(told.id) === 'plan');
    for (const { id, pipe } of [launched, told]) {
      pipe.exit(0);
      await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    }
    app.host.hosted = [hosted(launched.id), hosted(told.id)];
    await app.manager.adopt();
    // 引き継いだ claude はモードを変えずに動き続けている。戻さないと manual 扱いになり、そのあとに始める子の上限が下がる
    expect(app.manager.modeOf(launched.id)).toBe('acceptEdits');
    expect(app.manager.modeOf(told.id)).toBe('plan');
    // 控えに残っている今のモード（status）があれば、それを使う
    app.dispose();
    app = new ScriptedApp();
    const again = app.create({ mode: 'acceptEdits' });
    await app.ready(again.id);
    again.pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(again.id) === 'exited');
    const status = { seq: 3, line: JSON.stringify(stream.status('bypassPermissions')) };
    app.host.hosted = [hosted(again.id, { lastSeq: 9, firstSeq: 8, retained: [status] })];
    await app.manager.adopt();
    await app.waitFor('今のモード', () => app.manager.modeOf(again.id) === 'bypassPermissions');
  });
});

describe('closeAll', () => {
  it('アプリの終了では claude を止めずに見るのをやめる（次のアプリが引き継ぐ）。2 回目は何もしない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.manager.closeAll(false);
    expect(pipe.detached).toBe(true);
    expect(pipe.kills).toEqual([]);
    app.manager.closeAll(true);
    expect(pipe.kills).toEqual([]);
  });
});
