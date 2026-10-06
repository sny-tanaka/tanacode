import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents, type ChatEvent } from '@shared/chat';
import { readChatLog } from '../../src/main/chat-log';
import {
  BAD_REQUEST_PROMPT,
  EARLY_PROMPT,
  ENV,
  NOTES,
  NOTES_AFTER,
  OVERLOADED_PROMPT,
  RESUME_PROMPT,
  RETRY_PROMPT,
  SETTINGS,
  TOOLS_PROMPT,
  TOOLS_REPLY,
  TOOL_PROMPT,
  WAIT_PROMPT,
  checkBadRequest,
  checkEarlyDraft,
  checkEarlyInterrupt,
  checkOverloaded,
  checkPromptBack,
  checkResumed,
  checkRetried,
  checkToolErrors,
  checkToolInterrupt,
  checkWaitInterrupt,
  conversationsFor,
} from '../scenarios/errors';
import { ClaudeRun, claudeVersion, sleep, type Seen } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、失敗や中断を、アプリと同じ部品で読めるかを確かめる。
// 台本（test/scenarios/errors.ts）: 応答の前の Esc → 応答を待つ間の Esc → ツールの実行中の Esc → --resume → API エラー
// （529 の再試行・529 のあきらめ・400）→ ツールの失敗・PreToolUse の hooks で止める・Write と Edit の差分・Stop の hooks。
// 台本ごとに /clear で会話を分ける（モックは会話のはじめの発言で台本を選ぶため）

const version = claudeVersion();
// 入力欄を消したあと、空のままかを見る時間
const DRAFT_SETTLE_MS = 1000;

describe(`Claude Code ${version} の失敗と中断`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // 台本ごとの、会話ログの行の始まり（run.seen の位置）
  let from = 0;
  const seen = (): Seen[] => run.seen.slice(from);
  const events = (list: Seen[] = seen()): ChatEvent[] => list.flatMap((s) => toChatEvents(s.entry, run.cwd));
  const has = (check: (e: ChatEvent) => boolean) => () => events().some(check);
  const idle = () => run.activities.at(-1) === null || run.activities.length === 0;

  // 新しい会話にして、発言を送る。前の台本の文字が入力欄に残っていると、発言の頭に付いて送られるので、空なのを確かめてから打つ
  async function begin(prompt: string, { clear = true } = {}): Promise<void> {
    await run.waitFor('入力欄が空', (info) => info.state.kind === 'prompt' && info.draft === '');
    if (clear) {
      const mark = run.seen.length;
      await run.send('/clear');
      // statusLine の会話ログのパスで新しい会話ログに乗り換え、/clear の行（発言とターンの終わり）を読み終えるまで待つ
      await run.waitFor('/clear のあとの乗り換え', (info) => {
        const after = events(run.seen.slice(mark));
        const cleared = after.findIndex((e) => e.type === 'user' && e.text === '/clear');
        return cleared !== -1 && after.slice(cleared).some((e) => e.type === 'turn-end') && info.state.kind === 'prompt';
      });
    }
    from = run.seen.length;
    await run.send(prompt);
  }

  // 入力欄に戻った発言を、アプリと同じく Claude Code の入力欄から消す（Ctrl+U）。
  // CI で、消して空になったのを見たすぐあとに、中断した発言がまた入力欄に入っていて、次の台本の発言の頭に付いて
  // 送られたことがある。空になってからもしばらく空のままかを見て、また入ったら消し直す
  async function clearDraft(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      run.type('\x15'.repeat(run.screen.current.draft.split('\n').length));
      await run.waitFor('入力欄が空になる', (info) => info.state.kind === 'prompt' && info.draft === '');
      const until = Date.now() + DRAFT_SETTLE_MS;
      while (Date.now() < until && run.screen.current.draft === '') await sleep(50);
      if (run.screen.current.draft === '') return;
    }
    throw new Error(`入力欄が空のままになりません\n${run.dump()}`);
  }

  // 許可の確認が出たら「Yes」で答えながら、done になるまで待つ
  async function untilDone(label: string, done: () => boolean, timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const next = await run.waitFor(label, (info) => (done() ? 'done' : info.state.kind === 'menu' && info.state.menu.kind === 'permission' ? info.state.menu : null), until - Date.now());
      if (next === 'done') return;
      await run.answer(next.title, next.options[0].id);
    }
  }

  beforeAll(async () => {
    api = new MockApi();
    run = new ClaudeRun(await api.start(), { settings: SETTINGS, env: ENV });
    api.conversations = conversationsFor(run.cwd);
    await run.open();
  });

  afterAll(async () => {
    if (process.env.TANACODE_RECORD) run?.recordScreens(join('test', 'fixtures', 'claude-code', version));
    run?.stop();
    await api?.stop();
  });

  it('応答の前に Esc で中断すると、発言が入力欄に戻り、ターンが終わる', async () => {
    await begin(EARLY_PROMPT, { clear: false });
    // 何かの発言ではなく、送った発言そのものが会話ログに書かれ、応答を待っているところで中断する
    await run.waitFor('応答を待つ', () => run.activities.at(-1)?.phase === 'waiting' && events().some((e) => e.type === 'user' && e.text === EARLY_PROMPT));
    run.type('\x1b');
    await run.waitFor('入力欄に戻る', (info) => idle() && info.state.kind === 'prompt' && info.draft === EARLY_PROMPT);
    run.capture('interrupt-draft');
    checkEarlyDraft(run.screen.current);
    checkEarlyInterrupt(events(), run.screen.current.draft);
    await clearDraft();
  });

  it('応答を待つ間に Esc で中断すると、中断の行でターンが終わり、入力欄に戻る', async () => {
    await begin(WAIT_PROMPT, { clear: false });
    // 1 つ目の応答のツールが終わって、2 つ目の応答を待っている間に中断する
    await run.waitFor('ツールの結果', has((e) => e.type === 'tool-result' && e.id === 'toolu_wait'), 30_000);
    await run.waitFor('2 つ目の応答を待つ', () => !idle());
    run.type('\x1b');
    await run.waitFor('ターンの終わり', has((e) => e.type === 'turn-end'));
    await run.waitFor('入力欄に戻る', (info) => idle() && info.state.kind === 'prompt');
    checkPromptBack(run.screen.current);
    checkWaitInterrupt(
      seen().map((s) => s.entry),
      events(),
    );
    // 応答の前に中断した発言は、会話から外れる。会話ログを読み直しても出ない
    const log = await readChatLog(run.transcript(), run.cwd);
    expect(log.filter((e) => e.type === 'user').map((e) => (e as { text: string }).text)).toEqual([WAIT_PROMPT]);
  });

  it('ツールの実行中に Esc で中断すると、ツールが中断になり、入力欄に戻る', async () => {
    await begin(TOOL_PROMPT);
    await untilDone('ツールの実行', () => events().some((e) => e.type === 'tool-use' && e.id === 'toolu_long') && run.activities.at(-1)?.phase === 'working');
    run.type('\x1b');
    await run.waitFor('ターンの終わり', has((e) => e.type === 'turn-end'));
    await run.waitFor('入力欄に戻る', (info) => idle() && info.state.kind === 'prompt');
    run.capture('tool-interrupted');
    checkPromptBack(run.screen.current);
    checkToolInterrupt(
      seen().map((s) => s.entry),
      events(),
    );
  });

  it('中断した会話を --resume で再開すると、作業中にならず、<synthetic> の応答はチャットに出ない', async () => {
    run.stopClaude();
    const start = run.seen.length;
    run.start({ resume: true });
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready && run.historyLoaded);
    const history = run.seen.slice(start).filter((s) => s.isHistory);
    from = run.seen.length;
    await run.send(RESUME_PROMPT);
    await run.waitFor('再開後の返事', has((e) => e.type === 'turn-end'), 30_000);
    checkResumed(
      events(history),
      seen().map((s) => s.entry),
      events(),
    );
  });

  it('529 で一度失敗しても、再試行で返事が届く', async () => {
    await begin(RETRY_PROMPT);
    await run.waitFor('ターンの終わり', has((e) => e.type === 'turn-end'), 30_000);
    checkRetried(events());
    // 1 回目は 529、再試行した 2 回目で応答した
    const requests = api.requests.filter((r) => r.includes(`「${RETRY_PROMPT}」の会話`));
    expect(requests).toHaveLength(2);
    expect(api.requests.filter((r) => r.includes('API エラー 529'))).toHaveLength(1);
  });

  it('529 が続いて再試行をあきらめると、API エラーが出る', async () => {
    await begin(OVERLOADED_PROMPT);
    await run.waitFor('ターンの終わり', has((e) => e.type === 'turn-end'), 40_000);
    checkOverloaded(events());
  });

  it('400 が返ると、再試行せずに API エラーが出る', async () => {
    await begin(BAD_REQUEST_PROMPT);
    await run.waitFor('ターンの終わり', has((e) => e.type === 'turn-end'), 30_000);
    await run.waitFor('入力欄に戻る', (info) => idle() && info.state.kind === 'prompt');
    checkBadRequest(events());
  });

  it('新しい会話の最初の発言から、ツールの失敗・hooks で止めたツール・Write と Edit の差分・Stop の hooks が読める', async () => {
    // 新しいセッションで、新しい会話にする（/clear ではなく、会話ログがまだ無い状態から。
    // Claude Code は新しい会話ログを作るとき、最初の応答の行を発言の行より先に書くことがある）
    run.newSession();
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    await begin(TOOLS_PROMPT, { clear: false });
    await untilDone('ツールの確認の返事', () => events().some((e) => e.type === 'assistant-text' && e.text === TOOLS_REPLY) && events().some((e) => e.type === 'turn-end'), 60_000);
    checkToolErrors(events(), run.cwd);
    expect(readFileSync(join(run.cwd, NOTES), 'utf8')).toBe(NOTES_AFTER);
  });
});
