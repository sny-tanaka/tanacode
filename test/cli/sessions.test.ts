import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AskQuestion } from '@shared/screen';
import { wakeupText } from '@shared/scheduled';
import { SESSION_TOOLS, parentMessageText, sessionEventText, sessionToolId } from '@shared/session-tools';
import { McpBridge, textResult } from '../../src/main/mcp-bridge';
import { ScheduledMessages } from '../../src/main/scheduled-messages';
import { SessionsControl } from '../../src/main/sessions-control';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion, sleep } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、セッションの MCP サーバー（中継）を確かめる。
// アプリと同じ起動の引数（--mcp-config の timeout を含む・--allowedTools・--settings の PreToolUse のフック）で起動し、
// 中継（src/main/sessions-mcp.ts をビルドしたもの）が、アプリの代わりのソケットまでツールの呼び出しを運ぶか。
// - 読むだけのツールと、子への指示・質問への回答・役目を終えた子の片付け・自分への予約・人への報告は、許可の確認なしに通る / 子の起動と中断は、許可の確認が出る
// - 子セッションの起動は、bypassPermissions でも許可の確認が出る（フックが ask を返す）
// - 子が出した AskUserQuestion に、親（SessionsControl の answer_question）が答えられる
// - 子が出した許可の確認に、親（SessionsControl の answer_permission）が答えられる。stream-json の can_use_tool の、
//   ツールの入力の全文を読める。許すと動き、許可は覚えない（次の確認が出る）。断ると動かず、理由が確認への答えとして子に届き、子は続きを始める。
//   歯止め（ブランチを消す操作）の確認にも答えられる。親が読んだあとで別の確認に変わっていたら、答えない
// - 役目を終えた worktree の子を、親（SessionsControl の end_session）が片付けられる。作業中の子は断り、
//   裏のタスクの完了待ちの子は、Claude Code と一緒に裏の Bash も止めて、アーカイブし、worktree を消す（未追跡のファイルは控えに残す）
// - 親からの指示（囲み＋複数行の本文の貼り付け）は、会話ログから「親セッションからの指示」として読める。子の知らせと予約の知らせは「Claude への知らせ」
// - 自分への予約を重ねようとすると（本物の SessionsControl と ScheduledMessages で）、入らずに、前の予約が Claude に届く。
//   Claude（モック）がそれを読んで、前の予約を取り消して入れ直せる。even_if_scheduled: true を付けると重ねて入る

const SESSIONS = 'ほかのセッションを扱ってください';
const ASK = '子の質問の確認をしてください';
const CHILD_QUESTION: AskQuestion = {
  question: 'どちらの方式で作りますか?',
  header: '方式',
  multiSelect: false,
  options: [
    { label: 'A 案', description: '速い' },
    { label: 'B 案', description: '確実' },
  ],
};
// 子が、質問を 1 問ずつ、別々の AskUserQuestion で続けて出す
const ASK_TWICE = '2 つのことを順に確認してください';
const SECOND_QUESTION: AskQuestion = {
  question: 'テストも書きますか?',
  header: 'テスト',
  multiSelect: false,
  options: [
    { label: '書く', description: '単体テストを足す' },
    { label: '書かない', description: 'あとで足す' },
  ],
};
// 子の質問に、親が長い指示（自由記述）で答える
const ASK_LONG = '長い答えの確認をしてください';
// 番号付きの項目が続く、複数行の自由記述。stream-json では、改行もそのまま答えとして届く
const LONG_OTHER = [
  '【保留】方針はまだ確定しない。がっつり進める前に、使い捨てのモックで見た目を確かめる。',
  ...Array.from({ length: 30 }, (_, i) => `${i + 1}. 手順 ${i + 1}: 本実装のファイルは編集せず、新しい一時ファイルに、既存の部品を組み合わせた見た目を直書きで置く。`),
].join('\n');
const BYPASS = 'バイパスのモードで扱ってください';
const PERMIT = '許可の確認の確かめをしてください';
// 画面に収まらない長さのコマンド（全文を読めるかを見る）
const LONG_COMMAND = `echo ${'x'.repeat(600)} > /dev/null && mkdir made-1`;
const DENY_REASON = 'made-2 は作らずに、次へ進んでください';
const END = '裏でサーバーを動かしてください';
// 裏で動かし続ける Bash（ほかのテストの sleep と見分けられる秒数にする）
const END_COMMAND = 'sleep 7411';
const WAKE_TWICE = '見回りの予約を入れ直してください';
const OLD_WAKEUP = '子を見に行く（古い文面）';
const NEW_WAKEUP = '子を見に行く（新しい文面）';
const PARENT = '11111111-0000-4000-8000-000000000001';
const CHILD = '22222222-0000-4000-8000-000000000002';

const version = claudeVersion();

const call = (id: string, name: string, input: Record<string, unknown> = {}): Block[] => [{ type: 'tool_use', id, name: sessionToolId(name), input }];
const say = (text: string): Block[] => [{ type: 'text', text }];

describe(`Claude Code ${version} とセッションの MCP`, () => {
  let api: MockApi;
  let script: string;
  let bridge: McpBridge;
  let socketDir: string;
  let socketPath: string;
  // アプリに届いた呼び出し
  const calls: { session: string; tool: string; args: Record<string, unknown> }[] = [];
  // このセッションからの呼び出しは、本物の SessionsControl で扱う（予約を重ねようとしたときの確かめ）
  let routed: { session: string; control: SessionsControl } | null = null;
  const runs: ClaudeRun[] = [];

  const resultOf = (run: ClaudeRun, toolUseId: string): unknown => {
    for (const entry of run.entries) {
      const content = entry.type === 'user' ? (entry as { message?: { content?: unknown } }).message?.content : null;
      if (!Array.isArray(content)) continue;
      const hit = content.find((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
      if (hit) return hit;
    }
    return undefined;
  };
  const replied = (run: ClaudeRun, text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);

  beforeAll(async () => {
    script = await buildRelay('sessions-mcp');
    socketDir = mkdtempSync(join(tmpdir(), 'tanacode-sessions-'));
    socketPath = join(socketDir, 'sessions.sock');
    bridge = new McpBridge(socketPath, async (session, tool, args) => {
      if (routed?.session === session) return routed.control.handle(session, tool, args);
      calls.push({ session, tool, args });
      return textResult(JSON.stringify({ tool, note: `${tool} をしました` }));
    });
    await bridge.start();
    api = new MockApi();
    // 許可の確認が続けて出ても見分けられるよう、応答を少し遅らせる
    api.conversations = [
      {
        match: SESSIONS,
        delayMs: 1000,
        steps: [
          call('toolu_list', 'list_sessions'),
          call('toolu_send', 'send_message', { session_id: CHILD, message: 'テストも書いて' }),
          call('toolu_answer', 'answer_question', { session_id: CHILD, question: 'どちら?', choices: ['A 案'] }),
          call('toolu_end', 'end_session', { session_id: CHILD }),
          call('toolu_wake', 'schedule_wakeup', { message: '子を見に行く', in_minutes: 5 }),
          call('toolu_wakes', 'list_wakeups'),
          call('toolu_unwake', 'cancel_wakeup', { id: '0123456789abcdef' }),
          call('toolu_report', 'report_result', { message: '子を片付けました。' }),
          call('toolu_stop', 'stop_session', { session_id: CHILD }),
          call('toolu_start', 'start_session', { prompt: '登録画面を作って', worktree: false }),
          say('扱いました'),
          say('親からの指示を受け取りました'),
          say('長い指示を受け取りました'),
          say('子の知らせを受け取りました'),
          say('予約の知らせを受け取りました'),
          say('人の発言に答えました'),
          say('あとから届いた親の指示に答えました'),
        ],
      },
      {
        match: BYPASS,
        delayMs: 1000,
        steps: [call('toolu_bp_send', 'send_message', { session_id: CHILD, message: '続けて' }), call('toolu_bp_start', 'start_session', { prompt: '別の作業', worktree: true }), say('バイパスで扱いました')],
      },
      {
        match: ASK,
        delayMs: 500,
        steps: [[{ type: 'tool_use', id: 'toolu_child_ask', name: 'AskUserQuestion', input: { questions: [CHILD_QUESTION] } }], say('B 案で進めます')],
      },
      {
        match: ASK_TWICE,
        delayMs: 500,
        steps: [
          [{ type: 'tool_use', id: 'toolu_child_ask_1', name: 'AskUserQuestion', input: { questions: [CHILD_QUESTION] } }],
          [{ type: 'tool_use', id: 'toolu_child_ask_2', name: 'AskUserQuestion', input: { questions: [SECOND_QUESTION] } }],
          say('A 案で、テストも書きます'),
        ],
      },
      {
        match: ASK_LONG,
        delayMs: 500,
        steps: [
          [{ type: 'tool_use', id: 'toolu_child_ask_long', name: 'AskUserQuestion', input: { questions: [CHILD_QUESTION] } }],
          say('長い答えを受け取りました'),
        ],
      },
      {
        match: PERMIT,
        delayMs: 300,
        steps: [
          [{ type: 'tool_use', id: 'toolu_pm1', name: 'Bash', input: { command: LONG_COMMAND, description: '一つめ' } }],
          [{ type: 'tool_use', id: 'toolu_pm2', name: 'Bash', input: { command: 'mkdir made-2', description: '二つめ' } }],
          // 断ったあと、親からの理由が届いてからの続き
          [{ type: 'tool_use', id: 'toolu_pm3', name: 'Bash', input: { command: 'git branch -D no-such-branch', description: 'ブランチを消す' } }],
          [{ type: 'tool_use', id: 'toolu_pm4', name: 'Bash', input: { command: 'mkdir made-4', description: '四つめ' } }],
          [{ type: 'tool_use', id: 'toolu_pm5', name: 'Bash', input: { command: 'mkdir made-5', description: '五つめ' } }],
          say('許可の確かめを終えました'),
        ],
      },
      {
        match: END,
        // 送ってから返事までを、作業中として見られるように遅らせる（sleep は、許可の確認なしに通る）
        delayMs: 3000,
        steps: [[{ type: 'tool_use', id: 'toolu_end_bg', name: 'Bash', input: { command: END_COMMAND, description: 'サーバーを起動', run_in_background: true } }], say('裏で動かしました')],
      },
      {
        match: WAKE_TWICE,
        steps: [
          call('toolu_wake_1', 'schedule_wakeup', { message: OLD_WAKEUP, in_minutes: 5 }),
          call('toolu_wake_2', 'schedule_wakeup', { message: NEW_WAKEUP, in_minutes: 30 }),
          // 2 番目の応答は、届いた結果を読んで決める（api.intercept。前の予約が届いていれば、それを取り消す）
          say('前の予約が届きませんでした'),
          call('toolu_wake_3', 'schedule_wakeup', { message: NEW_WAKEUP, in_minutes: 30 }),
          call('toolu_wake_4', 'schedule_wakeup', { message: 'ビルドを見る', in_minutes: 10 }),
          call('toolu_wake_5', 'schedule_wakeup', { message: 'ビルドを見る', in_minutes: 10, even_if_scheduled: true }),
          say('予約を確かめました'),
        ],
      },
    ];
  });

  afterAll(async () => {
    for (const run of runs) await run.stop();
    await api?.stop();
    bridge?.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  const open = async (options: { mode?: 'bypassPermissions' } = {}) => {
    const run = new ClaudeRun(await api.start(), {
      sessions: { command: process.execPath, script, socketPath, version: 'test' },
      ...(options.mode ? { mode: options.mode, settings: { skipDangerousModePermissionPrompt: true } } : {}),
    });
    runs.push(run);
    await run.open();
    return run;
  };

  describe('ふつうの権限モード', () => {
    let run: ClaudeRun;
    beforeAll(async () => {
      run = await open();
    });

    it('ツールの一覧が Claude に渡り、読むだけのツールは許可の確認なしにアプリまで届く', async () => {
      await run.send(SESSIONS);
      await run.waitUntil('一覧の結果', () => resultOf(run, 'toolu_list'));
      for (const tool of SESSION_TOOLS) expect(api.offeredTools(), tool.name).toContain(sessionToolId(tool.name));
      expect(calls[0]).toEqual({ session: run.sessionId, tool: 'list_sessions', args: {} });
    });

    it('子への指示・質問への回答・子の片付け・自分への予約・人への報告・子の中断は確認なしに届き、子の起動は許可の確認を通る', async () => {
      // 確認が出ていれば、答えないかぎりここで止まる
      await run.waitUntil('報告の結果', () => resultOf(run, 'toolu_report'));
      expect(calls[1]).toEqual({ session: run.sessionId, tool: 'send_message', args: { session_id: CHILD, message: 'テストも書いて' } });
      expect(calls[2]).toMatchObject({ tool: 'answer_question', args: { choices: ['A 案'] } });
      expect(calls[3]).toEqual({ session: run.sessionId, tool: 'end_session', args: { session_id: CHILD } });
      expect(calls.slice(4).map((c) => [c.tool, c.args])).toEqual([
        ['schedule_wakeup', { message: '子を見に行く', in_minutes: 5 }],
        ['list_wakeups', {}],
        ['cancel_wakeup', { id: '0123456789abcdef' }],
        ['report_result', { message: '子を片付けました。' }],
      ]);
      // 中断は、ツールの許可の既定が常に許可なので、確認なしに届く
      await run.waitUntil('中断の結果', () => resultOf(run, 'toolu_stop'));
      expect(calls[8]).toMatchObject({ tool: 'stop_session' });
      const start = await run.permission('起動の許可の確認');
      expect(start.tool).toBe(sessionToolId('start_session'));
      run.replyPermission(start, { kind: 'allow' });
      await run.waitUntil('返事', replied(run, '扱いました'));
      expect(calls[9]).toMatchObject({ tool: 'start_session', args: { prompt: '登録画面を作って', worktree: false } });
    });

    it('親からの指示（複数行）は、会話ログから親の ID と本文の発言として読める。順番待ちにも本文だけを出す', async () => {
      await run.manager.submit(run.sessionId!, parentMessageText(PARENT, '1 行目\n2 行目'));
      await run.waitUntil('親からの指示の返事', replied(run, '親からの指示を受け取りました'));
      const prompt = run.chatEvents.find((e) => e.type === 'user' && e.parent === PARENT);
      expect(prompt).toMatchObject({ type: 'user', text: '1 行目\n2 行目', parent: PARENT });
      expect(run.queue.some((q) => q.includes('tanacode-parent-message'))).toBe(false);
    });

    it('親からの長い指示（40 行）も、親の ID を持つ発言として読める', async () => {
      // 人の発言に見えると、子が作業を終えても、親に知らせが届かない。
      // ログインして使う Claude Code は、複数行の貼り付けを、目印のタグごと <pasted_content> の囲みに入れて会話ログに残す
      // （2026-10-12 の実際の会話ログで、複数行の指示 5 件すべて）。モックの API で動かすここでは囲みが付かないので、
      // 囲みの付いた形は test/sessions-mcp.test.ts と test/chat-transcript.test.ts が確かめる。ここは、長い指示がそのまま読めることだけを見る
      const body = ['長い指示です', ...Array.from({ length: 40 }, (_, i) => `${i + 1} 行目: 目的・背景・終わりの条件を書いた、子セッションへの指示の本文`)].join('\n');
      await run.manager.submit(run.sessionId!, parentMessageText(PARENT, body));
      await run.waitUntil('長い指示の返事', replied(run, '長い指示を受け取りました'));
      const prompt = run.chatEvents.find((e) => e.type === 'user' && e.text.startsWith('長い指示です'));
      expect(prompt).toMatchObject({ type: 'user', text: body, parent: PARENT });
    });

    it('子の知らせは「Claude への知らせ」として読め、Claude は続きを始める', async () => {
      await run.manager.submit(run.sessionId!, sessionEventText([CHILD], '子セッション「A」の作業が終わりました。'));
      await run.waitUntil('知らせの返事', replied(run, '子の知らせを受け取りました'));
      expect(run.chatEvents.find((e) => e.type === 'notice' && e.sessions?.includes(CHILD))).toMatchObject({ text: '子セッション「A」の作業が終わりました。' });
    });

    it('自分への予約の知らせは「Claude の予約の時刻になりました」の知らせとして読め、Claude は続きを始める', async () => {
      // 予約は時刻になると、アプリ（scheduled-messages.ts）がこの形で打つ。本文が複数行でも、知らせのまま
      await run.manager.submit(run.sessionId!, wakeupText('子の状態を get_session で確かめる\n終わっていなければ、次の予約を入れる'));
      await run.waitUntil('予約の知らせの返事', replied(run, '予約の知らせを受け取りました'));
      expect(run.chatEvents.find((e) => e.type === 'notice' && e.text === 'Claude の予約の時刻になりました')).toMatchObject({
        detail: '子の状態を get_session で確かめる\n終わっていなければ、次の予約を入れる',
      });
      // 人の発言としては出さない（順番待ちにも出さない）
      expect(run.chatEvents.some((e) => e.type === 'user' && e.text.includes('tanacode-wakeup'))).toBe(false);
      expect(run.queue.some((q) => q.includes('tanacode-wakeup'))).toBe(false);
    });

    it('作業中に頼んだ親の指示（手が空くのを待つ送り方）は、ターンが終わってから送る', async () => {
      const id = run.sessionId!;
      await run.manager.submit(id, '人の発言です');
      const waiting = run.manager.submitWhenReady(id, parentMessageText(PARENT, 'あとから届いた指示'), 30_000);
      await waiting;
      await run.waitUntil('親の指示の返事', replied(run, 'あとから届いた親の指示に答えました'));
      const index = (match: (e: (typeof run.chatEvents)[number]) => boolean) => run.chatEvents.findIndex(match);
      const human = index((e) => e.type === 'user' && e.text === '人の発言です');
      const parent = index((e) => e.type === 'user' && e.parent === PARENT && e.text === 'あとから届いた指示');
      const turnEnd = run.chatEvents.findIndex((e, i) => i > human && e.type === 'turn-end');
      expect(human).toBeGreaterThan(-1);
      expect(turnEnd).toBeGreaterThan(human);
      expect(parent).toBeGreaterThan(turnEnd);
    });

    it('子の権限モードの上限にする親のモードは、起動の引数で渡したもの', () => {
      expect(run.manager.modeOf(run.sessionId!)).toBe('manual');
    });
  });

  describe('子の質問に親が答える', () => {
    let child: ClaudeRun;
    let control: SessionsControl;
    const parentId = randomUUID();

    beforeAll(async () => {
      child = await open();
      // 親の記録を足し、子にする（親の Claude Code は動かさない。ツールは SessionsControl に直に頼む）
      const now = Date.now();
      child.manager['store'].add({ id: parentId, claudeSessionId: randomUUID(), cwd: child.cwd, title: '取りまとめ', titlePriority: 4, archived: false, createdAt: now, updatedAt: now });
      child.manager['store'].update(child.sessionId!, { parentId });
      control = new SessionsControl({ host: child.manager, enabled: () => true, archive: (id, options) => child.manager.archive(id, options), home: child.home, notifyDelayMs: 10 });
    });

    afterAll(() => control?.dispose());

    it('子が出した AskUserQuestion を、親が get_session で読み、answer_question で答えると、子が続きを始める', async () => {
      await child.send(ASK);
      const question = await child.question('子の質問');
      const textOf = (result: { content: { type: string; text?: string }[] }) => (result.content[0] as { text: string }).text;
      const got = JSON.parse(textOf(await control.handle(parentId, 'get_session', { session_id: child.sessionId }))) as {
        state: string;
        question: { title: string; options: { label: string }[] };
      };
      expect(got.state).toBe('question');
      expect(got.question.options.map((o) => o.label)).toEqual(['A 案', 'B 案']);
      const answered = await control.handle(parentId, 'answer_question', { session_id: child.sessionId, question: got.question.title, choices: ['B 案'] });
      expect(answered.isError, textOf(answered)).toBeUndefined();
      await child.waitUntil('子の返事', replied(child, 'B 案で進めます'));
      const result = child.chatEvents.find((e) => e.type === 'tool-result' && e.id === 'toolu_child_ask');
      expect(result).toMatchObject({ answers: [{ question: CHILD_QUESTION.question, answer: 'B 案' }] });
      expect(question.questions[0].question).toContain('どちらの方式');
    });
  });

  // 台本は、会話のはじめの発言で選ばれるので、別の子で確かめる
  describe('子が質問を 1 問ずつ続けて出す', () => {
    let child: ClaudeRun;
    let control: SessionsControl;
    const parentId = randomUUID();

    beforeAll(async () => {
      child = await open();
      const now = Date.now();
      child.manager['store'].add({ id: parentId, claudeSessionId: randomUUID(), cwd: child.cwd, title: '取りまとめ', titlePriority: 4, archived: false, createdAt: now, updatedAt: now });
      child.manager['store'].update(child.sessionId!, { parentId });
      control = new SessionsControl({ host: child.manager, enabled: () => true, archive: (id, options) => child.manager.archive(id, options), home: child.home, notifyDelayMs: 10 });
    });

    afterAll(() => control?.dispose());

    it('子が質問を 1 問ずつ続けて出すとき、1 問めに答えた結果に、2 問めが入って返る（親が 1 問答えて離れない）', async () => {
      const textOf = (result: { content: { type: string; text?: string }[] }) => (result.content[0] as { text: string }).text;
      await child.send(ASK_TWICE);
      const first = await child.question('子の 1 問め');
      const answered = await control.handle(parentId, 'answer_question', { session_id: child.sessionId, question: first.questions[0].question, choices: ['A 案'] });
      expect(answered.isError, textOf(answered)).toBeUndefined();
      // 答えた直後の子は作業中で、2 問めは、次の応答（別の AskUserQuestion）で出る。その 2 問めが、同じ結果に入っている
      const result = JSON.parse(textOf(answered)) as { answered: boolean; state: string; next_question?: { title: string; options: { label: string }[] }; note?: string };
      expect(result).toMatchObject({ answered: true, state: 'question' });
      expect(result.next_question?.title).toContain('テストも書きますか');
      expect(result.next_question?.options.map((o) => o.label)).toEqual(['書く', '書かない']);
      expect(result.note).toContain('next_question');
      // 2 問めにも答えると、子が続きを始める。次の質問は無い
      const second = await control.handle(parentId, 'answer_question', { session_id: child.sessionId, question: result.next_question!.title, choices: ['書く'] });
      expect(second.isError, textOf(second)).toBeUndefined();
      expect((JSON.parse(textOf(second)) as { next_question?: unknown }).next_question).toBeUndefined();
      await child.waitUntil('子の返事', replied(child, 'A 案で、テストも書きます'));
      expect(child.chatEvents.find((e) => e.type === 'tool-result' && e.id === 'toolu_child_ask_2')).toMatchObject({ answers: [{ question: SECOND_QUESTION.question, answer: '書く' }] });
    });
  });

  describe('子の質問に親が長い指示で答える', () => {
    let child: ClaudeRun;
    let control: SessionsControl;
    const parentId = randomUUID();
    const textOf = (result: { content: { type: string; text?: string }[] }) => (result.content[0] as { text: string }).text;
    const answerOf = (toolUseId: string) => () => {
      const result = child.chatEvents.find((e) => e.type === 'tool-result' && e.id === toolUseId);
      return result?.type === 'tool-result' ? result.answers?.[0]?.answer : undefined;
    };
    beforeAll(async () => {
      child = await open();
      const now = Date.now();
      child.manager['store'].add({ id: parentId, claudeSessionId: randomUUID(), cwd: child.cwd, title: '取りまとめ', titlePriority: 4, archived: false, createdAt: now, updatedAt: now });
      child.manager['store'].update(child.sessionId!, { parentId });
      control = new SessionsControl({ host: child.manager, enabled: () => true, archive: (id, options) => child.manager.archive(id, options), home: child.home, notifyDelayMs: 10 });
    });

    afterAll(() => control?.dispose());

    it('番号付きの項目が続く複数行の自由記述で答えると、そのまま子に届く', async () => {
      await child.send(ASK_LONG);
      await child.question('子の質問');
      const answered = await control.handle(parentId, 'answer_question', { session_id: child.sessionId, question: CHILD_QUESTION.question, other: LONG_OTHER });
      expect(answered.isError, textOf(answered)).toBeUndefined();
      expect(await child.waitUntil('子が受け取った答え', answerOf('toolu_child_ask_long'))).toBe(LONG_OTHER);
      await child.waitUntil('子の返事', replied(child, '長い答えを受け取りました'));
    });
  });

  describe('子の許可の確認に親が答える', () => {
    let child: ClaudeRun;
    let control: SessionsControl;
    const parentId = randomUUID();
    type View = { id: string; title: string; description?: string; reason?: string; tool?: string; input?: { command?: string }; can_allow: boolean; cannot_allow_reason?: string; can_deny: boolean };
    const textOf = (result: { content: { type: string; text?: string }[] }) => (result.content[0] as { text: string }).text;
    const answer = (args: Record<string, unknown>) => control.handle(parentId, 'answer_permission', { session_id: child.sessionId, ...args });
    // 許可の確認が出て、親が get_session で command の確認として読めるまで待つ
    const prompt = async (command: string): Promise<View> => {
      await child.waitUntil(`許可の確認（${command.slice(0, 20)}）`, () => child.manager.pendingPermission(child.sessionId!)?.input.command === command);
      const got = JSON.parse(textOf(await control.handle(parentId, 'get_session', { session_id: child.sessionId }))) as { permission?: View };
      expect(got.permission?.input?.command).toBe(command);
      return got.permission!;
    };
    const done = (toolUseId: string) => () => resultOf(child, toolUseId);

    beforeAll(async () => {
      child = await open();
      // 親の記録を足し、子にする（親の Claude Code は動かさない。ツールは SessionsControl に直に頼む）
      const now = Date.now();
      child.manager['store'].add({ id: parentId, claudeSessionId: randomUUID(), cwd: child.cwd, title: '取りまとめ', titlePriority: 4, archived: false, createdAt: now, updatedAt: now });
      child.manager['store'].update(child.sessionId!, { parentId });
      // 親は動かしていないので、親の権限モードだけ auto と答えさせる（manual・plan の親は許せない）
      const manager = child.manager;
      const host = new Proxy(manager, {
        get: (target, key) => (key === 'modeOf' ? (id: string) => (id === parentId ? 'auto' : target.modeOf(id)) : Reflect.get(target, key, target)),
      });
      control = new SessionsControl({ host, enabled: () => true, archive: (id, options) => manager.archive(id, options), home: child.home, notifyDelayMs: 10 });
    });

    afterAll(() => control?.dispose());

    it('ツールの入力の全文を読んで許すと、子が動く。許可は覚えないので、次の確認が出る', async () => {
      await child.send(PERMIT);
      const permission = await prompt(LONG_COMMAND);
      // 画面の文は途中までだが、フックの入力は全文
      expect(permission).toMatchObject({ tool: 'Bash', can_allow: true, can_deny: true });
      expect(permission.input?.command).toBe(LONG_COMMAND);
      const result = await answer({ permission_id: permission.id, decision: 'allow' });
      expect(result.isError, textOf(result)).toBeUndefined();
      await child.waitUntil('一つめの結果', done('toolu_pm1'));
      expect(existsSync(join(child.cwd, 'made-1'))).toBe(true);
      // 「次から聞かない」を選んでいれば、同じ mkdir の確認は出ない
      const next = await prompt('mkdir made-2');
      expect(next.id).not.toBe(permission.id);
    });

    it('断ると子は動かず、理由が確認への答えとして届いて、子が続きを始める', async () => {
      const permission = await prompt('mkdir made-2');
      const result = await answer({ permission_id: permission.id, decision: 'deny', reason: DENY_REASON });
      expect(result.isError, textOf(result)).toBeUndefined();
      // 理由は、断ったツールの結果として Claude に渡る（人の発言ではない）。受け取った子は、次の操作（歯止めの確認が出る）へ進む
      const denied = await child.waitUntil('断ったツールの結果', done('toolu_pm2'));
      expect(JSON.stringify(denied)).toContain(DENY_REASON);
      expect(child.chatEvents.some((e) => e.type === 'user' && e.text.includes(DENY_REASON))).toBe(false);
      expect(existsSync(join(child.cwd, 'made-2'))).toBe(false);
    });

    it('歯止め（ブランチを消す操作）の確認にも答えられる。選択肢は Yes と No だけ', async () => {
      const permission = await prompt('git branch -D no-such-branch');
      expect(permission.can_allow).toBe(true);
      expect([permission.title, permission.description, permission.reason].join('\n')).toContain('tanacode が確認を求めています');
      const result = await answer({ permission_id: permission.id, decision: 'allow' });
      expect(result.isError, textOf(result)).toBeUndefined();
      await child.waitUntil('ブランチを消す操作の結果', done('toolu_pm3'));
    });

    it('親が読んだあとで人が答えて、別の確認に変わっていたら、答えない', async () => {
      const first = await prompt('mkdir made-4');
      // 人が先に（カードで）答える
      child.replyPermission(await child.permission('四つめの確認'), { kind: 'allow' });
      await child.waitUntil('四つめの結果', done('toolu_pm4'));
      const second = await prompt('mkdir made-5');
      // 見出しも選択肢も同じ別の確認に、前の ID では答えられない
      const stale = await answer({ permission_id: first.id, decision: 'allow' });
      expect(stale.isError).toBe(true);
      expect(textOf(stale)).toContain('not the one you read');
      expect(existsSync(join(child.cwd, 'made-5'))).toBe(false);
      expect(child.manager.pendingPermission(child.sessionId!)?.id).toBe(second.id);
      // 読み直した ID なら答えられる
      const result = await answer({ permission_id: second.id, decision: 'allow' });
      expect(result.isError, textOf(result)).toBeUndefined();
      await child.waitUntil('返事', replied(child, '許可の確かめを終えました'));
      expect(existsSync(join(child.cwd, 'made-5'))).toBe(true);
    });
  });

  describe('役目を終えた子を親が終える', () => {
    let child: ClaudeRun;
    let control: SessionsControl;
    let path = '';
    let branch = '';
    const parentId = randomUUID();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: child.cwd, encoding: 'utf8' }).trim();
    const textOf = (result: { content: { type: string; text?: string }[] }) => (result.content[0] as { text: string }).text;
    const end = () => control.handle(parentId, 'end_session', { session_id: child.sessionId });
    const state = () => child.manager.stateOf(child.sessionId!);
    // 裏の Bash のプロセス（このテストが動かしたものだけ: 作業フォルダが、この worktree）
    const serverPids = () => {
      const pids = (() => {
        try {
          return execFileSync('pgrep', ['-f', END_COMMAND], { encoding: 'utf8' }).split('\n').filter(Boolean);
        } catch {
          return [];
        }
      })();
      return pids.filter((pid) => {
        try {
          return execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).includes(path);
        } catch {
          return false;
        }
      });
    };

    beforeAll(async () => {
      child = new ClaudeRun(await api.start(), { git: true, trusted: true, files: { 'a.txt': 'a\n' } });
      runs.push(child);
      await child.startInWorktree();
      path = child.summary()!.cwd;
      branch = child.summary()!.worktree!.branch;
      await child.waitUntil('準備の終わり', () => child.chatEvents.some((e) => e.type === 'ready'), 30_000);
      // 親の記録を足し、子にする（親の Claude Code は動かさない。ツールは SessionsControl に直に頼む）
      const now = Date.now();
      child.manager['store'].add({ id: parentId, claudeSessionId: randomUUID(), cwd: child.cwd, title: '取りまとめ', titlePriority: 4, archived: false, createdAt: now, updatedAt: now });
      child.manager['store'].update(child.sessionId!, { parentId });
      control = new SessionsControl({ host: child.manager, enabled: () => true, archive: (id, options) => child.manager.archive(id, options), home: child.home, notifyDelayMs: 10 });
    });

    afterAll(() => {
      control?.dispose();
      for (const pid of path ? serverPids() : []) process.kill(Number(pid));
    });

    it('作業中の子は断る（何も消さない）', async () => {
      await child.send(END);
      await child.waitUntil('作業中', () => state() === 'working');
      const working = await end();
      expect(working.isError).toBe(true);
      expect(textOf(working)).toContain('is working');
      expect(textOf(working)).toContain('stop_session');
      expect(child.summary()!.archived).toBe(false);
      expect(existsSync(path)).toBe(true);
    });

    it('裏のタスクの完了待ちの子を終えると、裏の Bash も止まり、アーカイブして worktree を消す。未追跡のファイルは控えに残る', async () => {
      await child.waitUntil('返事', replied(child, '裏で動かしました'));
      await child.waitUntil('裏のタスクの完了待ち', () => state() === 'background', 30_000);
      expect(serverPids().length).toBeGreaterThan(0);
      writeFileSync(join(path, 'note.txt'), 'メモ\n');
      const name = child.summary()!.worktree!.name;
      const result = await end();
      expect(result.isError, textOf(result)).toBeUndefined();
      const ended = JSON.parse(textOf(result)) as { note: string; worktree: Record<string, unknown>; stopped_background_tasks: unknown[] };
      expect(ended).toMatchObject({ session_id: child.sessionId, archived: true, already_archived: false });
      expect(ended.stopped_background_tasks).toEqual([{ kind: 'bash', name: 'サーバーを起動' }]);
      expect(ended.worktree).toMatchObject({
        name,
        branch,
        folder: 'removed',
        backup_ref: `refs/tanacode/backup/${name}`,
        branches: [{ name: branch, launched: true, current: true, deleted: true }],
      });
      // 一覧でアーカイブ済みになり、worktree のフォルダとブランチが消える
      expect(child.summary()).toMatchObject({ archived: true, running: false });
      expect(state()).toBe('archived');
      expect(existsSync(path)).toBe(false);
      expect(git('worktree', 'list')).not.toContain(path);
      expect(git('branch', '--list', branch)).toBe('');
      expect(git('show', `refs/tanacode/backup/${name}:note.txt`)).toBe('メモ');
      // 裏の Bash は、Claude Code が終わるときに止める
      for (let i = 0; i < 100 && serverPids().length > 0; i++) await sleep(100);
      expect(serverPids()).toEqual([]);
    });

    it('アーカイブ済みの子にもう一度呼ぶと、すでに片付いていることを返す', async () => {
      const result = await end();
      expect(result.isError, textOf(result)).toBeUndefined();
      expect(JSON.parse(textOf(result))).toMatchObject({ archived: true, already_archived: true, worktree: { folder: 'already_removed' } });
    });
  });

  describe('自分への予約を重ねようとしたとき（Issue #277）', () => {
    let run: ClaudeRun;
    let scheduled: ScheduledMessages;
    let control: SessionsControl;
    type Waiting = { scheduled: false; waiting: { id: string; text: string }[]; note: string };
    // ツールの結果の文（Claude Code が会話ログに書いたもの）。エラーかどうかも
    const resultText = (toolUseId: string): { text: string; error: boolean } => {
      const hit = resultOf(run, toolUseId) as { content?: string | { text?: string }[]; is_error?: boolean };
      const text = typeof hit.content === 'string' ? hit.content : (hit.content ?? []).map((b) => b.text ?? '').join('');
      return { text, error: hit.is_error === true };
    };

    beforeAll(async () => {
      run = await open();
      // 時刻を待つだけで送らない（start しない）。入った予約を数えるのに使う
      scheduled = new ScheduledMessages(join(run.root, 'scheduled-messages.json'), { stateOf: () => 'idle', open: async () => undefined, summary: () => undefined, submitWhenReady: () => new Promise<void>(() => undefined) }, () => undefined);
      control = new SessionsControl({ host: run.manager, enabled: () => true, archive: async () => null, home: run.home, scheduled: () => scheduled });
      routed = { session: run.sessionId!, control };
    });

    afterAll(() => {
      routed = null;
      api.intercept = null;
      control?.dispose();
      scheduled?.dispose();
    });

    it('2 回目は入らずに、前の予約（ID・時刻・本文）が Claude に届き、Claude はそれを取り消して入れ直せる。even_if_scheduled: true なら重ねて入る', async () => {
      // Claude（モック）は、2 回目の結果に前の予約が入っていれば、それを取り消す
      api.intercept = (_prompt, results, context) => {
        if (!context.includes(WAKE_TWICE)) return null;
        const parse = (text: string): Partial<Waiting> => {
          try {
            return JSON.parse(text) as Partial<Waiting>;
          } catch {
            return {};
          }
        };
        const old = results
          .map(parse)
          .find((r) => r.scheduled === false)
          ?.waiting?.find((m) => m.text === OLD_WAKEUP);
        return old ? call('toolu_unwake_old', 'cancel_wakeup', { id: old.id }) : null;
      };
      await run.send(WAKE_TWICE);
      await run.waitUntil('返事', replied(run, '予約を確かめました'));
      const first = JSON.parse(resultText('toolu_wake_1').text) as { id: string };
      // 2 回目: 入らずに、前の予約を返す（エラーにはしない）
      const second = resultText('toolu_wake_2');
      expect(second.error).toBe(false);
      const refused = JSON.parse(second.text) as Waiting;
      expect(refused).toMatchObject({ scheduled: false, waiting: [{ id: first.id, text: OLD_WAKEUP }] });
      expect(refused.note).toContain('even_if_scheduled: true');
      // その結果が、モデル（API）まで届いている
      expect(api.toolResults.some((r) => r.includes(first.id) && r.includes('Not scheduled'))).toBe(true);
      // 前の予約を取り消してから入れ直した
      expect(JSON.parse(resultText('toolu_unwake_old').text)).toEqual({ id: first.id, cancelled: true });
      const third = JSON.parse(resultText('toolu_wake_3').text) as { id: string };
      // 重ねようとすると、入れ直したものが返り、even_if_scheduled: true（中継を通って届く）を付けると入る
      expect(JSON.parse(resultText('toolu_wake_4').text)).toMatchObject({ scheduled: false, waiting: [{ id: third.id, text: NEW_WAKEUP }] });
      expect(JSON.parse(resultText('toolu_wake_5').text)).toHaveProperty('id');
      expect(scheduled.claudeWakeups(run.sessionId!).map((m) => m.text)).toEqual([NEW_WAKEUP, 'ビルドを見る']);
    });
  });

  describe('bypassPermissions', () => {
    let run: ClaudeRun;
    beforeAll(async () => {
      run = await open({ mode: 'bypassPermissions' });
    });

    it('子への指示は確認なしに通るが、子の起動はフックが確認を出させる。確認には、子も利用枠を使うことが出る', async () => {
      const before = calls.length;
      await run.send(BYPASS);
      await run.waitUntil('指示の結果', () => resultOf(run, 'toolu_bp_send'));
      expect(calls[before]).toMatchObject({ session: run.sessionId, tool: 'send_message' });
      const start = await run.permission('起動の許可の確認');
      expect(start.tool).toBe(sessionToolId('start_session'));
      expect(calls).toHaveLength(before + 1);
      expect([start.title, start.description, start.reason].join('\n')).toContain('利用枠');
      run.replyPermission(start, { kind: 'allow' });
      await run.waitUntil('返事', replied(run, 'バイパスで扱いました'));
      expect(calls[before + 1]).toMatchObject({ tool: 'start_session', args: { prompt: '別の作業', worktree: true } });
      expect(run.manager.modeOf(run.sessionId!)).toBe('bypassPermissions');
    });
  });
});
