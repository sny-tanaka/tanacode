import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// アプリを閉じても Claude Code は pty ホストの中で動き続け、起動し直したアプリが引き継ぐ。
// 引き継いだあとも、チャットの続きと Claude Code の画面がそのまま使える。
// チャットの見出しの「再起動」では、Claude Code を起動し直して（--resume）同じ会話を続ける

const PROMPT = '起動し直しても続けてください';
const FIRST = 'はじめの返事です';
const SECOND = 'つづきの返事です';
const THIRD = '再起動のあとの返事です';
const FOURTH = 'チャットに戻ってからの返事です';

describe('アプリを起動し直しても、Claude Code の会話を続けられる', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        {
          match: PROMPT,
          steps: [[{ type: 'text', text: FIRST }], [{ type: 'text', text: SECOND }], [{ type: 'text', text: THIRD }], [{ type: 'text', text: FOURTH }]],
        },
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

  // ターミナルモードの中身（TUI）は Claude Code そのものなので、画面は読まない・キーは押さない（決めたこと）。確かめるのはアプリの側だけ
  it('ターミナルモードのまま「動かしたまま終了」で起動し直すと、ターミナルモードのまま引き継ぐ。チャットに戻すと会話が続く', async () => {
    // 切り替えは手が空いているときだけ（返事が出たあとも、ターンが閉じるまでは作業中）
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
    await app.page.click('.claude-header [aria-label="ターミナルモード"]');
    await app.byText('.session-list .session-row', 'ターミナルモード').waitFor();
    await app.page.locator('.claude .claude-screen').waitFor();
    // チャットと入力欄は隠す
    expect(await app.page.locator('.chat-list-wrap').isVisible()).toBe(false);
    expect(await app.page.locator('.chat-input-wrap').isVisible()).toBe(false);
    await app.restart();
    await app.byText('.session-list .session-row', PROMPT).click();
    // 引き継いだ TUI は、チャットに戻さずにターミナルモードのまま出す
    await app.byText('.session-list .session-row', 'ターミナルモード').waitFor();
    await app.page.locator('.claude .claude-screen').waitFor();
    expect(await app.page.locator('.chat-list-wrap').isVisible()).toBe(false);
    // チャットに戻すときは、Claude Code の画面の書きかけが消えることを確かめる
    const dialogs: string[] = [];
    app.page.once('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    await app.page.click('.claude-header [aria-label="ターミナルモード"]');
    await app.page.locator('.chat-list-wrap').waitFor();
    await app.page.locator('.claude .claude-screen').waitFor({ state: 'detached' });
    expect(dialogs[0]).toContain('書きかけ');
    await app.byText('.chat-list', THIRD).waitFor();
    // 戻したあとも、同じ会話が続く（発言がモックの API に届き、返事がチャットに出る）
    await app.byText('.statusbar', 'Claude Code 待機中').waitFor();
    await app.send('チャットに戻りました');
    await app.byText('.chat-list', FOURTH).waitFor();
    expect(app.api.lastPrompts).toContain('チャットに戻りました');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
