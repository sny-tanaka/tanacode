import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 一覧とチャットの見出しからの、セッションの操作。名前を変える・作業を HTML に書き出す・アーカイブして戻す（戻すと同じ会話を続けられる）

const PROMPT = 'セッションの操作を試してください';
const FIRST = 'はじめの返事です';
const AGAIN = 'アーカイブから戻した返事です';
const NAME = '操作を試すセッション';

describe('セッションを、一覧とチャットの見出しから操作する', () => {
  let app: E2EApp;
  const row = () => app.page.locator('.session-list .session-row', { hasText: NAME });

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: FIRST }], [{ type: 'text', text: AGAIN }]] }],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`session-ops-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('一覧の名前をダブルクリックして変えると、見出しにも出て、記録に残る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', FIRST).waitFor();
    await app.byText('.session-list .session-title', PROMPT).dblclick();
    await app.page.fill('.session-list input.session-rename', NAME);
    await app.page.keyboard.press('Enter');
    await row().waitFor();
    await app.byText('.claude-header .claude-title', NAME).waitFor();
    // 一覧の記録（userData/sessions.json）にも書かれ、アプリを起動し直しても残る
    await app.waitUntil('名前が記録に書かれる', () => readFileSync(join(app.userData, 'sessions.json'), 'utf8').includes(NAME));
  });

  it('作業を HTML に書き出すと、選んだ場所に本人だけが読めるファイルで保存される', async () => {
    const file = join(app.root, 'export.html');
    await app.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, file);
    await app.page.click('.claude-header [aria-label="作業を書き出す…"]');
    const save = app.page.locator('.export-dialog .export-dialog-foot .send-button');
    await save.waitFor();
    await app.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.export-dialog .export-dialog-foot .send-button')?.disabled);
    await save.click();
    await app.byText('.export-dialog .export-dialog-status.ok', '保存しました').waitFor();
    const html = readFileSync(file, 'utf8');
    expect(html).toContain(PROMPT);
    expect(html).toContain(FIRST);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await app.byText('.export-dialog .export-dialog-foot .send-button', '閉じる').click();
    await app.page.locator('.export-dialog').waitFor({ state: 'detached' });
  });

  it('アーカイブすると、アーカイブ済みに移る', async () => {
    await row().hover();
    await row().locator('[aria-label="アーカイブ"]').click();
    await app.byText('.session-list .pane-heading', 'アーカイブ済み（1）').click();
    await app.page.locator('.session-list .session-row.archived', { hasText: NAME }).waitFor();
  });

  it('一覧の「アクティブに戻す」で戻して送ると、Claude Code を再開して同じ会話を続けられる', async () => {
    const archived = app.page.locator('.session-list .session-row.archived', { hasText: NAME });
    await archived.hover();
    await archived.locator('[aria-label="アクティブに戻す"]').click();
    await app.page.locator('.session-list .session-row:not(.archived)', { hasText: NAME }).click();
    await app.byText('.chat-list', FIRST).waitFor();
    // アーカイブで止めた Claude Code を、待機中と取り違えない（送った指示が消えない）
    await app.send('続けてください');
    await app.byText('.chat-list', AGAIN).waitFor();
    expect(app.api.lastPrompts).toContain('続けてください');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
