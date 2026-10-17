import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent, TranscriptEntry } from '@shared/chat';
import type { PendingPermission } from '@shared/questions';
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
  checkEarlyInterrupt,
  checkOverloaded,
  checkResumed,
  checkRetried,
  checkToolErrors,
  checkToolInterrupt,
  checkWaitInterrupt,
  conversationsFor,
} from '../scenarios/errors';
import { ClaudeRun, claudeVersion, shown } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、失敗や中断を、アプリと同じ部品で読めるかを確かめる。
// 台本（test/scenarios/errors.ts）: 応答の前の中断 → 応答を待つ間の中断 → ツールの実行中の中断 → --resume → API エラー
// （529 の再試行・529 のあきらめ・400）→ ツールの失敗・PreToolUse の hooks で止める・Write と Edit の差分・Stop の hooks。
// 中断はチャットの停止のボタンと同じく session-manager の interrupt（stream-json の interrupt）。
// 台本ごとに /clear で会話を分ける（モックは会話のはじめの発言で台本を選ぶため）

const version = claudeVersion();

describe(`Claude Code ${version} の失敗と中断`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // 今の台本の発言と、送る前の会話ログの行の数（run.seen の位置）
  let prompt = '';
  let from = 0;
  const entries = (): TranscriptEntry[] => run.seen.slice(from).map((s) => s.entry);
  // 画面が持つチャット（session-manager が配信したもの）のうち、今の台本の発言から先。ターンの終わりは result から出る
  const events = (): ChatEvent[] => {
    const list = shown(run.chatEvents);
    const start = list.map((e) => e.type === 'user' && e.text === prompt).lastIndexOf(true);
    return start === -1 ? [] : list.slice(start);
  };
  const has = (check: (e: ChatEvent) => boolean) => () => events().some(check);
  const idle = () => run.waitUntil('手が空く', () => run.idle, 30_000);
  const interrupt = () => run.manager.interrupt(run.sessionId!);

  // 新しい会話にして、発言を送る
  async function begin(text: string, { clear = true } = {}): Promise<void> {
    await idle();
    if (clear) {
      const switched = run.switches.length;
      await run.send('/clear');
      await run.waitUntil('/clear のあとの乗り換え', () => run.switches.length > switched, 30_000);
      await idle();
    }
    prompt = text;
    from = run.seen.length;
    await run.send(text);
  }

  // 許可の確認が来たら許しながら、done になるまで待つ
  async function untilDone(label: string, done: () => boolean, timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    const answered = new Set<string>();
    const asked = (): PendingPermission | null => {
      const permission = run.manager.pendingPermission(run.sessionId!);
      return permission && !answered.has(permission.id) ? permission : null;
    };
    for (;;) {
      const next = await run.waitUntil(label, () => (done() ? 'done' : asked()), until - Date.now());
      if (next === 'done') return;
      answered.add(next.id);
      run.replyPermission(next, { kind: 'allow' });
    }
  }

  beforeAll(async () => {
    api = new MockApi();
    run = new ClaudeRun(await api.start(), { settings: SETTINGS, env: ENV });
    api.conversations = conversationsFor(run.cwd);
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('応答の前に中断すると、発言は会話に残り、ターンが終わる', async () => {
    await begin(EARLY_PROMPT, { clear: false });
    // 送った発言そのものが会話ログに書かれ、応答を待っているところで中断する
    await run.waitUntil('応答を待つ', () => run.activities.at(-1)?.phase === 'waiting' && run.seen.slice(from).some((s) => s.entry.type === 'user'));
    interrupt();
    await run.waitUntil('ターンの終わり', has((e) => e.type === 'turn-end'));
    await idle();
    checkEarlyInterrupt(entries(), events());
    // 会話ログを読み直しても、発言は残っている（TUI と違い、入力欄に戻して会話から外すことはない）
    const log = await readChatLog(run.transcript(), run.cwd);
    expect(log.filter((e) => e.type === 'user').map((e) => (e as { text: string }).text)).toEqual([EARLY_PROMPT]);
  });

  it('応答を待つ間に中断すると、中断でターンが終わる', async () => {
    // 前の発言が会話に残っていても、モックは会話のはじめの発言のうち後ろのもので台本を選ぶ
    await begin(WAIT_PROMPT, { clear: false });
    // 1 つ目の応答のツールが終わって、2 つ目の応答を待っている間に中断する
    await run.waitUntil('ツールの結果', has((e) => e.type === 'tool-result' && e.id === 'toolu_wait'), 30_000);
    await run.waitUntil('2 つ目の応答を待つ', () => !run.idle);
    interrupt();
    await run.waitUntil('ターンの終わり', has((e) => e.type === 'turn-end'));
    await idle();
    checkWaitInterrupt(entries(), events());
  });

  it('ツールの実行中に中断すると、ツールが中断になり、ターンが終わる', async () => {
    await begin(TOOL_PROMPT);
    await untilDone('ツールの実行', () => events().some((e) => e.type === 'tool-use' && e.id === 'toolu_long') && run.activities.at(-1)?.phase === 'working');
    interrupt();
    await run.waitUntil('ターンの終わり', has((e) => e.type === 'turn-end'));
    await idle();
    checkToolInterrupt(entries(), events());
  });

  it('中断した会話を --resume で再開すると、作業中にならず、<synthetic> の応答はチャットに出ない', async () => {
    run.stopClaude();
    await run.waitUntil('終了', () => run.chatEvents.at(-1)?.type === 'process-exit');
    run.start({ resume: true });
    await run.untilState('起動', (state) => state === 'idle', 30_000);
    expect(run.historyLoaded).toBe(true);
    const history = shown(run.chatEvents);
    prompt = RESUME_PROMPT;
    from = run.seen.length;
    await run.send(RESUME_PROMPT);
    await run.waitUntil('再開後の返事', has((e) => e.type === 'turn-end'), 30_000);
    checkResumed(history, entries(), events());
  });

  it('529 で一度失敗しても、再試行で返事が届く', async () => {
    await begin(RETRY_PROMPT);
    await run.waitUntil('ターンの終わり', has((e) => e.type === 'turn-end'), 30_000);
    checkRetried(events());
    // 1 回目は 529、再試行した 2 回目で応答した
    const requests = api.requests.filter((r) => r.includes(`「${RETRY_PROMPT}」の会話`));
    expect(requests).toHaveLength(2);
    expect(api.requests.filter((r) => r.includes('API エラー 529'))).toHaveLength(1);
  });

  it('529 が続いて再試行をあきらめると、API エラーが出る', async () => {
    await begin(OVERLOADED_PROMPT);
    await run.waitUntil('ターンの終わり', has((e) => e.type === 'turn-end'), 40_000);
    checkOverloaded(events());
  });

  it('400 が返ると、再試行せずに API エラーが出る', async () => {
    await begin(BAD_REQUEST_PROMPT);
    await run.waitUntil('ターンの終わり', has((e) => e.type === 'turn-end'), 30_000);
    await idle();
    checkBadRequest(events());
  });

  it('新しい会話の最初の発言から、ツールの失敗・hooks で止めたツール・Write と Edit の差分・Stop の hooks が読める', async () => {
    // 新しいセッションで、新しい会話にする（/clear ではなく、会話ログがまだ無い状態から）
    run.newSession();
    await run.untilState('起動', (state) => state === 'idle', 30_000);
    await begin(TOOLS_PROMPT, { clear: false });
    await untilDone('ツールの確認の返事', () => events().some((e) => e.type === 'assistant-text' && e.text === TOOLS_REPLY) && events().some((e) => e.type === 'turn-end'), 60_000);
    checkToolErrors(events(), run.cwd);
    expect(readFileSync(join(run.cwd, NOTES), 'utf8')).toBe(NOTES_AFTER);
  });
});
