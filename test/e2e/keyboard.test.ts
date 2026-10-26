import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from 'playwright';
import { E2EApp } from './app';

// 一覧の行をキーで使う（Tab で止まり、Enter で押す。ファイルツリーは ⌃Enter で右クリックのメニュー）。
// あわせて、マウスで押したときは、フォーカスの枠もホバーで出るボタンも、マウスを離したあとに残らないこと（直す前と同じ見た目）を確かめる

const PROMPT = 'キーでの操作を試してください';
const REPLY = 'はい';
// ツールのカードの出力欄をスクロールさせるため、Bash で長い出力を出す
const LONG = { command: 'seq 1 120', description: '長い出力' };

describe('一覧の行を、キーでもマウスでも使う', () => {
  let app: E2EApp;
  const sessionRow = () => app.page.locator('.session-list .session-row').first();
  const treeRow = (path: string) => app.page.locator(`.tree-row[title="${path}"]`);
  const outline = (target: Locator) => target.evaluate((el) => getComputedStyle(el).outlineStyle);
  const display = (target: Locator) => target.evaluate((el) => getComputedStyle(el).display);
  const active = () => app.page.evaluate(() => document.activeElement?.getAttribute('title') ?? document.activeElement?.textContent ?? null);
  // マウスを、どの行にもかからないところ（チャットの一覧の真ん中）へ動かす
  const moveAway = async () => {
    const box = (await app.page.locator('.chat-list').boundingBox())!;
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      files: { 'README.md': '# shop\n', 'src/main.ts': 'export {};\n' },
      conversations: () => [
        {
          match: PROMPT,
          steps: [[{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: LONG }], [{ type: 'text', text: REPLY }]],
        },
      ],
    });
    // seq は読むだけのコマンドなので、許可の確認なしに動く
    await app.startSession(PROMPT, { mode: 'manual' });
    await app.byText('.chat-list', REPLY).waitFor();
    // 終わった操作はまとまりに畳まれるので、開いてカードを出す
    await app.page.locator('.chat-list .tool-group-head').first().click();
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`keyboard-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('マウスでセッションの行を押して離れると、枠もホバーで出るボタンも残らない', async () => {
    await sessionRow().locator('.session-title').click();
    const archive = sessionRow().locator('.icon-button.reveal');
    expect(await display(archive)).not.toBe('none');
    await moveAway();
    expect(await display(archive)).toBe('none');
    expect(await outline(sessionRow())).toBe('none');
  });

  // 直す前: マウスで押した行にフォーカスが残り、ダイアログを閉じてフォーカスを戻すと :focus-visible になって、枠とボタンが出たままになった
  it('マウスでセッションの行を押してから、ダイアログを開いて Esc で閉じても、枠もホバーで出るボタンも出ない', async () => {
    await sessionRow().locator('.session-title').click();
    await app.app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('mcpSettings');
      if (!item) throw new Error('メニューに「mcpSettings」がありません');
      item.click();
    });
    await app.page.locator('.mcp-settings-dialog').waitFor();
    await app.page.keyboard.press('Escape');
    await app.page.locator('.mcp-settings-dialog').waitFor({ state: 'detached' });
    await moveAway();
    expect(await display(sessionRow().locator('.icon-button.reveal'))).toBe('none');
    expect(await outline(sessionRow())).toBe('none');
    // 押した行にフォーカスを残さない（直す前と同じく body）
    expect(await app.page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  it('ツールのカードの出力の文字は、マウスでドラッグして選べる（行からフォーカスを外しても、選んだ範囲は残る）', async () => {
    const card = app.page.locator('.chat-list .tool-card', { hasText: '長い出力' });
    if ((await card.locator('.tool-detail').count()) === 0) await card.locator('.tool-card-head').click();
    const box = (await card.locator('.tool-pre').last().boundingBox())!;
    await app.page.mouse.move(box.x + 10, box.y + 10);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + 60, box.y + 60, { steps: 5 });
    await app.page.mouse.up();
    expect((await app.page.evaluate(() => window.getSelection()?.toString() ?? '')).trim()).not.toBe('');
  });

  // 直す前: マウスで押したカードにフォーカスが残り、そのあとの Enter でカードをもう一度押した（詳細が閉じた）
  it('マウスでツールのカードを押したあとに Enter を押しても、カードを押したことにならない', async () => {
    const card = app.page.locator('.chat-list .tool-card', { hasText: '長い出力' });
    await card.locator('.tool-card-head').click();
    const shown = await card.locator('.tool-detail').count();
    await app.page.keyboard.press('Enter');
    await app.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await card.locator('.tool-detail').count()).toBe(shown);
  });

  // 直す前: カードにフォーカスが残るので、出力欄を押してから送るキーを押すと、出力欄でなくチャットの一覧が動いた
  it('ツールのカードの出力欄を押してから PageDown を押すと、出力欄が動く', async () => {
    const card = app.page.locator('.chat-list .tool-card', { hasText: '長い出力' });
    if ((await card.locator('.tool-detail').count()) === 0) await card.locator('.tool-card-head').click();
    const output = card.locator('.tool-pre').last();
    expect(await output.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await output.click({ position: { x: 20, y: 20 } });
    await app.page.keyboard.press('PageDown');
    await expect.poll(() => output.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  it('Tab でセッションの行に入ると、枠とホバーで出るボタンが出て、行の中のボタンへ Tab で移れる', async () => {
    await moveAway();
    // 見出し（フォーカスしないところ）を押して、そこから Tab で進む
    await app.page.locator('.session-heading').first().click({ position: { x: 4, y: 4 } });
    await moveAway();
    const archive = sessionRow().locator('.icon-button.reveal');
    for (let i = 0; i < 5 && !(await sessionRow().evaluate((el) => el === document.activeElement)); i++) await app.page.keyboard.press('Tab');
    expect(await sessionRow().evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await outline(sessionRow())).toBe('solid');
    expect(await display(archive)).not.toBe('none');
    // 行の中のボタンへ移っても、ボタンは出たまま
    for (let i = 0; i < 3 && !(await archive.evaluate((el) => el === document.activeElement)); i++) await app.page.keyboard.press('Tab');
    expect(await archive.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await display(archive)).not.toBe('none');
    // Shift+Tab で行に戻れる（行の中のボタンの数は、セッションの状態で変わる）
    for (let i = 0; i < 3 && !(await sessionRow().evaluate((el) => el === document.activeElement)); i++) await app.page.keyboard.press('Shift+Tab');
    expect(await sessionRow().evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await outline(sessionRow())).toBe('solid');
  });

  it('マウスでファイルツリーの行を押しても枠は出ない。右クリックのメニューは、項目にフォーカスを移さない', async () => {
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await treeRow('README.md').click();
    await app.page.locator('.editor-tab', { hasText: 'README.md' }).waitFor();
    await moveAway();
    expect(await outline(treeRow('README.md'))).toBe('none');
    await treeRow('README.md').click({ button: 'right' });
    await app.page.locator('.context-menu').waitFor();
    expect(await app.page.locator('.context-menu').evaluate((menu) => menu.contains(document.activeElement))).toBe(false);
    await app.page.keyboard.press('Escape');
    await app.page.locator('.context-menu').waitFor({ state: 'detached' });
  });

  it('ファイルツリーの行で Enter はクリックと同じ。⌃Enter で右クリックと同じメニューを開き、↑↓ で移り、Esc で閉じて行に戻る', async () => {
    // 押したあとの README.md の行から、Tab で src の行へ戻る（src は README.md の前）
    await treeRow('README.md').click();
    await app.page.keyboard.press('Shift+Tab');
    expect(await active()).toBe('src');
    expect(await outline(treeRow('src'))).toBe('solid');
    await app.page.keyboard.press('Enter');
    await treeRow('src/main.ts').waitFor();
    await app.page.keyboard.press('Control+Enter');
    const items = app.page.locator('.context-menu [role="menuitem"]');
    await items.first().waitFor();
    expect(await items.first().evaluate((el) => el === document.activeElement)).toBe(true);
    await app.page.keyboard.press('ArrowDown');
    expect(await items.nth(1).evaluate((el) => el === document.activeElement)).toBe(true);
    await app.page.keyboard.press('Escape');
    await app.page.locator('.context-menu').waitFor({ state: 'detached' });
    expect(await active()).toBe('src');
  });
});
