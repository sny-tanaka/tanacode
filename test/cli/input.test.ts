import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents, type ChatEvent } from '@shared/chat';
import { conversationOf } from '@shared/transcript-line';
import type { Card, Checklist, ListKind } from '@shared/checklist';
import { RESUME_MAX_CHARS, RESUME_TAG, resumeText } from '@shared/optimized-compact';
import { parentMessageText } from '@shared/session-tools';
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
  EFFORT,
  IMAGE_FILE,
  LINES_WITH_LONG_LINE,
  LONG_LINE,
  LONG_LINES,
  LONG_PASTE,
  NUMBERED_PROMPT,
  ONE_LONG_LINE,
  PASTE,
  PNG_BASE64,
  READ_FILES,
  READ_PROMPT,
  RENAMED,
  SHELL_COMMAND,
  STOP_AGAIN,
  STOP_PROMPT,
  SUBAGENT_PROMPT,
  agentSteps,
  checkAgentLog,
  checkAiTitle,
  checkBangPrompt,
  checkDiscovered,
  checkEffort,
  checkImage,
  checkKilled,
  checkKnowledge,
  checkContext,
  checkLocalCommand,
  checkPasted,
  checkRecent,
  checkRenamed,
  checkThinking,
  readSteps,
  stopStep,
  stopSteps,
  subagentSteps,
} from '../scenarios/input';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、発言の送り方と、まだ確かめていなかった読み取りをアプリと同じ部品で確かめる。
// 台本ごとに別の claude を起動する（台本は test/scenarios/input.ts）。発言は、チャットと同じく session-manager の submit
// （stream-json の user の行）で送る
// - 発言: --effort・会話の最初の /context・複数行と長い発言・札・! で始まる発言・親からの指示・/rename と AI のタイトル・セッションの一覧
// - 上限いっぱい（4 万文字）の再開の文: 手が空くのを待つ送り方で、欠けず・囲みなしで届く
// - 読み取り: @ の添付・Read・サブフォルダの CLAUDE.md・思考・画像（KnowledgeTracker と toChatEvents）
// - サブエージェント: 実行中の直近のツールと、終わったあとの会話ログ（readAgentLog）
// - バックグラウンドの Bash を止める（TaskStop）

const version = claudeVersion();

// 会話ログから作ったチャットのイベント（画像は images に受け取る）
function eventsOf(run: ClaudeRun, images?: Map<string, string>): ChatEvent[] {
  return run.entries.flatMap((e) => toChatEvents(e, run.cwd, false, images && ((key, url) => images.set(key, url))));
}

// ターンの終わり（turn-end）の数。session-manager が result から出す（-p の会話ログには turn_duration の行が無い）。送ったあとに増えるのを待つ
const turnEnds = (run: ClaudeRun) => run.chatEvents.filter((e) => e.type === 'turn-end').length;

// チャットの入力欄と同じく送り、ターンが終わって手が空くまで待つ
async function submit(run: ClaudeRun, text: string, pastes: string[] = []): Promise<void> {
  const before = turnEnds(run);
  await run.manager.submit(run.sessionId!, text, [], pastes);
  await run.waitUntil('ターンの終わり', () => turnEnds(run) > before, 30_000);
  await run.waitUntil('手が空く', () => run.idle);
}

describe(`Claude Code ${version} の発言`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // 親セッションの ID（親からの指示の目印に入れる）
  const PARENT = '11111111-2222-4333-8444-555555555555';

  beforeAll(async () => {
    api = new MockApi();
    api.plainReplies = [AI_TITLE_REPLY];
    run = new ClaudeRun(await api.start(), { effort: EFFORT });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('--effort で起動すると、アプリの状態のエフォートとモデルが読める', async () => {
    await run.waitUntil('エフォートの表示', () => run.statusLine?.effort === EFFORT && run.statusLine.model);
    checkEffort(run.statusLine, EFFORT);
  });

  it('会話の最初の /context が、チャットの発言として出る', async () => {
    await submit(run, '/context');
    await run.waitUntil('コマンドの行', () => eventsOf(run).some((e) => e.type === 'user' && e.text === '/context'));
    checkLocalCommand(run.entries, eventsOf(run), '/context');
  });

  it('複数行の発言が、そのまま 1 つの発言になり、起動したエフォートで API を呼ぶ', async () => {
    await submit(run, PASTE);
    checkPasted(eventsOf(run), PASTE);
    expect(api.calls.at(-1)?.effort).toBe(EFFORT);
  });

  it.each([
    ['/ @ ! # で始まる行・字下げ・絵文字を含む長い複数行', () => LONG_LINES],
    ['改行なしで 2,000 文字ほどの 1 行', () => ONE_LONG_LINE],
    ['複数行の中の 1,500 文字ほどの行', () => LINES_WITH_LONG_LINE],
    ['30 行の長い発言', () => LONG_PASTE],
  ])('%s が、欠けずにそのまま 1 つの発言になる', async (_, textOf) => {
    const text = textOf();
    await submit(run, text);
    checkPasted(eventsOf(run), text);
    // シェルのコマンドやスラッシュコマンドとして実行されていない
    expect(eventsOf(run).filter((e) => e.type === 'shell')).toEqual([]);
    expect(api.lastPrompts.some((prompt) => prompt.includes(text))).toBe(true);
  });

  it('打った文に札（長い貼り付け）を添えて送ると、文と札の中身が 1 つの発言として届く', async () => {
    const count = eventsOf(run).filter((e) => e.type === 'user').length;
    await submit(run, CHIP_TEXT, [LONG_PASTE, LONG_LINE]);
    const users = eventsOf(run).filter((e): e is Extract<ChatEvent, { type: 'user' }> => e.type === 'user');
    expect(users).toHaveLength(count + 1);
    const last = users.at(-1)!;
    expect(last.text).not.toMatch(/\[Pasted text|<\/?pasted_content|\x1b/);
    expect([last.text, ...(last.pastes ?? [])].join('').replace(/\s/g, '')).toBe(`${CHIP_TEXT}${LONG_PASTE}${LONG_LINE}`.replace(/\s/g, ''));
  });

  it('! で始まる発言は、シェルで動かず、そのまま Claude への発言として届く', async () => {
    await submit(run, `!${SHELL_COMMAND}`);
    checkBangPrompt(eventsOf(run), SHELL_COMMAND);
    expect(api.lastPrompts.some((prompt) => prompt.includes(`!${SHELL_COMMAND}`))).toBe(true);
  });

  it('番号付きの手順が続く長い親セッションからの指示が、手が空くのを待つ送り方で、親からの発言として全文届く', async () => {
    const attentions = run.attentions.length;
    await run.manager.submitWhenReady(run.sessionId!, parentMessageText(PARENT, NUMBERED_PROMPT), 30_000);
    await run.waitUntil('指示が届く', () => run.chatEvents.some((e) => e.type === 'user' && e.parent === PARENT), 30_000);
    expect(run.chatEvents.find((e) => e.type === 'user' && e.parent === PARENT)).toMatchObject({ text: NUMBERED_PROMPT });
    expect(run.attentions.slice(attentions)).toEqual([]);
    await run.waitUntil('手が空く', () => run.idle, 30_000);
  });

  it('/rename の名前を、会話ログのタイトルとして読める', async () => {
    await submit(run, `/rename ${RENAMED}`);
    await run.waitUntil('名前の行', () => run.entries.some((e) => e.type === 'custom-title'));
    checkRenamed(run.entries, RENAMED);
    await run.waitUntil('コマンドの発言', () => eventsOf(run).some((e) => e.type === 'user' && e.text === `/rename ${RENAMED}`));
    checkLocalCommand(run.entries, eventsOf(run), `/rename ${RENAMED}`);
  });

  it('AI が付けたタイトルを、会話ログのタイトルとして読める', async () => {
    // タイトルは、最初のターンのあとにアプリが頼む（generate_session_title）。書かないバージョンもありうるので、出たときだけ確かめる
    const written = await run.waitUntil('AI のタイトル', () => run.entries.some((e) => e.type === 'ai-title'), 10_000).catch(() => false);
    if (!written) console.warn(`Claude Code ${version}: ai-title の行が書かれませんでした`);
    else checkAiTitle(run.entries, AI_TITLE);
  });

  it('セッションの一覧に、/rename の名前と作業フォルダで出る', async () => {
    checkDiscovered(await discoverSessions(new Set()), run.claudeSessionId, run.cwd, RENAMED);
  });
});

// 上限いっぱいの再開の文（最適化圧縮で、新しい会話の最初に送る文）。アプリの resumeText で、どの部分も上限まで埋める:
// 決定事項と「いまの状態」のカード（24,000 文字）・発言の原文（12,000 文字）・切り替える前の最後の応答（3,000 文字）・裏のタスク（20 件）。
// 合わせると上限を超えるので、終わり（タスクの一覧の途中）は上限で切られる（決まった文は画面の言語で、日本語は英語より短いので、タスクで埋める）。
// 日本語で埋める（1 文字 3 バイトなので、打つバイト数がいちばん大きくなる）。行の長さは、短い行から、断片に分かれる長い行（300 文字超）まで混ぜる
function fullResumeText(): string {
  const SENTENCES = [
    '税率を設定から読むようにして、決済のモジュールには触らない。',
    '確かめ方: `npm run test:cli -- input` を 3 回続けて流して、どれも通ること（落ちたら再実行で済ませず原因を追う）。',
    '- 試してやめたこと: 丸ごと 1 つの貼り付けで送る（Claude Code が貼り付けの囲みに入れる）',
    '場所: src/main/session-manager.ts の submit（打つ直前と Enter の直前に、入力欄の状態を確かめる）',
    '',
    '数字と記号: 1,000 バイト・40,000 文字・[x](y)・{a: 1}・<b>・\\n・"引用"・$HOME・100%・🎉',
    `長い 1 行: ${'入力欄で折り返される長い行です。'.repeat(24)}`,
  ];
  // n 文字ちょうどの本文（行の終わりに空白を残さない）
  const prose = (seed: number, chars: number) => {
    let text = '';
    for (let i = seed; text.length < chars; i++) text += `${i} ${SENTENCES[i % SENTENCES.length]}\n`;
    return `${text.slice(0, chars - 1).trimEnd()}。`;
  };
  let at = 0;
  const card = (number: number, title: string, body: string): Card => ({
    id: `c${number}-${title}`,
    number,
    title,
    body,
    checked: false,
    createdBy: 'claude',
    createdAt: ++at,
    updatedAt: at,
    thread: [],
    readByClaude: 0,
    readByHuman: 0,
  });
  const list = (name: string, kind: ListKind, cards: Card[]): Checklist => ({ id: name, name, description: `${name}の決まり`, kind, nextNumber: cards.length + 1, cards, createdBy: 'claude', createdAt: 0 });
  return resumeText({
    lists: [
      list('決定事項', 'decisions', Array.from({ length: 4 }, (_, i) => card(i + 1, `決定 ${i + 1}`, prose(i * 100, 2900)))),
      list('いまの状態', 'state', Array.from({ length: 4 }, (_, i) => card(i + 1, `状態 ${i + 1}`, prose(1000 + i * 100, 2900)))),
      list('やること', 'normal', [card(1, 'テストを足す', '')]),
    ],
    messages: Array.from({ length: 4 }, (_, i) => ({ text: prose(2000 + i * 100, 2900), fromParent: i === 1 })),
    tasks: Array.from({ length: 20 }, (_, i) => ({ kind: 'bash' as const, label: prose(4000 + i * 10, 190) })),
    reply: prose(3000, 3000),
  });
}

describe(`Claude Code ${version} に、上限いっぱいの再開の文を送る`, () => {
  let api: MockApi;
  let run: ClaudeRun;

  beforeAll(async () => {
    api = new MockApi();
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('上限（4 万文字）の再開の文が、手が空くのを待つ送り方（最適化圧縮と同じ道）で、1 文字も欠けず・囲みなしで Claude に届く', async () => {
    const text = fullResumeText();
    const bytes = new TextEncoder().encode(text).length;
    // 上限まで埋まっている（どの部分も入っていて、終わりは上限で切られている）
    expect(text.length).toBeGreaterThan(RESUME_MAX_CHARS - 20);
    expect(text.length).toBeLessThanOrEqual(RESUME_MAX_CHARS);
    for (const part of ['# 決定事項', '# いまの状態', '# 前の会話でのユーザーの発言', '# 会話を消す前の、あなたの最後の応答', '# 裏で動いているタスク']) expect(text).toContain(part);
    expect(bytes).toBeGreaterThan(90_000);
    await run.waitUntil('手が空く', () => run.idle);
    const attentions = run.attentions.length;
    await run.manager.submitWhenReady(run.sessionId!, text, 10_000);
    // 会話の呼び出し（発言で終わる）を見る。タイトル作りの呼び出しにも、発言の文が入っている（あとに頼みの文が続く）
    const sent = () => api.lastPrompts.find((prompt) => prompt.includes(`<${RESUME_TAG} `) && prompt.trimEnd().endsWith(`</${RESUME_TAG}>`));
    await run.waitUntil('Claude に届く', () => sent() !== undefined, 60_000);
    // Claude（モックの API）が受け取った発言。送った文と 1 文字も違わない
    const got = sent()!;
    const received = got.slice(got.indexOf(`<${RESUME_TAG} `));
    // 違うときは、全文（4 万文字）ではなく、はじめに違うところの前後を出す
    let diff = 0;
    while (diff < text.length && text[diff] === received[diff]) diff++;
    const around = (whole: string) => `${diff} 文字目: ${whole.slice(Math.max(0, diff - 40), diff + 40)}`;
    if (received !== text) expect(around(received)).toBe(around(text));
    expect(received).toHaveLength(text.length);
    // 貼り付けの囲み・入力欄の目印・端末の制御文字が混ざっていない
    expect(got).not.toMatch(/<\/?pasted_content|\[Pasted text|Truncated text|\x1b/);
    // 会話ログの発言も同じ（アプリは、ここから再開の知らせを作る）
    const logged = () =>
      run.entries
        .filter((e) => e.type === 'user')
        .map((e) => e.message?.content)
        .map((content) => (typeof content === 'string' ? content : (content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')))
        .filter((content) => content.includes(`<${RESUME_TAG} `));
    await run.waitUntil('会話ログに出る', () => logged().length > 0, 30_000);
    expect(logged()).toEqual([text]);
    expect(eventsOf(run).filter((e) => e.type === 'notice' && e.compact === 'resume')).toHaveLength(1);
    // メニューなどの知らせが出ていない
    expect(run.attentions.slice(attentions)).toEqual([]);
    await run.waitUntil('手が空く', () => run.idle, 30_000);
  }, 180_000);
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
    await run.waitUntil('返事', () => eventsOf(run).some((e) => e.type === 'assistant-text' && e.text === '読みました'), 30_000);
    await run.waitUntil('ターンの終わり', () => turnEnds(run) > 0);
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('@ で添付・Read で読んだファイル、サブフォルダの CLAUDE.md、コンテキストの使用量を KnowledgeTracker で読める', () => {
    const knowledge = new KnowledgeTracker(run.cwd, () => {});
    // アプリ（session-manager の handleEntry）と同じく、会話の行だけを渡す
    for (const entry of run.entries.flatMap((e) => conversationOf(e) ?? [])) knowledge.handle(entry);
    checkKnowledge(knowledge.current());
  });

  it('読んだファイルと発言のやりとりを、ContextTracker でコンテキストの中身として読める', async () => {
    const context = new ContextTracker(run.cwd);
    for (const entry of run.entries.flatMap((e) => conversationOf(e) ?? [])) context.handle(entry);
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
    await run?.stop();
    await api?.stop();
  });

  it('実行中のサブエージェントの直近のツールが読める', async () => {
    const agent = await run.waitUntil('直近のツール', () => run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent' && r.recent.length > 0), 30_000);
    checkRecent(agent);
  });

  it('終わったサブエージェントの会話ログを、チャットのイベントにできる', async () => {
    await run.waitUntil('サブエージェントの完了', () => run.subagentRuns.find((r) => r.toolUseId === 'toolu_agent' && r.state !== 'running'), 30_000);
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
    await run?.stop();
    await api?.stop();
  });

  it('止めたバックグラウンドの Bash が、止めた状態になる', async () => {
    await run.send(STOP_PROMPT);
    const task = await run.waitUntil('バックグラウンドの Bash', () => run.bashTasks.find((t) => t.toolUseId === 'toolu_long' && t.state === 'running'));
    await run.waitUntil('ターンの終わり', () => turnEnds(run) > 0);
    // 止めるツールの入力には、起動したときの ID が要るので、起動を見てから台本の続きを決める
    steps.push(stopStep(api.tools, task.taskId), [{ type: 'text', text: '止めました' }]);
    await run.waitUntil('入力欄', () => run.idle);
    await run.send(STOP_AGAIN);
    const stopped = await run.waitUntil('止まる', () => run.bashTasks.find((t) => t.toolUseId === 'toolu_long' && t.state !== 'running'), 30_000);
    checkKilled(stopped);
  });
});
