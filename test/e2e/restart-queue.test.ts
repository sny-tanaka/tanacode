import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 作業中に送って順番待ちになった発言は、チャットの見出しの「再起動」で Claude Code を起動し直しても消えず、起動し直したあとに届く
// （Claude Code は end_session で終わるとき、順番待ちの発言を捨てる。アプリが同じ発言を送り直す）

const PROMPT = 'ゆっくり返事してください（再起動の順番待ち）';
const AGAIN = 'もう一度ゆっくり返事してください';
const QUEUED = '再起動の前に順番待ちにした発言です';
const FIRST = 'はじめのゆっくりの返事です';
const LAST = '送り直した発言への返事です';

describe('再起動の前に順番待ちだった発言', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      // 返事を遅らせて、作業中に次の発言を送り、順番待ちのうちに再起動する。再起動で止めたターンの書きかけの返事が会話に残るかは
      // 止めた時点によるので、送り直した発言への返事は 2 つめでも 3 つめでも同じにする
      conversations: () => [
        { match: PROMPT, delayMs: 5000, steps: [[{ type: 'text', text: FIRST }], [{ type: 'text', text: LAST }], [{ type: 'text', text: LAST }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`restart-queue-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('作業中に送った発言が順番待ちになる', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', FIRST).waitFor({ timeout: 30_000 });
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
    await app.send(AGAIN);
    await app.byText('.statusbar', 'Claude Code 作業中').waitFor();
    await app.send(QUEUED);
    await app.byText('.chat-list .chat-user.pending', QUEUED).waitFor();
  });

  it('「再起動」で起動し直しても、順番待ちの発言は消えずに、起動し直した Claude Code に届く', async () => {
    // 作業中の再起動は、確かめてから行う
    const dialogs: string[] = [];
    app.page.once('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    const before = await app.claudePids();
    await app.page.click('.claude-header [aria-label="再起動"]');
    expect(dialogs[0]).toContain('再起動しますか');
    for (let i = 0; ; i++) {
      const after = await app.claudePids();
      if (after.length === 1 && !before.includes(after[0])) break;
      if (i > 150) throw new Error(`起動し直さない（前: ${before.join(',')} / 今: ${after.join(',')}）`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 起動し直したあとも、順番待ちの発言は残っている（直す前は、ここで消えて、二度と送られなかった）
    expect(await app.byText('.chat-list .chat-user', QUEUED).count()).toBe(1);
    // 起動し直した Claude Code に届き、返事が出る
    await app.byText('.chat-list', LAST).waitFor({ timeout: 30_000 });
    expect(app.api.lastPrompts.filter((p) => p.includes(QUEUED))).toHaveLength(1);
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
    expect(await app.byText('.chat-list .chat-user', QUEUED).count()).toBe(1);
    expect(await app.page.locator('.chat-list .chat-user.pending').count()).toBe(0);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
