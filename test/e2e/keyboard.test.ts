import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from 'playwright';
import { E2EApp } from './app';

// 一覧の行をキーで使う（Tab で一覧に入り、↑↓ で行を移り、→ ← で行のボタン・ツリーの開け閉め、Enter で押す。ファイルツリーは ⌃Enter で右クリックのメニュー）。
// あわせて、マウスで押したときは、フォーカスの枠もホバーで出るボタンも、マウスを離したあとに残らないこと（直す前と同じ見た目）を確かめる

const PROMPT = 'キーでの操作を試してください';
const REPLY = 'はい';
// ツールのカードの出力欄をスクロールさせるため、Bash で長い出力を出す
const LONG = { command: 'seq 1 120', description: '長い出力' };
// ツールのカードの間を ↑↓ で移るため、カードをもう 2 枚出す
const SHORT1 = { command: 'seq 1 3', description: '短い出力 1' };
const SHORT2 = { command: 'seq 1 4', description: '短い出力 2' };

describe('一覧の行を、キーでもマウスでも使う', () => {
  let app: E2EApp;
  const sessionRow = () => app.page.locator('.session-list .session-row').first();
  const treeRow = (path: string) => app.page.locator(`.tree-row[title="${path}"]`);
  const outline = (target: Locator) => target.evaluate((el) => getComputedStyle(el).outlineStyle);
  const display = (target: Locator) => target.evaluate((el) => getComputedStyle(el).display);
  const active = () => app.page.evaluate(() => document.activeElement?.getAttribute('title') ?? document.activeElement?.textContent ?? null);
  const isActive = (target: Locator) => target.evaluate((el) => el === document.activeElement);
  const card = (text: string) => app.page.locator('.chat-list .tool-card', { hasText: text });
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
          steps: [
            [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: LONG }],
            [{ type: 'tool_use', id: 'toolu_short1', name: 'Bash', input: SHORT1 }],
            [{ type: 'tool_use', id: 'toolu_short2', name: 'Bash', input: SHORT2 }],
            [{ type: 'text', text: REPLY }],
          ],
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

  it('Tab でセッション一覧に入ると、選んでいる行に止まり、枠とホバーで出るボタンが出る。→ で行のボタンへ移り、もう一度 Tab で一覧から出る', async () => {
    await moveAway();
    // 見出し（フォーカスしないところ）を押して、そこから Tab で進む
    await app.page.locator('.session-heading').first().click({ position: { x: 4, y: 4 } });
    await moveAway();
    const archive = sessionRow().locator('.icon-button.reveal');
    for (let i = 0; i < 5 && !(await isActive(sessionRow())); i++) await app.page.keyboard.press('Tab');
    expect(await isActive(sessionRow())).toBe(true);
    expect(await outline(sessionRow())).toBe('solid');
    expect(await display(archive)).not.toBe('none');
    // 行の中のボタンへは → で。移っても、ボタンは出たまま
    for (let i = 0; i < 3 && !(await isActive(archive)); i++) await app.page.keyboard.press('ArrowRight');
    expect(await isActive(archive)).toBe(true);
    expect(await display(archive)).not.toBe('none');
    // ← で行に戻れる（行の中のボタンの数は、セッションの状態で変わる）
    for (let i = 0; i < 3 && !(await isActive(sessionRow())); i++) await app.page.keyboard.press('ArrowLeft');
    expect(await isActive(sessionRow())).toBe(true);
    expect(await outline(sessionRow())).toBe('solid');
    // Tab で一覧から出る（行のボタンにも、ほかの行にも止まらない）。⇧Tab で、いた行に戻る
    await app.page.keyboard.press('Tab');
    expect(await app.page.evaluate(() => !!document.activeElement?.closest('.session-row'))).toBe(false);
    await app.page.keyboard.press('Shift+Tab');
    expect(await isActive(sessionRow())).toBe(true);
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

  it('マウスでファイルツリーの行を押したあとの ↑↓ は、ツリーを動かさない（フォーカスは body のまま）', async () => {
    await treeRow('README.md').click();
    await app.page.keyboard.press('ArrowUp');
    expect(await app.page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await outline(treeRow('src'))).toBe('none');
  });

  it('ファイルツリーは ↑↓ で行を移り、→ で開いて子へ、← で親へ・閉じる。Enter はクリックと同じ', async () => {
    // ⌘3 で、開いている README.md の行へ。↑ で src の行へ
    await app.page.keyboard.press('Meta+3');
    expect(await active()).toBe('README.md');
    await app.page.keyboard.press('ArrowUp');
    expect(await active()).toBe('src');
    expect(await outline(treeRow('src'))).toBe('solid');
    await app.page.keyboard.press('ArrowRight');
    await treeRow('src/main.ts').waitFor();
    await app.page.keyboard.press('ArrowRight');
    expect(await active()).toBe('src/main.ts');
    await app.page.keyboard.press('ArrowLeft');
    expect(await active()).toBe('src');
    await app.page.keyboard.press('ArrowLeft');
    await treeRow('src/main.ts').waitFor({ state: 'detached' });
    expect(await active()).toBe('src');
  });

  it('ファイルツリーの行で ⌃Enter で右クリックと同じメニューを開き、↑↓ で移り、Esc で閉じて行に戻る', async () => {
    // ⌘3 は、前にいた行（前のテストで ← で閉じた src）へ
    await app.page.keyboard.press('Meta+3');
    expect(await active()).toBe('src');
    expect(await outline(treeRow('src'))).toBe('solid');
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

  it('チャットのツールのカードは、カードにフォーカスがあるときだけ ↑↓ で前後のカードへ移り、そのカードが見えるところまでスクロールする', async () => {
    const list = app.page.locator('.chat-list');
    // 長い出力を開いて、一覧をスクロールできるようにする
    if ((await card('長い出力').locator('.tool-detail').count()) === 0) await card('長い出力').locator('.tool-card-head').click();
    // 答えの文（フォーカスしないところ）を押して、⇧Tab で一覧に戻ると、前にいたカード（さっき押した長い出力）に止まる
    await app.byText('.chat-list', REPLY).click();
    for (let i = 0; i < 5 && !(await isActive(card('長い出力'))); i++) await app.page.keyboard.press('Shift+Tab');
    expect(await isActive(card('長い出力'))).toBe(true);
    await app.page.keyboard.press('ArrowDown');
    expect(await isActive(card('短い出力 1'))).toBe(true);
    await app.page.keyboard.press('ArrowDown');
    expect(await isActive(card('短い出力 2'))).toBe(true);
    // 一覧の最後まで送ってから、いちばん上のカードへ戻ると、そのカードが見えるところまでスクロールする
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const inView = () =>
      card('長い出力').evaluate((el) => {
        const view = el.closest('.chat-list')!.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        return rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
      });
    await app.page.keyboard.press('ArrowUp');
    await app.page.keyboard.press('ArrowUp');
    expect(await isActive(card('長い出力'))).toBe(true);
    await expect.poll(inView).toBe(true);
    await app.page.keyboard.press('ArrowDown');
    expect(await isActive(card('短い出力 1'))).toBe(true);
    // カードにフォーカスが無いとき（マウスで押したあと）の ↑ は、今までどおりチャットをスクロールする
    await card('短い出力 1').locator('.tool-card-head').click();
    expect(await app.page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const before = await list.evaluate((el) => el.scrollTop);
    await app.page.keyboard.press('ArrowUp');
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeLessThan(before);
  });
});
