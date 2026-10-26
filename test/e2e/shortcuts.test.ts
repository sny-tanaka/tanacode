import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from 'playwright';
import { E2EApp } from './app';

// メニューバーの「移動」のショートカット（⌘1〜4・⌃⌘↑↓・⌃Tab・⌘W・⌘J・⌘⇧A と、質問のカードの 1〜9）を、ビルドしたアプリで押す。
// アプリの画面で押したキーは Playwright のキー（画面に届く）で、アプリ内ブラウザのページで押したキーは、ページ（webview）の中身に
// sendInputEvent で送る（main の before-input-event を通る）。⌘W でアプリが終わらないことも確かめる。
// メニューから押したもの（mouse）は、メニューの項目の click を呼ぶ

const FIRST = 'ひとつ目のセッションです';
const FIRST_DONE = 'ひとつ目、了解';
const ASK = '質問してください';
const QUESTION = {
  question: 'どちらにしますか？',
  header: '選ぶ',
  multiSelect: false,
  options: [
    { label: '赤', description: '' },
    { label: '青', description: '' },
  ],
};
const ASK_DONE = '答えを受け取りました';

// title の題のページを返すサーバー
async function serve(title: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

describe('「移動」のショートカット', () => {
  let app: E2EApp;
  const servers: Server[] = [];
  const outline = (target: Locator) => target.evaluate((el) => getComputedStyle(el).outlineStyle);
  const isActive = (target: Locator) => target.evaluate((el) => el === document.activeElement);
  const activeIn = (selector: string) => app.page.evaluate((s) => !!document.activeElement?.closest(s), selector);
  const sessionRow = (title: string) => app.page.locator('.session-list .session-row', { hasText: title });
  const selectedTitle = () => app.page.locator('.session-list .session-row.active .session-title').textContent();
  const windows = () => app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  // アプリ内ブラウザのページ（今のタブ）にフォーカスを置き、そこでキーを押す（ページより先に main が受ける）
  const pressInPage = (keyCode: string, modifiers: string[]) =>
    app.app.evaluate(
      ({ webContents }, { keyCode, modifiers }) => {
        const guests = webContents.getAllWebContents().filter((w) => w.getType() === 'webview' && !w.isDestroyed());
        const guest = guests.find((w) => w.isFocused()) ?? guests.at(-1);
        if (!guest) throw new Error('アプリ内ブラウザのページがありません');
        guest.focus();
        guest.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers as never });
        guest.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers as never });
      },
      { keyCode, modifiers },
    );
  const browserTabs = () => app.page.locator('.preview-pane .preview-tab');

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      files: { 'README.md': '# shop\n', 'src/main.ts': 'export {};\n' },
      conversations: () => [
        { match: FIRST, steps: [[{ type: 'text', text: FIRST_DONE }]] },
        { match: ASK, steps: [[{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [QUESTION] } }], [{ type: 'text', text: ASK_DONE }]] },
      ],
    });
    await app.startSession(FIRST, { mode: 'manual' });
    await app.byText('.chat-list', FIRST_DONE).waitFor();
    await app.startSession(ASK, { mode: 'manual' });
    await app.menuCard('question');
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`shortcuts-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });

  it('メニューバーの「移動」に、キーを添えて並ぶ。ウインドウを閉じる「閉じる」（⌘W でアプリが終わる）は、どのメニューにも無い', async () => {
    const menu = await app.app.evaluate(({ Menu }) => {
      const flat = (items: Electron.MenuItem[]): { id: string; role: string; label: string; accelerator: string }[] =>
        items.flatMap((i) => [{ id: i.id ?? '', role: i.role ?? '', label: i.label, accelerator: i.accelerator ?? '' }, ...flat(i.submenu?.items ?? [])]);
      const top = Menu.getApplicationMenu()!.items;
      const go = top.find((i) => i.id === 'go')!;
      return { go: go.label, items: flat(go.submenu!.items).filter((i) => i.accelerator).map((i) => `${i.label} ${i.accelerator}`), all: flat(top) };
    });
    expect(menu.go).toBe('移動');
    expect(menu.items).toContain('タブを閉じる Cmd+W');
    expect(menu.items).toContain('ターミナルを開く・閉じる Cmd+J');
    expect(menu.all.filter((i) => i.role === 'close')).toEqual([]);
    expect(menu.all.filter((i) => /W$/.test(i.accelerator)).map((i) => i.id)).toEqual(['shortcut-closeTab']);
  });

  it('⌘1・⌘2・⌘3・⌘4 で、左のカラムから順にフォーカスを移す（セッションの行には枠を出す）', async () => {
    await app.page.keyboard.press('Meta+1');
    expect(await isActive(sessionRow(ASK))).toBe(true);
    expect(await outline(sessionRow(ASK))).toBe('solid');
    await app.page.keyboard.press('Meta+2');
    expect(await isActive(app.page.locator('.chat-input-row textarea'))).toBe(true);
    // サイドパネル: エクスプローラーで開いているファイルの行
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await app.page.locator('.tree-row[title="README.md"]').click();
    await app.page.locator('.editor-tab', { hasText: 'README.md' }).waitFor();
    await app.page.keyboard.press('Meta+2');
    await app.page.keyboard.press('Meta+3');
    expect(await isActive(app.page.locator('.tree-row[title="README.md"]'))).toBe(true);
    expect(await outline(app.page.locator('.tree-row[title="README.md"]'))).toBe('solid');
    // コンテンツ: エディタ（Markdown はプレビューなので、欄そのもの）
    await app.page.keyboard.press('Meta+4');
    expect(await activeIn('.editor-host section.editor')).toBe(true);
    // 文字のファイルなら Monaco へ
    await app.page.locator('.tree-row[title="src"]').click();
    await app.page.locator('.tree-row[title="src/main.ts"]').click();
    await app.byText('.editor-host .monaco-editor .view-line', 'export').waitFor();
    await app.page.keyboard.press('Meta+1');
    await app.page.keyboard.press('Meta+4');
    expect(await activeIn('.editor-host .monaco-editor')).toBe(true);
  });

  it('⌃⌘↓・⌃⌘↑ で、セッション一覧の並びの次・前のセッションに切り替える（端では止まる）', async () => {
    expect(await selectedTitle()).toContain(ASK);
    await app.page.keyboard.press('Control+Meta+ArrowDown');
    await app.page.locator('.session-list .session-row.active', { hasText: FIRST }).waitFor();
    await app.page.keyboard.press('Control+Meta+ArrowDown');
    await app.rendered();
    expect(await selectedTitle()).toContain(FIRST);
    await app.page.keyboard.press('Control+Meta+ArrowUp');
    await app.page.locator('.session-list .session-row.active', { hasText: ASK }).waitFor();
  });

  it('⌘⇧A で質問のカードそのものに入り、すぐの Enter では答えない。数字で選択肢へ移り（番号が出る）、Enter で答える', async () => {
    const card = await app.menuCard('question');
    const option = (label: string) => card.locator('.menu-option', { hasText: label });
    // 選択肢の頭の番号（::before）。キーで入っている間だけ出す
    const number = (label: string) => option(label).evaluate((el) => getComputedStyle(el, '::before').content);
    expect(await number('青')).toBe('none');
    // マウスでカードの自由に書ける欄を押しても、番号は出ない（直す前は、入力欄が :focus-visible になるので出ていた）
    await card.locator('textarea').click();
    await app.page.keyboard.type('1');
    expect(await number('青')).toBe('none');
    await card.locator('textarea').fill('');
    await app.page.keyboard.press('Meta+2');
    await app.page.keyboard.press('Meta+Shift+A');
    expect(await isActive(card)).toBe(true);
    expect(await outline(card)).toBe('solid');
    await app.page.keyboard.press('Enter');
    await app.rendered();
    expect(await card.isVisible()).toBe(true);
    expect(app.api.toolResults.some((r) => r.includes('"どちらにしますか？"'))).toBe(false);
    expect(await number('青')).toBe('"2"');
    await app.page.keyboard.press('2');
    expect(await isActive(option('青'))).toBe(true);
    await app.page.keyboard.press('Enter');
    await app.byText('.chat-list', ASK_DONE).waitFor();
    expect(app.api.toolResults.some((r) => r.includes('"どちらにしますか？"="青"'))).toBe(true);
  });

  it('⌘J でターミナルを開け閉めする。ターミナルの中でも ⌃Tab でタブを送り、⌘W ではタブを閉じず、アプリも終わらない', async () => {
    const panel = app.page.locator('.terminal-panel');
    const tabs = panel.locator('.terminal-tab');
    const selected = () => tabs.evaluateAll((all) => all.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
    await app.page.keyboard.press('Meta+2');
    await app.page.keyboard.press('Meta+J');
    await panel.waitFor({ state: 'visible' });
    await tabs.first().waitFor();
    await panel.locator('[aria-label="新しいターミナル"]').click();
    await expect.poll(() => tabs.count()).toBe(2);
    await panel.locator('.terminal-instance:not([hidden]) .xterm-helper-textarea').focus();
    expect(await selected()).toBe(1);
    await app.page.keyboard.press('Control+Tab');
    await expect.poll(selected).toBe(0);
    expect(await activeIn('.terminal-panel')).toBe(true);
    await app.page.keyboard.press('Control+Shift+Tab');
    await expect.poll(selected).toBe(1);
    await app.page.keyboard.press('Meta+W');
    await app.rendered();
    expect(await tabs.count()).toBe(2);
    expect(await windows()).toBe(1);
    await app.page.keyboard.press('Meta+J');
    await panel.waitFor({ state: 'hidden' });
  });

  it('アプリ内ブラウザのページにフォーカスがあっても効く: ⌃Tab でタブを送り、⌘W で今のタブを閉じ、⌘1 でセッション一覧へ移る。アプリは終わらない', async () => {
    const one = await serve('ページ 1');
    const two = await serve('ページ 2');
    servers.push(one.server, two.server);
    const address = '.preview-pane .preview-address input';
    const open = async (url: string, title: string) => {
      await app.page.fill(address, url);
      await app.page.press(address, 'Enter');
      await app.byText('.preview-pane .preview-tab', title).waitFor();
      await app.page.locator('.preview-pane .preview-toolbar [aria-label="読み込み直す"]').waitFor();
    };
    await app.page.click('.activity-bar [aria-label="ブラウザ"]');
    await app.page.locator('.preview-pane').waitFor({ state: 'visible' });
    await open(one.url, 'ページ 1');
    await app.page.click('.preview-pane [aria-label="新しいタブ"]');
    await open(two.url, 'ページ 2');
    const activeTab = () => app.page.locator('.preview-pane .preview-tab.active').textContent();
    expect(await activeTab()).toContain('ページ 2');

    await pressInPage('Tab', ['control']);
    await expect.poll(activeTab).toContain('ページ 1');
    await pressInPage('W', ['meta']);
    await expect.poll(() => browserTabs().count()).toBe(1);
    expect(await activeTab()).toContain('ページ 2');
    expect(await windows()).toBe(1);

    await pressInPage('1', ['meta']);
    await expect.poll(() => isActive(sessionRow(ASK))).toBe(true);
    // ページで押した（画面にキーが届かない）ときも、枠を出す
    expect(await outline(sessionRow(ASK))).toBe('solid');
  });

  // 直す前: どの欄にもフォーカスが無いとき（チャットの入力欄など）も、出しているエディタ・ブラウザのタブを閉じていた
  it('⌘W は、エディタ・ブラウザにフォーカスがあるときだけタブを閉じる。チャットの入力欄で押しても、出しているエディタのタブは閉じない', async () => {
    // ブラウザを閉じてエディタを出す（README.md・src/main.ts のタブが開いている）
    await app.page.click('.activity-bar [aria-label="ブラウザ"]');
    await app.page.locator('.preview-pane').waitFor({ state: 'hidden' });
    const editorTabs = app.page.locator('.editor-host .editor-tab');
    const before = await editorTabs.count();
    expect(before).toBeGreaterThan(0);
    await app.page.keyboard.press('Meta+2');
    await app.page.keyboard.press('Meta+W');
    await app.rendered();
    expect(await editorTabs.count()).toBe(before);
    await app.page.keyboard.press('Meta+4');
    await app.page.keyboard.press('Meta+W');
    await expect.poll(() => editorTabs.count()).toBe(before - 1);
    expect(await windows()).toBe(1);
  });

  it('メニューをマウスで押しても動く（「ターミナルを開く・閉じる」）', async () => {
    const panel = app.page.locator('.terminal-panel');
    const click = () =>
      app.app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()!.getMenuItemById('shortcut-toggleTerminal')!;
        (item.click as unknown as (event: unknown, window: unknown, contents: unknown) => void)({ triggeredByAccelerator: false }, undefined, undefined);
      });
    expect(await panel.isVisible()).toBe(false);
    await click();
    await panel.waitFor({ state: 'visible' });
    await click();
    await panel.waitFor({ state: 'hidden' });
  });
});
