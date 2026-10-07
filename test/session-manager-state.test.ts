import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptPath } from '../src/main/claude-session';
import { QUESTION } from './scenario';
import { fixtureScreen, line, ScriptedApp } from './helpers/scripted-claude';

// SessionManager の一覧・状態・読み取り（本物の claude なしで動かす。test/session-manager.test.ts の続き）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// バックグラウンドで動き続ける Bash を起動した、ターンの途中の行
const backgroundBash = (id: string) => [
  line.user('サーバーを起動して'),
  line.toolUse(`toolu_${id}`, 'Bash', { command: 'npm run dev', run_in_background: true }),
  line.toolResult(`toolu_${id}`, `Command running in background with ID: ${id}. Output is being written to: /nonexistent/${id}.output`, {
    toolUseResult: { backgroundTaskId: id },
  }),
];

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
    expect(app.manager.claudeSessionIds()).toEqual(new Set([parent.pty.arg('--session-id'), child.pty.arg('--session-id')]));
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
    app.append(a.id, line.user('やって'), line.text('しました'), line.turnEnd());
    app.append(b.id, line.user('やって'), line.text('しました'), line.turnEnd());
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
    app.append(id, line.user('はじめ'), line.text('はい'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
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
    app.append(id, { ...line.user('直して'), gitBranch: 'feature/a' }, { ...line.text('直します'), gitBranch: 'feature/b' }, { ...line.text('まだ'), gitBranch: 'feature/a' });
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
    expect(app.manager.screen('nope')).toBeNull();
    expect(app.manager.screenForView('nope')).toBeNull();
    expect(app.manager.activity('nope')).toBeNull();
    expect(app.manager.askedQuestions('nope')).toBeNull();
    expect(app.manager.modeOf('nope')).toBeNull();
    expect(app.manager.stateOf('nope')).toBeNull();
    expect(await app.manager.context('nope')).toEqual({ items: [] });
    expect(await app.manager.setMode('nope', 'auto')).toBe(false);
    expect(await app.manager.rewind('nope', 'はじめ')).toBe(false);
    expect(await app.manager.chooseIf('nope', { optionId: '1', key: 'enter' }, () => true)).toBe(false);
    await expect(app.manager.choose('nope', { optionId: '1', key: 'enter' })).resolves.toBeUndefined();
    // 知らないセッションへの操作は何もしない（失敗もしない）
    app.manager.write('nope', 'x');
    app.manager.interrupt('nope');
    app.manager.resize('nope', 80, 24);
    await app.manager.withdrawParentDraft('nope');
    await expect(app.manager.submit('nope', 'x')).resolves.toBeUndefined();
  });

  it('context: 動いている間はその場の集計、止めたあとは会話ログから集め直す', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('ログインを直して'), line.text('直しました'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    const live = await app.manager.context(id);
    expect(live.items.some((i) => i.kind === 'topic' && i.label.includes('ログインを直して'))).toBe(true);
    await app.manager.archive(id);
    expect(await app.manager.context(id)).toEqual(live);
  });
});

describe('状態（stateOf）と、一覧の状態の文言（liveSessions）', () => {
  const live = (title = '新しいセッション') => app.manager.liveSessions().find((s) => s.title === title)?.state;

  it('起動中 → 待機中 → 作業中 → 待機中。終わったら exited、アーカイブしたら archived で、liveSessions から外す', async () => {
    const { id, pty } = app.create();
    expect(app.manager.stateOf(id)).toBe('starting');
    expect(app.manager.liveSessions()).toEqual([{ title: '新しいセッション', state: '起動中' }]);
    await app.ready(id);
    expect(app.manager.stateOf(id)).toBe('idle');
    expect(live()).toBe('待機中');
    app.append(id, line.user('作業して'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    expect(live('作業して')).toBe('作業中');
    app.append(id, line.text('しました'), line.turnEnd());
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(app.manager.liveSessions()).toEqual([]);
    await app.manager.archive(id);
    expect(app.manager.stateOf(id)).toBe('archived');
  });

  it('送ったばかりで会話ログにまだ発言が出ていない間も、作業中として扱う', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    // Claude Code の代わりに、打った文字を入力欄に出す（出たら Enter が送られる）
    pty.onWrite = (data) => {
      if (data.includes('/clear')) setTimeout(() => pty.output(`${fixtureScreen('prompt')}\x1b[37;3H/clear`), 10);
    };
    await app.manager.submit(id, '/clear');
    expect(pty.typed.endsWith('/clear\r')).toBe(true);
    expect(app.manager.stateOf(id)).toBe('working');
  });

  it('バックグラウンドのタスクが動いている間: 作業中（バックグラウンド n 件）→ ターンが終わると完了待ち（background）', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, ...backgroundBash('b1'));
    await app.waitFor('バックグラウンドの数', () => app.manager.summary(id)?.backgroundTasks === 1);
    expect(live('サーバーを起動して')).toBe('作業中（バックグラウンド 1件）');
    app.append(id, line.text('起動しました'), line.turnEnd());
    await app.waitFor('完了待ち', () => app.manager.stateOf(id) === 'background');
    expect(live('サーバーを起動して')).toBe('バックグラウンド 1件の完了待ち');
    expect(app.manager.bashTasks(id).map((t) => [t.command, t.state])).toEqual([['npm run dev', 'running']]);
    expect(app.bashTasks.get(id)).toEqual(app.manager.bashTasks(id));
  });

  it('許可の確認・質問・操作できない画面は、それぞれの文言。質問は AskUserQuestion の入力が届くまで許可の確認として扱う', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.output(fixtureScreen('bash-permission'));
    await app.waitFor('許可の確認', () => app.manager.stateOf(id) === 'permission');
    expect(live()).toBe('実行の許可待ち');
    pty.output(fixtureScreen('question'));
    await app.waitFor('質問', () => app.manager.summary(id)?.attention === 'question');
    expect(live()).toBe('質問への回答待ち');
    // 画面は質問に見えても、AskUserQuestion の入力が無ければ、親が答えられる質問として見せない
    expect(app.manager.stateOf(id)).toBe('permission');
    expect(app.manager.askedQuestions(id)).toBeNull();
    // 質問の形でない入力は使わない
    app.manager.askQuestionsChanged(id, { questions: 'x' });
    expect(app.manager.askedQuestions(id)).toBeNull();
    app.manager.askQuestionsChanged(id, { questions: [QUESTION] });
    expect(app.manager.askedQuestions(id)?.map((q) => q.question)).toEqual([QUESTION.question]);
    expect(app.manager.stateOf(id)).toBe('question');
    pty.output('\x1b[H\x1b[2J何かの画面');
    await app.waitFor('操作待ち', () => live() === '操作待ち', 3000);
  });

  it('browserAskChanged: 頼んでいる間は一覧で「ブラウザでの操作待ち」。ターンが終わっても完了を知らせない。同じ知らせは繰り返さない', async () => {
    const { id } = app.create();
    await app.ready(id);
    const lists = app.sessionLists.length;
    app.manager.browserAskChanged(id, true);
    app.manager.browserAskChanged(id, true);
    expect(app.sessionLists.length).toBe(lists + 1);
    expect(app.manager.summary(id)?.attention).toBe('browser');
    expect(live()).toBe('ブラウザでの操作待ち');
    app.append(id, line.user('ログインして'), line.text('ブラウザで操作してください'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end') && app.manager.stateOf(id) === 'idle');
    await sleep(100);
    expect(app.turnsCompleted).toEqual([]);
    const before = app.sessionLists.length;
    app.manager.browserAskChanged(id, false);
    app.manager.browserAskChanged(id, false);
    expect(app.manager.summary(id)?.attention).toBeNull();
    expect(app.sessionLists.length).toBe(before + 1);
  });
});

describe('statusLine', () => {
  const info = (transcript: string | null) => ({
    model: { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    version: '2.1.292',
    context: null,
    rateLimits: null,
    costUsd: 0.1,
    transcriptPath: transcript,
    updatedAt: 1,
  });

  it('動いているセッションの statusLine だけを受け取り、画面に知らせる', async () => {
    app.manager.statusLineChanged('nope', info(null));
    expect(app.statusLineInfos.size).toBe(0);
    const { id } = app.create();
    app.manager.statusLineChanged(id, info(null));
    expect(app.manager.statusLine(id)).toEqual(info(null));
    expect(app.statusLineInfos.get(id)).toEqual(info(null));
  });

  it('/clear で会話ログが変わったら、新しい会話ログに乗り換える（会話の ID を記録し直し、チャットを空にする）', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('前の会話'), line.text('はい'), line.turnEnd());
    await app.waitFor('前の会話', () => app.events(id).some((e) => e.type === 'turn-end'));
    const next = '44444444-0000-4000-8000-000000000004';
    const file = transcriptPath(app.cwd, next);
    writeFileSync(file, `${JSON.stringify({ ...line.user('新しい会話'), sessionId: next, cwd: app.cwd })}\n`);
    app.manager.statusLineChanged(id, info(file));
    await app.waitFor('乗り換え', () => app.events(id).some((e) => e.type === 'reset'));
    expect(app.manager.transcriptOf(id)).toBe(file);
    await app.waitFor('新しい会話の発言', () => app.events(id).some((e) => e.type === 'user' && e.text === '新しい会話'));
    // 起動し直すと、新しい会話を再開する
    app.manager.restart(id);
    expect(app.pty(id).arg('--resume')).toBe(next);
  });
});

describe('送る・止める・大きさ', () => {
  it('write: 打った文字をそのまま送る。resize: pty と画面の大きさを変える', async () => {
    const { id, pty } = app.create();
    app.manager.write(id, 'abc');
    expect(pty.writes).toEqual(['abc']);
    app.manager.resize(id, 100, 30);
    expect(pty.resizes).toEqual([[100, 30]]);
    // 起動し直しても、同じ大きさで起動する
    app.manager.restart(id);
    expect(app.pty(id).request).toMatchObject({ cols: 100, rows: 30 });
  });

  it('interrupt: Esc を送り、打ち込んでいる途中の文字を、入力欄に戻った文字として見せるようにする', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    const text = '応答の前に中断します';
    pty.onWrite = (data) => {
      if (data.includes(text)) setTimeout(() => pty.output(fixtureScreen('interrupt-draft')), 10);
    };
    await app.manager.submit(id, text);
    // 送ったばかりの文字は、入力欄に残っていても書きかけとして見せない（チャットの入力欄に移さない）
    await app.waitFor('入力欄', () => app.manager.screen(id)?.draft === text);
    expect(app.manager.screenForView(id)?.draft).toBe('');
    app.manager.interrupt(id);
    expect(pty.writes.at(-1)).toBe('\x1b');
    expect(app.manager.screenForView(id)?.draft).toBe(text);
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

  it('順番待ち: 受け取られた発言（dequeue）を外す。画像つきの発言（content が配列）も文字で数える。知らせは人の発言として出さない', async () => {
    const { id } = app.create();
    await app.ready(id);
    const queue = () => {
      const last = [...app.events(id)].reverse().find((e) => e.type === 'queue');
      return last?.type === 'queue' ? last.prompts : null;
    };
    const op = (operation: string, content?: unknown) => ({ ...line.turnEnd(), type: 'queue-operation', subtype: undefined, operation, content });
    app.append(
      id,
      op('enqueue', [
        { type: 'image', source: {} },
        { type: 'text', text: '画像を見て' },
      ]),
      op('enqueue', '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>'),
      op('enqueue', 'あとで B'),
    );
    await app.waitFor('順番待ち', () => queue()?.length === 2);
    // 画像のブロックは文字にならない（文字のブロックだけを改行でつなぐ）
    expect(queue()?.map((t) => t.trim())).toEqual(['画像を見て', 'あとで B']);
    app.append(id, op('dequeue'));
    await app.waitFor('受け取り', () => queue()?.length === 1);
    expect(queue()).toEqual(['あとで B']);
    // 中身の読めないもの（文字でも配列でもない）は足さない。順番待ちに無いものを外しても変わらない
    app.append(id, op('enqueue', 42), op('remove', '無いもの'), op('remove', 'あとで B'));
    await app.waitFor('外す', () => queue()?.length === 0);
  });

  it('claude が終わったら、順番待ちを空にし、動いていたバックグラウンドのタスクを止まったことにする', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    app.append(id, ...backgroundBash('b2'), { ...line.turnEnd(), type: 'queue-operation', subtype: undefined, operation: 'enqueue', content: 'あとで' });
    await app.waitFor('順番待ち', () => app.events(id).some((e) => e.type === 'queue'));
    await app.waitFor('バックグラウンド', () => app.manager.summary(id)?.backgroundTasks === 1);
    pty.exit(0);
    await app.waitFor('終了', () => app.events(id).some((e) => e.type === 'process-exit'));
    const queues = app.events(id).filter((e) => e.type === 'queue');
    expect(queues.at(-1)).toEqual({ type: 'queue', prompts: [] });
    expect(app.manager.bashTasks(id).map((t) => t.state)).toEqual(['stopped']);
  });

  it('1M コンテキストは、起動時の表示で分かったら覚え、起動し直したあとも会話ログのモデル名に付ける', async () => {
    const { id } = app.create();
    // 起動時の枠に「(1M context)」が出ている
    app.pty(id).output(fixtureScreen('prompt').replace('Opus 5.5 · API Usage Billing', 'Opus 5.5 (1M context) · API Usage Billing'));
    await app.waitFor('起動', () => app.screens.get(id)?.ready === true);
    expect(app.screens.get(id)?.model).toBe('Opus 5.5 (1M context)');
    app.append(id, line.user('はじめ'), line.text('はい'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    app.manager.restart(id);
    // 起動し直したあとは、起動時の表示が出る前でも、会話ログのモデル名に 1M を付ける
    app.append(id, line.user('続き'), line.text('はい'));
    await app.waitFor('モデル', () => app.manager.screen(id)?.model === 'Opus 5.5 (1M context)');
    // エフォートだけ変えたときは、1M のまま
    app.manager.configure(id, { model: null, effort: 'high', settingsFile: null });
    expect(app.pty(id).arg('--effort')).toBe('high');
    await app.waitFor('モデル', () => app.manager.screen(id)?.model === 'Opus 5.5 (1M context)');
    // モデルを変えたら、1M かどうかは起動時の表示で分かり直す
    app.manager.configure(id, { model: 'sonnet', effort: null, settingsFile: null });
    app.append(id, line.text('変えました'));
    await app.waitFor('モデル', () => app.manager.screen(id)?.model === 'Opus 5.5');
  });

  it('会話ログのモデル ID を表示名にする（日付の付いた ID・小数点のある版も）', async () => {
    const { id } = app.create();
    await app.ready(id);
    const model = (name: string) => ({ ...line.text('はい'), message: { ...line.text('はい').message, model: name } });
    app.append(id, line.user('はじめ'), model('claude-opus-4-1-20250805'));
    await app.waitFor('モデル', () => app.manager.screen(id)?.model === 'Opus 4.1');
    app.append(id, model('claude-sonnet-5'));
    await app.waitFor('モデル', () => app.manager.screen(id)?.model === 'Sonnet 5');
    app.append(id, model('claude-fable-5-1'));
    await app.waitFor('モデル', () => app.manager.screen(id)?.model === 'Fable 5.1');
    // 読めない ID は使わない（前のまま）
    app.append(id, model('gpt-4'), line.user('次'));
    await app.waitFor('発言', () => app.events(id).some((e) => e.type === 'user' && e.text === '次'));
    expect(app.manager.screen(id)?.model).toBe('Fable 5.1');
  });

  it('日付の付いたモデル ID でも、小数点の無い版を取り違えない（claude-sonnet-5-20260101 は Sonnet 5）', async () => {
    const { id } = app.create();
    await app.ready(id);
    const model = (name: string) => ({ ...line.text('はい'), message: { ...line.text('はい').message, model: name } });
    app.append(id, line.user('はじめ'), model('claude-sonnet-5-20260101'));
    await app.waitFor('応答', () => app.events(id).some((e) => e.type === 'assistant-text'));
    await sleep(200);
    // 日付の先頭の数字（2）を、版の小数点以下と読まない
    expect(app.manager.screen(id)?.model).toBe('Sonnet 5');
  });

  it('会話ログの先頭に大きな行があっても、発言の行があれば --resume で再開する', async () => {
    const { id } = app.create();
    const file = app.transcript(id);
    mkdirSync(dirname(file), { recursive: true });
    // 読む区切り（256KB）を超える行のあとに発言がある
    writeFileSync(file, `${JSON.stringify({ type: 'summary', summary: 'x'.repeat(300 * 1024) })}\n${JSON.stringify({ ...line.user('はじめ') })}\n`);
    const conversation = app.pty(id).arg('--session-id');
    app.manager.restart(id);
    expect(app.pty(id).arg('--resume')).toBe(conversation);
  });

  it('会話ログに発言が無ければ、--resume できないので新しい会話の ID で始め直す', async () => {
    const { id } = app.create();
    const file = app.transcript(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ type: 'summary', summary: 'x'.repeat(300 * 1024) })}\n`);
    const conversation = app.pty(id).arg('--session-id');
    app.manager.restart(id);
    expect(app.pty(id).arg('--resume')).toBeNull();
    expect(app.pty(id).arg('--session-id')).not.toBe(conversation);
  });

  it('会話ログの、行として読めないもの（オブジェクトでない JSON）は読み飛ばす', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('はじめ'));
    appendFileSync(app.transcript(id), '42\n"文字"\n');
    app.append(id, line.text('はい'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    expect(app.events(id).filter((e) => e.type === 'user' || e.type === 'assistant-text').map((e) => ('text' in e ? e.text : ''))).toEqual(['はじめ', 'はい']);
  });

  it('AskUserQuestion: 会話ログの質問を、画面の質問として使う。答えが返ったら外す', async () => {
    const { id } = app.create();
    await app.ready(id);
    app.append(id, line.user('聞いて'), line.toolUse('toolu_ask', 'AskUserQuestion', { questions: [QUESTION] }));
    await app.waitFor('質問', () => app.manager.askedQuestions(id) !== null);
    expect(app.manager.askedQuestions(id)?.map((q) => [q.question, q.options.map((o) => o.label)])).toEqual([[QUESTION.question, ['です・ます', 'だ・である']]]);
    app.append(id, line.toolResult('toolu_ask', 'User has answered your questions: です・ます'));
    await app.waitFor('答え', () => app.manager.askedQuestions(id) === null);
  });
});

describe('画面の知らせ', () => {
  it('作業中の表示（タイマー・トークン数）を読んで知らせ、消えたら null を知らせる', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    pty.output(`${fixtureScreen('prompt')}\x1b[33;1H✻ Working… (5s · ↓ 1.2k tokens)`);
    await app.waitFor('作業中の表示', () => !!app.activities.get(id));
    expect(app.activities.get(id)).toEqual({ phase: 'writing', elapsed: '5s', tokens: '1.2k' });
    expect(app.manager.activity(id)).toEqual(app.activities.get(id));
    pty.output(fixtureScreen('prompt'));
    await app.waitFor('作業の終わり', () => app.activities.get(id) === null);
    expect(app.manager.activity(id)).toBeNull();
  });

  it('modeOf: 画面からモードを読めないうちは、アプリが決めたモード（無ければ manual）', () => {
    const a = app.create();
    const b = app.create({ mode: 'plan' });
    expect(app.manager.modeOf(a.id)).toBe('manual');
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
