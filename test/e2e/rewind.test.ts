import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 発言の横の「ここまで戻す」で、その発言の前まで会話を戻す（rewind_conversation）。戻した発言は入力欄に戻り、チャットからは消える
// （順番待ちの吹き出しにも残らない）。画面を読み直しても同じ。戻したあとの発言から、会話が続く

const PROMPT = '巻き戻しを試します（REWIND）';
const SECOND = '戻す発言です';
const AFTER = '戻したあとの発言です';

describe('会話を戻す', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      // 返事は、会話の中の返事の数で決まる。戻したあとの発言への返事も、ふたつめの返事になる
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: 'はじめの返事です' }], [{ type: 'text', text: 'ふたつめの返事です' }]] }],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`rewind-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('発言を 2 つ送り、どちらにも返事が出る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', 'はじめの返事です').waitFor();
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
    await app.send(SECOND);
    await app.byText('.chat-list', 'ふたつめの返事です').waitFor();
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
  });

  it('ふたつめの発言の前まで会話を戻すと、その発言は入力欄に戻り、チャットにも順番待ちにも残らない。画面を読み直しても同じ', async () => {
    const row = app.page.locator('.chat-list .chat-user', { hasText: SECOND });
    await row.hover();
    await row.locator('.chat-rewind').click();
    await app.choose(app.page.locator('.menu-card.rewind'), '会話を戻す');
    await app.page.waitForFunction((text) => document.querySelector<HTMLTextAreaElement>('.chat-input textarea')?.value === text, SECOND);
    await app.byText('.chat-list', 'ふたつめの返事です').waitFor({ state: 'detached' });
    // 直す前は、戻した発言を送ったときの順番待ちの知らせが残り、チャットの下に順番待ちの吹き出しで出ていた
    expect(await app.byText('.chat-list .chat-user', SECOND).count()).toBe(0);
    expect(await app.byText('.chat-list', 'はじめの返事です').count()).toBe(1);
    await app.page.reload();
    await app.byText('.chat-list', 'はじめの返事です').waitFor();
    expect(await app.byText('.chat-list .chat-user', SECOND).count()).toBe(0);
  });

  it('戻したあとに送った発言から、会話が続く', async () => {
    await app.send(AFTER);
    await app.byText('.chat-list', 'ふたつめの返事です').waitFor();
    expect(await app.byText('.chat-list .chat-user', AFTER).count()).toBe(1);
    expect(await app.byText('.chat-list .chat-user', SECOND).count()).toBe(0);
    expect(app.api.lastPrompts.at(-1)).toContain(AFTER);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
