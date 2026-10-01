import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents, type ChatEvent } from '@shared/chat';
import { promptKeys } from '@shared/prompt-keys';
import { readAgentLog } from '../../src/main/chat-log';
import { KnowledgeTracker } from '../../src/main/knowledge-tracker';
import { discoverSessions } from '../../src/main/session-discovery';
import {
  AGENT_PROMPT,
  AI_TITLE,
  AI_TITLE_REPLY,
  ATTACHED,
  DRAFT,
  EFFORT,
  IMAGE_FILE,
  LONG_PASTE,
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
  agentSteps,
  checkAgentLog,
  checkAiTitle,
  checkDiscovered,
  checkDraft,
  checkEffort,
  checkImage,
  checkKilled,
  checkKnowledge,
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

  it('長い貼り付けは入力欄で目印になり、送ると全文が発言になる', async () => {
    const before = turnEnds(run);
    run.type(promptKeys(LONG_PASTE));
    await run.waitFor('貼り付けの目印', (info) => /^\[Pasted text/.test(info.draft));
    run.capture('pasted-draft');
    checkPastedDraft(run.screen.current, LONG_PASTE.split('\n').length);
    run.type('\r');
    await run.waitFor('ターンの終わり', () => turnEnds(run) > before, 30_000);
    checkPasted(eventsOf(run), LONG_PASTE);
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
