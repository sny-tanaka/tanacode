import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AskQuestion } from '@shared/screen';
import type { PendingQuestion, QuestionReply } from '@shared/questions';
import { McpBridge } from '../../src/main/mcp-bridge';
import { chatMessage, QUESTION_WAIT_REQUEST } from '../../src/main/question-hook';
import { SessionsControl } from '../../src/main/sessions-control';
import { ASK_TABS, TABS_ANSWERS } from '../scenarios/questions';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion, menuOf } from './claude-run';
import { MockApi, type Step } from './mock-api';

// 本物の claude をモックの API で動かし、AskUserQuestion の質問を、ターミナルの画面を読まずに受け取って答えられるかを確かめる
// （question-hook.ts の PermissionRequest のフック。アプリと同じく、ビルドした入口を node で動かす）。
// - フックが待っている間も、画面に質問が出る。アプリは待っている質問として読み、カードと同じ返事で答えると、画面で答えたのと同じ答えが会話ログに書かれる
// - 人が画面で先に答えると、待っている質問は消え、フックは終わる
// - 「Chat about this」の返事は、画面で選んだときと同じ文になる / キャンセルは、画面の Esc と同じく作業を止める
// - 親の answer_question は、画面を読まずに 1 問ずつ答え、改行のある長い自由記述もそのまま渡せる

const version = claudeVersion();

const PROMPT = 'フックで質問に答える確認をしてください';
const single = (question: string): AskQuestion => ({
  question,
  header: '方式',
  multiSelect: false,
  options: [
    { label: 'A 案', description: '速い' },
    { label: 'B 案', description: '確実' },
  ],
});
const HUMAN = single('人が画面で答える質問です。どちらにしますか?');
const CHAT = [single('話したい 1 問めです。どちらにしますか?'), { ...single('話したい 2 問めです。どちらにしますか?'), header: '期限' }];
const HOOK_CHAT = single('フックから話したい質問です。どちらにしますか?');
const CANCEL = single('キャンセルする質問です。どちらにしますか?');
const PARENT = [single('親が答える 1 問めです。どちらにしますか?'), { ...single('親が答える 2 問めです。どれを入れますか?'), header: '中身', multiSelect: true }];
// 親が渡す、改行のある長い指示（画面に打つ道では 1 行にするしかなかった）
const LONG_OTHER = ['【保留】方針はまだ確定しない。', ...Array.from({ length: 30 }, (_, i) => `${i + 1}. 手順 ${i + 1}: 本実装のファイルは編集せず、一時ファイルに見た目を置く。`)].join('\n');

const ask = (id: string, questions: AskQuestion[]): Step => [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }];
const say = (text: string): Step => [{ type: 'text', text }];

describe(`Claude Code ${version} の AskUserQuestion（フックで答える）`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  let bridge: McpBridge;
  let socketDir: string;
  // フックが待つのをやめた回数（返事を渡した・待つのをやめた）
  let finished = 0;

  // 会話ログに書かれた答え（toChatEvents の tool-result の answers）と、tool_result の中身
  const answersOf = (toolUseId: string) => {
    const result = run.chatEvents.find((e) => e.type === 'tool-result' && e.id === toolUseId);
    return result?.type === 'tool-result' ? result.answers : undefined;
  };
  const resultOf = (toolUseId: string): { content?: unknown; is_error?: boolean } | undefined => {
    for (const entry of run.entries) {
      const content = entry.type === 'user' ? (entry as { message?: { content?: unknown } }).message?.content : null;
      if (!Array.isArray(content)) continue;
      const hit = content.find((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
      if (hit) return hit;
    }
    return undefined;
  };
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  // フックが質問を渡して、アプリが待っている質問として持つまで待つ
  const pending = (questions: AskQuestion[]): Promise<PendingQuestion> =>
    run.waitFor('待っている質問', () => {
      const question = run.manager.pendingQuestion(run.sessionId!);
      return question && question.questions.map((q) => q.question).join('\n') === questions.map((q) => q.question).join('\n') ? question : null;
    });
  const reply = (question: PendingQuestion, value: QuestionReply) => expect(run.manager.replyQuestion(run.sessionId!, question.id, value)).toBe(true);
  // 返事のあと、入力欄に戻るのを待ってから、次の発言を送る
  const next = async (prompt = '続けてください') => {
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    await run.send(prompt);
  };

  beforeAll(async () => {
    const script = await buildRelay('question-hook-main');
    socketDir = mkdtempSync(join(tmpdir(), 'tanacode-question-'));
    const socketPath = join(socketDir, 'question.sock');
    bridge = new McpBridge(socketPath, async (session, tool, args, signal) => {
      expect(tool).toBe(QUESTION_WAIT_REQUEST);
      const result = await run.manager.waitQuestion(session, args.input, signal);
      finished++;
      return result;
    });
    await bridge.start();
    api = new MockApi();
    api.conversations = [
      {
        match: PROMPT,
        delayMs: 300,
        steps: [
          ask('toolu_hook_tabs', ASK_TABS),
          say('フックの答えを受け取りました'),
          ask('toolu_hook_human', [HUMAN]),
          say('画面の答えを受け取りました'),
          ask('toolu_hook_chat_screen', CHAT),
          say('画面で話したいと受け取りました'),
          ask('toolu_hook_chat', [HOOK_CHAT]),
          say('フックで話したいと受け取りました'),
          // キャンセルすると作業が止まるので、次の応答は、次の発言まで使われない
          ask('toolu_hook_cancel', [CANCEL]),
          ask('toolu_hook_parent', PARENT),
          say('親の答えを受け取りました'),
        ],
      },
    ];
    run = new ClaudeRun(await api.start(), { question: { command: process.execPath, script, socketPath, version: 'test' } });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
    bridge?.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  it('フックが待っている間も画面に質問が出て、待っている質問として読める。返事で答えると、画面で答えたのと同じ答えが会話ログに書かれる', async () => {
    await run.send(PROMPT);
    const question = await pending(ASK_TABS);
    expect(question.questions).toEqual(ASK_TABS);
    expect(run.manager.stateOf(run.sessionId!)).toBe('question');
    await run.waitFor('画面の質問', menuOf('question'));
    // 画面から読むのと同じ答え（複数選択は「, 」でつなぎ、自由記述は最後）
    reply(question, { kind: 'answer', answers: Object.fromEntries(ASK_TABS.map((q, i) => [q.question, TABS_ANSWERS[i]])) });
    expect(await run.waitFor('答え', () => answersOf('toolu_hook_tabs'))).toEqual(ASK_TABS.map((q, i) => ({ header: q.header, question: q.question, answer: TABS_ANSWERS[i] })));
    await run.waitFor('返事', replied('フックの答えを受け取りました'));
    expect(run.manager.pendingQuestion(run.sessionId!)).toBeNull();
    // フックが決めた記録は、コマンドの無い PermissionRequest の記録として、質問のツールの呼び出しと結果の間に書かれる
    // （チャットは、AskUserQuestion のカードに付くこの記録を出さない。chatState.ts の withHook）
    const hooks = run.chatEvents.filter((e) => e.type === 'hook' && e.run.event === 'PermissionRequest');
    expect(hooks).toEqual([expect.objectContaining({ run: expect.objectContaining({ command: null, toolUseId: 'toolu_hook_tabs' }) })]);
    const order = run.chatEvents.map((e) => (e.type === 'hook' ? 'hook' : e.type === 'tool-use' || e.type === 'tool-result' ? `${e.type}:${e.id}` : null)).filter(Boolean);
    expect(order.slice(order.indexOf('tool-use:toolu_hook_tabs'), order.indexOf('tool-result:toolu_hook_tabs') + 1)).toEqual(['tool-use:toolu_hook_tabs', 'hook', 'tool-result:toolu_hook_tabs']);
  });

  it('人が画面で先に答えると、待っている質問は消え、フックは待つのをやめる', async () => {
    await next();
    const question = await pending([HUMAN]);
    const before = finished;
    const menu = await run.waitFor('画面の質問', (info) => {
      const shown = menuOf('question')(info);
      return shown?.title === HUMAN.question ? shown : null;
    });
    await run.press('画面で答える', { optionId: menu.options.find((o) => o.label === 'B 案')!.id, key: 'enter' });
    expect(await run.waitFor('答え', () => answersOf('toolu_hook_human'))).toEqual([{ header: HUMAN.header, question: HUMAN.question, answer: 'B 案' }]);
    await run.waitFor('待っている質問が消える', () => run.manager.pendingQuestion(run.sessionId!) === null);
    await run.waitFor('フックが待つのをやめる', () => finished > before);
    // もう答えた質問には、返事を渡せない
    expect(run.manager.replyQuestion(run.sessionId!, question.id, { kind: 'answer', answers: { [HUMAN.question]: 'A 案' } })).toBe(false);
    await run.waitFor('返事', replied('画面の答えを受け取りました'));
  });

  it('「Chat about this」の返事は、画面で選んだときと同じ文になる', async () => {
    // 画面で選んだときに Claude Code が返す文（質問が 2 つ）
    await next();
    await pending(CHAT);
    const menu = await run.waitFor('画面の質問', (info) => {
      const shown = menuOf('question')(info);
      return shown?.title === CHAT[0].question ? shown : null;
    });
    await run.press('画面で Chat about this', { optionId: menu.options.find((o) => o.label === 'Chat about this')!.id, key: 'enter' });
    const screen = await run.waitFor('画面で選んだ結果', () => resultOf('toolu_hook_chat_screen'));
    expect(screen).toMatchObject({ content: chatMessage(CHAT.map((q) => q.question)), is_error: true });
    await run.waitFor('返事', replied('画面で話したいと受け取りました'));
    // フックから返す
    await next();
    reply(await pending([HOOK_CHAT]), { kind: 'chat' });
    expect(await run.waitFor('フックで返した結果', () => resultOf('toolu_hook_chat'))).toMatchObject({ content: chatMessage([HOOK_CHAT.question]), is_error: true });
    await run.waitFor('返事', replied('フックで話したいと受け取りました'));
  });

  it('キャンセルは、画面の Esc と同じく作業を止める', async () => {
    await next();
    reply(await pending([CANCEL]), { kind: 'cancel' });
    expect(await run.waitFor('キャンセルの結果', () => resultOf('toolu_hook_cancel'))).toMatchObject({ is_error: true });
    await run.waitFor('止まった印', () => run.chatEvents.some((e) => e.type === 'turn-end' && e.interrupted));
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
  });

  it('親の answer_question は、画面を読まずに 1 問ずつ答え、改行のある長い自由記述もそのまま渡せる', async () => {
    const parentId = 'parent-of-question-hook';
    const now = Date.now();
    run.manager['store'].add({ id: parentId, claudeSessionId: 'parent-claude', cwd: run.cwd, title: '親', titlePriority: 4, archived: false, createdAt: now, updatedAt: now });
    run.manager['store'].update(run.sessionId!, { parentId });
    const control = new SessionsControl({ host: run.manager, enabled: () => true, archive: (id, options) => run.manager.archive(id, options), home: run.home, notifyDelayMs: 10 });
    try {
      // 端末が低くても（自由記述が画面の上に質問を押し出しても）、画面を読まないので答えられる
      run.manager.resize(run.sessionId!, 100, 30);
      const textOf = (result: { content: { type: string; text?: string }[] }) => (result.content[0] as { text: string }).text;
      await next();
      await pending(PARENT);
      const got = JSON.parse(textOf(await control.handle(parentId, 'get_session', { session_id: run.sessionId }))) as { state: string; question: { title: string; tabs: unknown } };
      expect(got).toMatchObject({ state: 'question', question: { title: PARENT[0].question, tabs: [{ label: '方式', answered: false }, { label: '中身', answered: false }] } });
      // 1 問め: 改行のある長い自由記述。まだ 2 問めがあるので、フックには返さずに次の質問を返す
      const first = JSON.parse(textOf(await control.handle(parentId, 'answer_question', { session_id: run.sessionId, question: got.question.title, other: LONG_OTHER }))) as {
        next_question?: { title: string; multi_select: boolean };
      };
      expect(first.next_question).toMatchObject({ title: PARENT[1].question, multi_select: true });
      // 2 問め: 複数選択。そろったら、まとめてフックに返す
      const second = await control.handle(parentId, 'answer_question', { session_id: run.sessionId, question: first.next_question!.title, choices: ['B 案', 'A 案'] });
      expect(second.isError, textOf(second)).toBeUndefined();
      expect(await run.waitFor('答え', () => answersOf('toolu_hook_parent'))).toEqual([
        { header: '方式', question: PARENT[0].question, answer: LONG_OTHER },
        { header: '中身', question: PARENT[1].question, answer: 'A 案, B 案' },
      ]);
      await run.waitFor('返事', replied('親の答えを受け取りました'));
    } finally {
      control.dispose();
    }
  });
});
