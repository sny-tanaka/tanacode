import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent } from '@shared/chat';
import { USAGE_RESUME_TAG, usageResumeText } from '@shared/usage-limit';
import { ScheduledMessages } from '../../src/main/scheduled-messages';
import { UsageLimitResume } from '../../src/main/usage-limit-resume';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, usageLimitFailure } from './mock-api';

// 本物の claude をモックの API で動かし、プランの利用枠に当たって止まったことを、アプリと同じ部品で読めるか。
// モックは、はじめの応答の代わりに 429 と枠のヘッダーを返す（OAuth のトークンで動かす。API キーでは、Claude Code は枠として読まない）。
// - 会話ログの合成の応答の行（apiError: usage_limit_reached・枠が戻る時刻）が、時刻の付いた API エラーとしてチャットに出る
// - ターンの終わりに SessionManager が止まったことを知らせ（onTurnLimit）、アプリと同じ UsageLimitResume が、枠が戻る 1 分後に予約を入れる
// - 予約を今すぐ送ると、囲みに入れた再開のメッセージが Claude に届き、チャットには知らせとして出る。止まらずに終わったら、予約はもう無い

const PROMPT = '税率を可変にしてください';
const DONE = '続きを終えました';
const version = claudeVersion();

describe(`Claude Code ${version} とプランの利用枠`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  let dir: string;
  let scheduled: ScheduledMessages | null = null;
  let resume: UsageLimitResume | null = null;
  // 枠が戻る時刻（ヘッダーは秒で渡る）
  const reset = Math.floor(Date.now() / 1000) * 1000 + 3 * 60 * 60_000;
  const errors = () => run.chatEvents.filter((e): e is Extract<ChatEvent, { type: 'api-error' }> => e.type === 'api-error');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-usage-limit-'));
    api = new MockApi();
    // 再開のあとの応答。断られた合成の応答を、Claude Code が次の呼び出しに入れるかに関わらず、同じ文を返す
    api.conversations = [{ match: PROMPT, steps: [[{ type: 'text', text: DONE }], [{ type: 'text', text: DONE }]], failures: { 0: usageLimitFailure(reset, 1) } }];
    run = new ClaudeRun(await api.start(), { oauth: true, onTurnLimit: (id, limit) => resume?.turnEnded(id, limit) });
    await run.open();
    // アプリと同じく、止まったセッションの再開の予約を、予約の置き場（このセッションの SessionManager が送る）に入れる
    scheduled = new ScheduledMessages(join(dir, 'scheduled-messages.json'), run.manager, () => {});
    scheduled.start();
    resume = new UsageLimitResume({ scheduled: () => scheduled, enabled: () => true, parentOf: (id) => run.manager.parentOf(id), terminal: (id) => !!run.manager.summary(id)?.terminal });
  });

  afterAll(async () => {
    scheduled?.dispose();
    await run?.stop();
    await api?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('はじめの応答が利用枠で断られると、枠が戻る時刻の付いた API エラーがチャットに出て、ターンの終わりに止まったと知らせる（再試行はしない）', async () => {
    await run.send(PROMPT);
    await run.waitUntil('利用枠で止まる', () => run.turnLimits.length === 1 && run.idle, 30_000);
    expect(run.turnLimits).toEqual([{ resetsAt: reset, window: 'five_hour' }]);
    expect(errors()).toEqual([expect.objectContaining({ retrying: false, limit: { resetsAt: reset, window: 'five_hour' } })]);
    // Claude Code の英語の文（「You've hit your session limit」）の代わりに、戻る時刻を出す
    expect(errors()[0]!.text).not.toContain("You've hit");
    // 会話ログの合成の応答の行（チャットの元）。断られた呼び出しは 1 回だけ
    expect(run.entries.find((e) => e.isApiErrorMessage)).toMatchObject({ apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: reset / 1000, rateLimitType: 'five_hour' } } });
    expect(api.calls).toHaveLength(1);
  });

  it('枠が戻る時刻の 1 分後に、続きを頼むメッセージを予約する', () => {
    expect(scheduled!.list()).toMatchObject([{ sessionId: run.sessionId, by: 'usage-limit', text: usageResumeText(), at: reset + 60_000, limitResetsAt: reset, state: 'scheduled' }]);
    expect(resume!.noticeOf(run.sessionId!)).toEqual({ resumeAt: reset + 60_000, resetsAt: reset });
  });

  it('予約を今すぐ送ると、囲みに入れた再開のメッセージが Claude に届き、チャットには知らせとして出る。止まらずに終わったので、もう止まったことにしない', async () => {
    scheduled!.sendNow(scheduled!.list()[0]!.id);
    await run.waitUntil('再開のあとのターンが終わる', () => run.turnLimits.length === 2 && run.idle && run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === DONE), 30_000);
    expect(api.lastPrompts.some((p) => p.includes(`<${USAGE_RESUME_TAG}>`))).toBe(true);
    expect(run.chatEvents.filter((e) => e.type === 'notice' && e.detail?.includes('The usage limit')).length).toBe(1);
    expect(run.turnLimits[1]).toBeNull();
    expect(scheduled!.list()).toEqual([]);
    expect(resume!.noticeOf(run.sessionId!)).toBeNull();
  });
});
