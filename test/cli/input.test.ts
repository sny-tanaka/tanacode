import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents, type ChatEvent } from '@shared/chat';
import type { Card, Checklist, ListKind } from '@shared/checklist';
import { RESUME_MAX_CHARS, RESUME_TAG, resumeText } from '@shared/optimized-compact';
import { bracketedPaste, promptKeyChunks, promptKeys } from '@shared/prompt-keys';
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
  DRAFT,
  EFFORT,
  IMAGE_FILE,
  LINES_WITH_LONG_LINE,
  LONG_LINE,
  LONG_LINES,
  LONG_PASTE,
  NUMBERED_FIRST,
  NUMBERED_LINES,
  NUMBERED_PROMPT,
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
  checkNumberedDraft,
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
// - 番号付きの行で始まる入力欄: 選択メニューと読み違えずに、打った文が全文届く
// - 上限いっぱい（4 万文字）の再開の文: 手が空くのを待つ送り方で、欠けず・囲みなしで届く
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
    await run.manager.submit(run.sessionId!, CHIP_TEXT, [], [LONG_PASTE, LONG_LINE]);
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

describe(`Claude Code ${version} の、番号付きの行で始まる入力欄`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // 親セッションの ID（親からの指示の目印に入れる）
  const PARENT = '11111111-2222-4333-8444-555555555555';

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

  // 入力欄の最初の行（❯ の行）が番号付きの行になると、メニューのカーソルのある選択肢（❯ 1. Yes）と同じ形になる。選択メニューと読むと、
  // 残りを打つのも Enter もやめて、発言が入力欄に残る（実機で、親セッションが始めた子への最初の指示が、打ちかけのまま止まった。
  // チャットには、指示の中の番号付きの行が選択肢として出て、押しても何も起きなかった）
  it('番号付きの行で終わる長い発言を打つと、入力欄の見えているいちばん上の行が番号付きになるが、選択メニューではなく入力欄として読める', async () => {
    const before = turnEnds(run);
    const attentions = run.attentions.length;
    await typeLikeApp(run, NUMBERED_LINES);
    // 入力欄の高さには上限があり（40 行の画面で 15 行）、中身がスクロールして、見えているいちばん上の行に ❯ が付く
    expect(run.lines().some((l) => /^❯\s\d+\.\s/.test(l.text))).toBe(true);
    run.capture('numbered-draft');
    checkNumberedDraft(run.screen.current, NUMBERED_LINES);
    run.type('\r');
    await run.waitFor('ターンの終わり', () => turnEnds(run) > before, 30_000);
    checkPasted(eventsOf(run), NUMBERED_LINES);
    expect(run.attentions.slice(attentions)).toEqual([]);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '');
  });

  it('番号付きの手順が続く長い指示が、手が空くのを待つ送り方（親セッションからの指示）で、打っている途中で止まらずに届く', async () => {
    const attentions = run.attentions.length;
    await run.manager.submitWhenReady(run.sessionId!, parentMessageText(PARENT, NUMBERED_PROMPT), 30_000);
    await run.waitFor('指示が届く', () => run.chatEvents.some((e) => e.type === 'user' && e.parent === PARENT), 30_000);
    expect(run.chatEvents.find((e) => e.type === 'user' && e.parent === PARENT)).toMatchObject({ text: NUMBERED_PROMPT });
    expect(run.attentions.slice(attentions)).toEqual([]);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '', 30_000);
  });

  it('1 行めから番号で始まる長い発言が、チャットの入力欄からの送り方で、途中で切れずに全文届く', async () => {
    // 手が空くのを待たない送り方は、メニューが出ても Enter を送る。選択メニューと読むと、打つのをやめたところまでの文が送られる
    const attentions = run.attentions.length;
    await run.manager.submit(run.sessionId!, NUMBERED_FIRST);
    await run.waitFor('発言が届く', () => eventsOf(run).some((e) => e.type === 'user' && e.text.startsWith('1. 手順 1')), 30_000);
    checkPasted(eventsOf(run), NUMBERED_FIRST);
    expect(run.attentions.slice(attentions)).toEqual([]);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '', 30_000);
  });
});

// 上限いっぱいの再開の文（最適化圧縮で、新しい会話の最初に送る文）。アプリの resumeText で、どの部分も上限まで埋める:
// 決定事項と「いまの状態」のカード（24,000 文字）・発言の原文（12,000 文字）・切り替える前の最後の応答（3,000 文字）。
// 合わせると上限を超えるので、終わり（最後の応答の途中）は上限で切られる。
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
    tasks: [],
    reply: prose(3000, 3000),
    language: 'ja',
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
    run?.stop();
    await api?.stop();
  });

  it('上限（4 万文字）の再開の文が、手が空くのを待つ送り方（最適化圧縮と同じ道）で、1 文字も欠けず・囲みなしで Claude に届く', async () => {
    const text = fullResumeText();
    const bytes = new TextEncoder().encode(text).length;
    // 上限まで埋まっている（どの部分も入っていて、終わりは上限で切られている）
    expect(text.length).toBeGreaterThan(RESUME_MAX_CHARS - 20);
    expect(text.length).toBeLessThanOrEqual(RESUME_MAX_CHARS);
    for (const part of ['# 決定事項', '# いまの状態', '# What the user said', '# Your last reply before the reset']) expect(text).toContain(part);
    expect(bytes).toBeGreaterThan(90_000);
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.draft === '');
    // pty に書いた時刻（1 つの分を書いてから次を書くまでが、打った分が入力欄に出るのを待った時間）
    const pty = run.manager['runtimes'].get(run.sessionId!)!.process!;
    const write = pty.write.bind(pty);
    const writes: number[] = [];
    pty.write = (data: string) => {
      writes.push(Date.now());
      write(data);
    };
    const attentions = run.attentions.length;
    const started = Date.now();
    await run.manager.submitWhenReady(run.sessionId!, text, 10_000);
    const typedMs = Date.now() - started;
    pty.write = write;
    // 会話の呼び出し（発言で終わる）を見る。タイトル作りの呼び出しにも、発言の文が入っている（あとに頼みの文が続く）
    const sent = () => api.lastPrompts.find((prompt) => prompt.includes(`<${RESUME_TAG}>`) && prompt.trimEnd().endsWith(`</${RESUME_TAG}>`));
    await run.waitFor('Claude に届く', () => sent() !== undefined, 60_000);
    const arrivedMs = Date.now() - started;
    const waits = writes.slice(1).map((time, i) => time - writes[i]);
    console.info(
      `再開の文 ${text.length} 文字・${bytes} バイト・${text.split('\n').length} 行: 打ち終えるまで ${typedMs} ms・Claude に届くまで ${arrivedMs} ms・` +
        `書いた回数 ${writes.length}・1 つの分を待った時間は最大 ${Math.max(...waits)} ms`,
    );
    // Claude（モックの API）が受け取った発言。送った文と 1 文字も違わない
    const got = sent()!;
    const received = got.slice(got.indexOf(`<${RESUME_TAG}>`));
    // 違うときは、全文（4 万文字）ではなく、はじめに違うところの前後を出す
    let diff = 0;
    while (diff < text.length && text[diff] === received[diff]) diff++;
    const around = (whole: string) => `${diff} 文字目: ${whole.slice(Math.max(0, diff - 40), diff + 40)}`;
    if (received !== text) expect(around(received)).toBe(around(text));
    expect(received).toHaveLength(text.length);
    // 貼り付けの囲み・入力欄の目印・貼り付けの合図のかけら（ESC [200~ が割れて残った 200~ など）が混ざっていない
    expect(got).not.toMatch(/<\/?pasted_content|\[Pasted text|Truncated text|\x1b|\[?20[01]~/);
    // 会話ログの発言も同じ（アプリは、ここから再開の知らせを作る）
    const logged = () =>
      run.entries
        .filter((e) => e.type === 'user')
        .map((e) => e.message?.content)
        .map((content) => (typeof content === 'string' ? content : (content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')))
        .filter((content) => content.includes(`<${RESUME_TAG}>`));
    await run.waitFor('会話ログに出る', () => logged().length > 0, 30_000);
    expect(logged()).toEqual([text]);
    expect(eventsOf(run).filter((e) => e.type === 'notice' && e.compact === 'resume')).toHaveLength(1);
    // 1 つの分が入力欄に出るのを待ちきれなかった（TYPED_MS = 3 秒。そのあとは、残りを待たずに書く）ことが無い
    expect(Math.max(...waits)).toBeLessThan(3000);
    // 操作できない画面・メニューの知らせが出ていない
    expect(run.attentions.slice(attentions)).toEqual([]);
    await run.waitFor('入力欄に戻る', (info) => info.state.kind === 'prompt' && info.draft === '', 30_000);
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
