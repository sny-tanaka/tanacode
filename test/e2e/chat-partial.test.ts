import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

const PROMPT = 'パンの作り方を教えて';
const ANSWER = 'パンは小麦粉と水と酵母でできます';

// 書いている途中の文（stream_event）が、アプリの画面のチャットに出て、会話ログに出たら同じ場所で本文に入れ替わるまで。
// 画面は途中の文をチャットとは別に持ち、途中の文の行だけを描き直す（chat/chatState.ts の PartialSource）。入れ替わるときに、
// 途中の文も本文も無い画面を挟まない（ちらつかない）ことも、本物のブラウザ（Chromium）の書き出しごとに確かめる
describe('書いている途中の文', () => {
  let app: E2EApp;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));

  beforeAll(async () => {
    app = await E2EApp.launch({ trusted: true, conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: ANSWER }]] }] });
    // 文を書き終える（会話ログに出る）のを、テストが放すまで止める
    app.api.holdText = (text) => (text.trim() === ANSWER ? held : Promise.resolve());
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`chat-partial-${task.name}`);
  });

  afterAll(async () => {
    release();
    await app?.close();
  });

  it('書いている途中の文がチャットに出て、会話ログに出たら、途切れずに同じ場所で本文に入れ替わる', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list .chat-partial-text', ANSWER).waitFor();
    expect(await app.byText('.chat-list .chat-response:not(.partial)', ANSWER).count()).toBe(0);
    // 画面が変わるたびに、途中の文か本文のどちらかがあるかを控える（変わった知らせは、書き出しのたびに届く）
    await app.page.evaluate((answer) => {
      const list = document.querySelector('.chat-list')!;
      const seen: boolean[] = [];
      (window as unknown as { partialSeen: boolean[] }).partialSeen = seen;
      new MutationObserver(() =>
        seen.push(
          !!list.querySelector('.chat-partial-text') || [...list.querySelectorAll('.chat-response:not(.partial)')].some((e) => e.textContent?.includes(answer)),
        ),
      ).observe(list, { subtree: true, childList: true, characterData: true });
    }, ANSWER);
    release();
    await app.byText('.chat-list .chat-response:not(.partial)', ANSWER).waitFor();
    await app.page.locator('.chat-list .chat-partial-text').waitFor({ state: 'detached' });
    const seen = await app.page.evaluate(() => (window as unknown as { partialSeen: boolean[] }).partialSeen);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });
});
