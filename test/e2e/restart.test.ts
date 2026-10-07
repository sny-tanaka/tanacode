import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// アプリを閉じても Claude Code は pty ホストの中で動き続け、起動し直したアプリが引き継ぐ。
// 引き継いだあとも、チャットの続きと Claude Code の画面がそのまま使える。
// チャットの見出しの「再起動」では、Claude Code を起動し直して（--resume）同じ会話を続ける

const PROMPT = '起動し直しても続けてください';
const FIRST = 'はじめの返事です';
const SECOND = 'つづきの返事です';
const THIRD = '再起動のあとの返事です';

describe('アプリを起動し直しても、Claude Code の会話を続けられる', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: PROMPT, steps: [[{ type: 'text', text: FIRST }], [{ type: 'text', text: SECOND }], [{ type: 'text', text: THIRD }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`restart-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('はじめの返事が出る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', FIRST).waitFor();
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
  });

  it('「動かしたまま終了」で閉じて起動し直すと、同じセッションが動いたまま一覧に出て、チャットが戻る', async () => {
    await app.restart();
    const row = app.byText('.session-list .session-row', PROMPT);
    await row.waitFor();
    await row.click();
    await app.byText('.chat-list', FIRST).waitFor();
    // 引き継いだ Claude Code の画面も、そのまま描ける
    await app.page.click('.claude-header [aria-label="Claude Code の画面"]');
    await app.page.locator('.terminal-panel .terminal-instance:not([hidden]) .xterm-rows').getByText(FIRST).waitFor();
    await app.page.click('.terminal-panel [aria-label="パネルを閉じる"]');
  });

  it('引き継いだ Claude Code に続きを送れる', async () => {
    await app.send('つづけて');
    await app.byText('.chat-list', SECOND).waitFor();
    // 起動し直す前の発言も残っている
    expect(await app.byText('.chat-list', FIRST).count()).toBeGreaterThan(0);
  });

  it('「再起動」で Claude Code を起動し直しても、同じ会話を続けられる', async () => {
    await app.page.click('.claude-header [aria-label="再起動"]');
    // 起動し直すと、入力を受け付けるまで送信を預かる
    await app.send('再起動のあとも');
    await app.byText('.chat-list', THIRD).waitFor();
    expect(app.api.lastPrompts).toContain('再起動のあとも');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
