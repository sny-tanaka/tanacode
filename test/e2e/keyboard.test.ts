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
  // 答えの文（一覧の中の、フォーカスしないところ）
  const reply = () => app.page.locator('.chat-list').getByText(REPLY, { exact: true });
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

  // 一覧の行は、Tab を押すまで、どれも tabindex="-1"。Chromium は、中に止まれる所の無いスクロールする入れ物を、フォーカスできる所にするので、
  // マウスだけで使ったときに、空いた所を押して入れ物にフォーカスが入らないか（入ると、そのあとのキーの動きが直す前と変わる）。Tab を押す前に確かめる
  it('Tab を押す前（マウスだけで使ったとき）に、一覧の空いた所を押しても、一覧の入れ物にフォーカスが入らない', async () => {
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await treeRow('README.md').waitFor();
    for (const area of ['.explorer .side-body', '.sidebar .session-list']) {
      const box = (await app.page.locator(area).first().boundingBox())!;
      await app.page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
      expect(await app.page.evaluate(() => document.activeElement === document.body)).toBe(true);
    }
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
    // 見出し（フォーカスしないところ）を押して、そこから Tab で進む。ロックのボタンの次が、一覧の選んでいる行
    await app.page.locator('.session-heading').first().click({ position: { x: 4, y: 4 } });
    await moveAway();
    await app.page.keyboard.press('Tab');
    expect(await isActive(app.page.locator('.session-lock'))).toBe(true);
    await app.page.keyboard.press('Tab');
    expect(await isActive(sessionRow())).toBe(true);
    expect(await outline(sessionRow())).toBe('solid');
    const archive = sessionRow().locator('.icon-button.reveal');
    expect(await display(archive)).not.toBe('none');
    // 行の中のボタンへは → で、1 つずつ。アーカイブのボタンの前にあるボタンの数は、セッションの状態で変わるので、数えてから押す
    const steps = await sessionRow().evaluate((row) => [...row.querySelectorAll('button')].indexOf(row.querySelector('.icon-button.reveal')!) + 1);
    for (let i = 0; i < steps; i++) await app.page.keyboard.press('ArrowRight');
    expect(await isActive(archive)).toBe(true);
    expect(await display(archive)).not.toBe('none');
    for (let i = 0; i < steps; i++) await app.page.keyboard.press('ArrowLeft');
    expect(await isActive(sessionRow())).toBe(true);
    expect(await outline(sessionRow())).toBe('solid');
    // Tab で一覧から出る（行のボタンにも、ほかの行にも止まらない）。⇧Tab で、いた行に戻る
    await app.page.keyboard.press('Tab');
    expect(await app.page.evaluate(() => !!document.activeElement?.closest('.session-list'))).toBe(false);
    await app.page.keyboard.press('Shift+Tab');
    expect(await isActive(sessionRow())).toBe(true);
  });

  it('マウスでファイルツリーの行を押しても枠は出ない。右クリックのメニューは、項目にフォーカスを移さない', async () => {
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

  // 直す前: マウスで押した行も前にいた行として覚え、エディタで別のファイルへ移ってから ⌘3 を押すと、マウスで押した行へ移った
  it('マウスで押した行は前にいた行として覚えず、⌘3 は開いているファイル（選んでいる行）へ移る', async () => {
    if ((await treeRow('src/main.ts').count()) === 0) await treeRow('src').click();
    await treeRow('src/main.ts').click();
    await treeRow('README.md').click();
    await app.page.locator('.editor-tab', { hasText: 'main.ts' }).click();
    await app.page.keyboard.press('Meta+3');
    expect(await active()).toBe('src/main.ts');
    expect(await outline(treeRow('src/main.ts'))).toBe('solid');
  });

  it('ファイルツリーは ↑↓ で行を移り、→ で開いて子へ、← で親へ・閉じる', async () => {
    // src を閉じて、README.md を開いたところから始める
    if ((await treeRow('src/main.ts').count()) > 0) await treeRow('src').click();
    await treeRow('README.md').click();
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
    // ⌘3 でツリーの行へ（どの行かは問わない。前のテストで、キーで入った行を覚えていればそこ）
    await app.page.keyboard.press('Meta+3');
    const row = await active();
    expect(await app.page.evaluate(() => document.activeElement?.matches('.tree-row:focus-visible') ?? false)).toBe(true);
    await app.page.keyboard.press('Control+Enter');
    const items = app.page.locator('.context-menu [role="menuitem"]');
    await items.first().waitFor();
    expect(await items.first().evaluate((el) => el === document.activeElement)).toBe(true);
    await app.page.keyboard.press('ArrowDown');
    expect(await items.nth(1).evaluate((el) => el === document.activeElement)).toBe(true);
    await app.page.keyboard.press('Escape');
    await app.page.locator('.context-menu').waitFor({ state: 'detached' });
    expect(await active()).toBe(row);
  });

  it('チャットのツールのカードは、カードにフォーカスがあるときだけ ↑↓ で前後のカードへ移り、そのカードが見えるところまでスクロールする', async () => {
    const list = app.page.locator('.chat-list');
    // CI の Mac と同じ大きさのウインドウにして、長い出力を開く（一覧をスクロールでき、いちばん上のカードの頭が、最下部からは見えないように）
    await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 674));
    await app.page.waitForFunction(() => window.innerHeight === 674);
    // マウスで押したカードは、前にいた行として覚えない
    if ((await card('長い出力').locator('.tool-detail').count()) === 0) await card('長い出力').locator('.tool-card-head').click();
    // 答えの文を押して ⇧Tab で一覧に戻ると、新しい方の端のカードに止まる（答えの文とカードの間に、止まる所は無い）
    await reply().click();
    await app.page.keyboard.press('Shift+Tab');
    expect(await isActive(card('短い出力 2'))).toBe(true);
    await app.page.keyboard.press('ArrowUp');
    expect(await isActive(card('短い出力 1'))).toBe(true);
    // 一覧の最後まで送ってから、いちばん上のカードへ移ると、そのカードの頭が見えるところまでスクロールする
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const headInView = () =>
      card('長い出力')
        .locator('.tool-card-head')
        .evaluate((el) => {
          const view = el.closest('.chat-list')!.getBoundingClientRect();
          const rect = el.getBoundingClientRect();
          return rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1;
        });
    expect(await headInView()).toBe(false);
    await app.page.keyboard.press('ArrowUp');
    expect(await isActive(card('長い出力'))).toBe(true);
    await expect.poll(headInView).toBe(true);
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

  // 直す前: カードの中のどこで押した矢印キーも、カードの移動に使っていたので、開いたカードの出力欄（Tab で止まる）をキーで送れなかった
  it('開いたツールのカードの出力欄で押した ↓ は、カードを移らず、出力欄を送る', async () => {
    const output = card('長い出力').locator('.tool-pre').last();
    if ((await card('長い出力').locator('.tool-detail').count()) === 0) await card('長い出力').locator('.tool-card-head').click();
    // ほかのカードは閉じておく（開いていると、出力欄に Tab で止まる）
    for (const name of ['短い出力 1', '短い出力 2']) if ((await card(name).locator('.tool-detail').count()) > 0) await card(name).locator('.tool-card-head').click();
    expect(await output.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // 答えの文から ⇧Tab で一覧のカードへ、Home でいちばん上のカード（長い出力）へ、Tab でその出力欄へ（カードのボタンには止まらない）
    await reply().click();
    await app.page.keyboard.press('Shift+Tab');
    await app.page.keyboard.press('Home');
    expect(await isActive(card('長い出力'))).toBe(true);
    await app.page.keyboard.press('Tab');
    expect(await isActive(output)).toBe(true);
    await output.evaluate((el) => (el.scrollTop = 0));
    await app.page.keyboard.press('ArrowDown');
    expect(await isActive(output)).toBe(true);
    await expect.poll(() => output.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});
