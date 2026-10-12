import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents, type ChatEvent } from '@shared/chat';
import { bracketedPaste, promptKeyChunks, promptKeys } from '@shared/prompt-keys';
import { readAgentLog } from '../../src/main/chat-log';
import { KnowledgeTracker } from '../../src/main/knowledge-tracker';
import { ContextTracker } from '../../src/main/context-tracker';
import { discoverSessions } from '../../src/main/session-discovery';
import {
  AGENT_PROMPT,
  AI_TITLE,
  AI_TITLE_REPLY,
  ATTACHED,
  CHIP_TEXT,
  DRAFT,
  EFFORT,
  IMAGE_FILE,
  LINES_WITH_LONG_LINE,
  LONG_LINE,
  LONG_LINES,
  LONG_PASTE,
  ONE_LONG_LINE,
  PASTE,
  PNG_BASE64,
  READ_FILES,
  READ_PROMPT,
  RENAMED,
  SHELL_COMMAND,
  SHELL_OUTPUT,
  STOP_AGAIN,
  STOP_PROMPT,
  SUBAGENT_PROMPT,
  TALL_LINES,
  agentSteps,
  checkAgentLog,
  checkAiTitle,
  checkChipDraft,
  checkDiscovered,
  checkDraft,
  checkEffort,
  checkImage,
  checkKilled,
  checkKnowledge,
  checkContext,
  checkLocalCommand,
  checkPasted,
  checkPastedDraft,
  checkRecent,
  checkRenamed,
  checkShell,
  checkThinking,
  readSteps,
  stopStep,
  stopSteps,
  subagentSteps,
} from '../scenarios/input';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、入力まわりと、まだ確かめていなかった読み取りをアプリと同じ部品で確かめる。
// 台本ごとに別の claude を起動する（台本は test/scenarios/input.ts）
// - 入力欄: --effort・書きかけ・会話の最初の /context・複数行の貼り付け・! のコマンド・/rename と AI のタイトル・セッションの一覧
// - 読み取り: @ の添付・Read・サブフォルダの CLAUDE.md・思考・画像（KnowledgeTracker と toChatEvents）
// - サブエージェント: 実行中の直近のツールと、終わったあとの会話ログ（readAgentLog）
// - バックグラウンドの Bash を止める（TaskStop）

const version = claudeVersion();
const record = (run: ClaudeRun | undefined) => {
  if (process.env.TANACODE_RECORD) run?.recordScreens(join('test', 'fixtures', 'claude-code', version));
};

// 会話ログから作ったチャットのイベント（画像は images に受け取る）
function eventsOf(run: ClaudeRun, images?: Map<string, string>): ChatEvent[] {
  return run.entries.flatMap((e) => toChatEvents(e, run.cwd, false, images && ((key, url) => images.set(key, url))));
}

// ターンの終わり（turn-end）の数。送ったあとに増えるのを待つ
const turnEnds = (run: ClaudeRun) => eventsOf(run).filter((e) => e.type === 'turn-end').length;

// アプリ（ChatInput の submitToClaude）と同じく、入力欄に打ち込んでから Enter を送る。
// 貼り付けは、入力欄に入ったのを見てから送る
async function submit(run: ClaudeRun, text: string): Promise<void> {
  const before = turnEnds(run);
  run.type(promptKeys(text));
  await run.waitFor('入力欄に入る', (info) => info.state.kind === 'prompt' && info.draft !== '');
  run.type('\r');
  await run.waitFor('ターンの終わり', () => turnEnds(run) > before, 30_000);
  await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
}

// アプリ（SessionManager.submit）と同じく、長い文は小さな分に分けて打ち、前の分が入力欄に出てから次を打つ（promptKeyChunks）。
// まとめて打つと、貼り付けの合図（ESC [200~）が Claude Code の読む区切りで割れ、マシンが重いと後半が文字として入力に混ざる
async function typeLikeApp(run: ClaudeRun, text: string): Promise<void> {
  for (const chunk of promptKeyChunks(text)) {
    run.type(chunk.keys);
    const tail = chunk.shown.replace(/\s/g, '').slice(-30);
    if (tail) await run.waitFor('打った分が入力欄に出る', (info) => info.state.kind === 'prompt' && (/\[Pasted text/.test(info.draft) || info.draft.replace(/\s/g, '').endsWith(tail)));
  }
}

describe(`Claude Code ${version} の入力欄`, () => {
  let api: MockApi;
  let run: ClaudeRun;

  beforeAll(async () => {
    api = new MockApi();
    api.plainReplies = [AI_TITLE_REPLY];
    run = new ClaudeRun(await api.start(), { effort: EFFORT });
    await run.open();
  });

  afterAll(async () => {
    record(run);
    run?.stop();
    await api?.stop();
  });

  it('--effort で起動すると、入力欄の上のエフォートとバナーのモデル名が読める', async () => {
    await run.waitFor('エフォートの表示', (info) => info.effort === EFFORT && info.model);
    run.capture('effort');
    checkEffort(run.screen.current, EFFORT);
  });

  it('打っただけで送っていない文字が、入力欄の書きかけとして読める', async () => {
    expect(run.screen.current.draft).toBe('');
    run.type(DRAFT);
    await run.waitFor('書きかけ', (info) => info.draft === DRAFT);
    run.capture('draft');
    checkDraft(run.screen.current, DRAFT);
    run.type('\x7f'.repeat(DRAFT.length));
    await run.waitFor('書きかけを消す', (info) => info.draft === '');
  });

  it('会話の最初の /context が、チャットの発言として出る', async () => {
    const before = turnEnds(run);
    await run.send('/context');
    await run.waitFor('ターンの終わり', () => turnEnds(run) > before);
    checkLocalCommand(run.entries, eventsOf(run), '/context');
  });

  it('複数行を貼り付けて送ると、そのまま 1 つの発言になる', async () => {
    await submit(run, PASTE);
    checkPasted(eventsOf(run), PASTE);
  });

  it('長い複数行の発言は、行ごとの貼り付けで送ると、入力欄で目印にならず、全文がそのまま 1 つの発言になる', async () => {
    // アプリの送り方（promptKeys）。丸ごと 1 つの貼り付けにすると、ログインして使う Claude Code は <pasted_content> の囲みに入れて
    // Claude に渡す（モックの API で動かすここでは、囲みは付かない。打ち込んだ文字がそのまま届くことを見る）
    const before = turnEnds(run);
    const keys = promptKeys(LONG_LINES);
    // 貼り付け 1 つは 1 行の中だけ（4 行以上の貼り付けは目印になる）
    expect(keys.split('\x1b[201~').every((piece) => !piece.replace(/^\n+/, '').includes('\n'))).toBe(true);
    await typeLikeApp(run, LONG_LINES);
    const tail = LONG_LINES.replace(/\s/g, '').slice(-30);
    await run.waitFor('入力欄の終わりに、打った文字の終わりが出る', (info) => info.state.kind === 'prompt' && info.draft.replace(/\s/g, '').endsWith(tail));
    expect(run.screen.current.draft).not.toMatch(/\[Pasted text/);
    run.type('\r');
    await run.waitFor('ターンの終わり', () => turnEnds(run) > before, 30_000);
    checkPasted(eventsOf(run), LONG_LINES);
    // シェルのコマンドやスラッシュコマンドとして実行されていない
    expect(eventsOf(run).filter((e) => e.type === 'shell')).toEqual([]);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
  });

  it.each([
    ['改行なしで 2,000 文字ほどの 1 行', () => ONE_LONG_LINE],
    ['複数行の中の 1,500 文字ほどの行', () => LINES_WITH_LONG_LINE],
  ])('%s は、入力欄で目印にならず、全文が欠けずに 1 つの発言になる', async (_, textOf) => {
    // 1 行の中の断片（300 文字まで）が、続けて届いても 1 つの貼り付けにまとまらないこと
    const text = textOf();
    expect(Math.max(...text.split('\n').map((line) => line.length))).toBeGreaterThan(1400);
    const before = turnEnds(run);
    await typeLikeApp(run, text);
    const tail = text.replace(/\s/g, '').slice(-30);
    await run.waitFor('入力欄の終わりに、打った文字の終わりが出る', (info) => info.state.kind === 'prompt' && (/\[Pasted text/.test(info.draft) || info.draft.replace(/\s/g, '').endsWith(tail)));
    expect(run.screen.current.draft).not.toMatch(/\[Pasted text/);
    run.type('\r');
    await run.waitFor('ターンの終わり', () => turnEnds(run) > before, 30_000);
    checkPasted(eventsOf(run), text);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
  });

  it('長い貼り付けは入力欄で目印になり、送ると全文が発言になる', async () => {
    // 丸ごと 1 つの貼り付け（/ や ! で始まる複数行の発言・ターミナルモードでの貼り付け）
    const before = turnEnds(run);
    run.type(bracketedPaste(LONG_PASTE));
    await run.waitFor('貼り付けの目印', (info) => /^\[Pasted text/.test(info.draft));
    run.capture('pasted-draft');
    checkPastedDraft(run.screen.current, LONG_PASTE.split('\n').length);
    run.type('\r');
    await run.waitFor('ターンの終わり', () => turnEnds(run) > before, 30_000);
    checkPasted(eventsOf(run), LONG_PASTE);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
  });

  it('打った文に札（長い貼り付け）を添えて送ると、札は入力欄で 1 つずつ目印になり、文と札の中身が 1 つの発言として届く', async () => {
    // アプリの送り方（SessionManager.submit の pastes）。ログインして使う Claude Code は、札の中身だけを <pasted_content> の囲みに入れて
    // 発言の文のあとに足す（モックの API で動かすここでは、囲みは付かず、文と札の中身がつながって届く）
    const whole = `${CHIP_TEXT}${LONG_PASTE}${LONG_LINE}`.replace(/\s/g, '');
    const lastUser = () => {
      const last = eventsOf(run).filter((e): e is Extract<ChatEvent, { type: 'user' }> => e.type === 'user').at(-1)!;
      expect(last.text).not.toMatch(/\[Pasted text|<\/?pasted_content|\x1b/);
      return [last.text, ...(last.pastes ?? [])].join('').replace(/\s/g, '');
    };
    const marks = (draft: string) => (draft.match(/\[Pasted text #\d+[^\]]*\]/g) ?? []).length;
    // 1 つずつ打って、入力欄の形を見る
    let before = turnEnds(run);
    run.type(promptKeys(CHIP_TEXT));
    await run.waitFor('打った文', (info) => info.draft.replace(/\s/g, '') === CHIP_TEXT.replace(/\s/g, ''));
    run.type(bracketedPaste(LONG_PASTE));
    await run.waitFor('1 つめの目印', (info) => marks(info.draft) === 1);
    run.type(bracketedPaste(LONG_LINE));
    await run.waitFor('2 つめの目印', (info) => marks(info.draft) === 2);
    checkChipDraft(run.screen.current, CHIP_TEXT, LONG_PASTE.split('\n').length);
    run.type('\r');
    await run.waitFor('ターンの終わり', () => turnEnds(run) > before, 30_000);
    expect(lastUser()).toBe(whole);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
    // アプリの送信（札の目印が出るのを待って次を打ち、Enter を送る）でも、同じように届く
    before = turnEnds(run);
    const count = eventsOf(run).filter((e) => e.type === 'user').length;
    await run.manager.submit(run.sessionId!, CHIP_TEXT, [], false, [LONG_PASTE, LONG_LINE]);
    await run.waitFor('ターンの終わり', () => turnEnds(run) > before, 30_000);
    expect(eventsOf(run).filter((e) => e.type === 'user')).toHaveLength(count + 1);
    expect(lastUser()).toBe(whole);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
  });

  it('! のコマンドを書いている入力欄が読め、送ると shell のイベントになる', async () => {
    // ! を打つと、入力欄の目印が「❯」から「!」に変わる
    run.type(promptKeys(`!${SHELL_COMMAND}`));
    await run.waitFor('入力欄に入る', (info) => info.draft === `!${SHELL_COMMAND}`);
    run.capture('shell-draft');
    checkDraft(run.screen.current, `!${SHELL_COMMAND}`);
    run.type('\r');
    await run.waitFor('コマンドの出力', () => run.entries.some((e) => typeof e.message?.content === 'string' && e.message.content.includes('<bash-stdout>')));
    checkShell(eventsOf(run), SHELL_COMMAND, SHELL_OUTPUT);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
  });

  it('/rename の名前を、会話ログのタイトルとして読める', async () => {
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt');
    await run.send(`/rename ${RENAMED}`);
    await run.waitFor('名前の行', () => run.entries.some((e) => e.type === 'custom-title'));
    checkRenamed(run.entries, RENAMED);
    await run.waitFor('コマンドの発言', () => eventsOf(run).some((e) => e.type === 'user' && e.text === `/rename ${RENAMED}`));
    checkLocalCommand(run.entries, eventsOf(run), `/rename ${RENAMED}`);
  });

  it('AI が付けたタイトルを、会話ログのタイトルとして読める', async () => {
    // タイトル作りは裏で動く。書かない版もありうるので、出たときだけ確かめる
    const written = await run.waitFor('AI のタイトル', () => run.entries.some((e) => e.type === 'ai-title'), 10_000).catch(() => false);
    if (!written) console.warn(`Claude Code ${version}: ai-title の行が書かれませんでした`);
    else checkAiTitle(run.entries, AI_TITLE);
  });

  it('セッションの一覧に、/rename の名前と作業フォルダで出る', async () => {
    checkDiscovered(await discoverSessions(new Set()), run.claudeSessionId, run.cwd, RENAMED);
  });
});

describe(`Claude Code ${version} の、背の高い入力欄`, () => {
  let api: MockApi;
  let run: ClaudeRun;

  beforeAll(async () => {
    api = new MockApi();
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    record(run);
    run?.stop();
    await api?.stop();
  });

  it('背の高い画面（90 行）で、入力欄が 30 行より高くなる長い発言を打っても、入力欄として読めて、手が空くのを待つ送り方（最適化圧縮の再開の文・親からの指示・予約）で送れる', async () => {
    // 行ごとに送ると、入力欄には文字のまま入る。Claude Code は、入力欄を画面の高さの半分ほどまで伸ばすので、背の高い画面では
    // 入力欄が 30 行を超える。入力欄として読めないと「操作できない画面」になり、Enter の直前の確かめ（guarded）で送るのをやめて、
    // 文字が入力欄に残る（実機で、最適化圧縮が「再開の文を送るのを待っています」のまま進まなくなった）
    run.manager.resize(run.sessionId!, 120, 90);
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.draft === '');
    const attentions = run.attentions.length;
    await run.manager.submitWhenReady(run.sessionId!, TALL_LINES, 30_000);
    await run.waitFor('発言が届く', () => eventsOf(run).some((e) => e.type === 'user' && e.text === TALL_LINES), 30_000);
    checkPasted(eventsOf(run), TALL_LINES);
    expect(run.attentions.slice(attentions)).toEqual([]);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
  });
});

describe(`Claude Code ${version} の読み取り`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const prompt = `@${ATTACHED} ${READ_PROMPT}`;

  beforeAll(async () => {
    api = new MockApi();
    run = new ClaudeRun(await api.start(), { files: READ_FILES });
    writeFileSync(join(run.cwd, IMAGE_FILE), Buffer.from(PNG_BASE64, 'base64'));
    api.conversations = [{ match: READ_PROMPT, steps: readSteps(run.cwd) }];
    await run.open();
    await run.send(prompt);
    await run.waitFor('返事', () => eventsOf(run).some((e) => e.type === 'assistant-text' && e.text === '読みました'), 30_000);
    await run.waitFor('ターンの終わり', () => turnEnds(run) > 0);
  });

  afterAll(async () => {
    record(run);
    run?.stop();
    await api?.stop();
  });

  it('@ で添付・Read で読んだファイル、サブフォルダの CLAUDE.md、コンテキストの使用量を KnowledgeTracker で読める', () => {
    const knowledge = new KnowledgeTracker(run.cwd, () => {});
    for (const entry of run.entries) knowledge.handle(entry);
    checkKnowledge(knowledge.current());
  });

  it('読んだファイルと発言のやりとりを、ContextTracker でコンテキストの中身として読める', async () => {
    const context = new ContextTracker(run.cwd);
    for (const entry of run.entries) context.handle(entry);
    checkContext(context.current(), prompt);
    // アプリと同じく、SessionManager が集めたものも同じ
    checkContext(await run.manager.context(run.sessionId!), prompt);
  });

  it('思考の本文が thinking のイベントになる', () => {
    checkThinking(eventsOf(run));
  });

  it('Read で読んだ画像を、ツールの結果の画像として受け取れる', () => {
    const images = new Map<string, string>();
    checkImage(eventsOf(run, images), images);
  });

  it('セッションの一覧に、最初の発言と作業フォルダで出る', async () => {
    checkDiscovered(await discoverSessions(new Set()), run.claudeSessionId, run.cwd, prompt);
  });
});

describe(`Claude Code ${version} のサブエージェントの中身`, () => {
  let api: MockApi;
  let run: ClaudeRun;

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [
      { match: SUBAGENT_PROMPT, steps: subagentSteps },
      // 実行中の様子を見るため、サブエージェントの応答は遅らせる
      { match: AGENT_PROMPT, steps: agentSteps, delayMs: 4000 },
    ];
    run = new ClaudeRun(await api.start());
    await run.open();
    await run.send(SUBAGENT_PROMPT);
  });

  afterAll(async () => {
    record(run);
    run?.stop();
    await api?.stop();
  });

  it('実行中のサブエージェントの直近のツールが読める', async () => {
    const agent = await run.waitFor('直近のツール', () => run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent' && r.recent.length > 0), 30_000);
    checkRecent(agent);
  });

  it('終わったサブエージェントの会話ログを、チャットのイベントにできる', async () => {
    await run.waitFor('サブエージェントの完了', () => run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent' && r.state !== 'running'), 30_000);
    const file = run.subagentLog('toolu_agent');
    expect(file).not.toBeNull();
    checkAgentLog(await readAgentLog(file!, run.cwd));
  });
});

describe(`Claude Code ${version} のバックグラウンドの Bash を止める`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const steps = [...stopSteps];

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [{ match: STOP_PROMPT, steps }];
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    record(run);
    run?.stop();
    await api?.stop();
  });

  it('止めたバックグラウンドの Bash が、止めた状態になる', async () => {
    await run.send(STOP_PROMPT);
    const task = await run.waitFor('バックグラウンドの Bash', () => run.bashTasks.find((t) => t.toolUseId === 'toolu_long' && t.state === 'running'));
    await run.waitFor('ターンの終わり', () => turnEnds(run) > 0);
    // 止めるツールの入力には、起動したときの ID が要るので、起動を見てから台本の続きを決める
    steps.push(stopStep(api.tools, task.taskId), [{ type: 'text', text: '止めました' }]);
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt');
    await run.send(STOP_AGAIN);
    const stopped = await run.waitFor('止まる', () => run.bashTasks.find((t) => t.toolUseId === 'toolu_long' && t.state !== 'running'), 30_000);
    checkKilled(stopped);
  });
});
