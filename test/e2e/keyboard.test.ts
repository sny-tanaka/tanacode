import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from 'playwright';
import { E2EApp } from './app';

// 一覧の行をキーで使う（Tab で止まり、Enter で押す。ファイルツリーは ⌃Enter で右クリックのメニュー）。
// あわせて、マウスで押したときは、フォーカスの枠もホバーで出るボタンも、マウスを離したあとに残らないこと（直す前と同じ見た目）を確かめる

const PROMPT = 'キーでの操作を試してください';
const REPLY = 'はい';

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
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: REPLY }]] }],
    });
    await app.startSession(PROMPT);
    await app.byText('.chat-list', REPLY).waitFor();
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
