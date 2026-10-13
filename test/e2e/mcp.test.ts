import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_ASK_TOOL, browserToolId } from '@shared/browser-tools';
import { checklistToolId } from '@shared/checklist-tools';
import { walkthroughToolId } from '@shared/walkthrough-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude が MCP のツールでアプリを操作し、それが画面に出るか。アプリが起動する Claude Code に足す MCP サーバー（中継）から、
// アプリの *-control.ts を通って画面まで。人の操作（許可・依頼への返事）は、画面からツールの結果として Claude に戻る。
// - チェックリスト: カードを積んで、チェックを付ける
// - ウォークスルー: エディタにステップを開き、人が「次へ」で進める。吹き出しは、画面の外までスクロールして戻しても元の高さのまま。
//   吹き出しの上でホイールを回すとエディタがスクロールし、あふれた質問の欄の上では欄の中がスクロールする
// - アプリ内ブラウザ: ページを開いて（許可の確認に答える）文字を読み、人に操作を頼む（「終わった」を押す）

const USE = 'MCP のツールを順に使ってください';
const LIST = '完了前チェック';
const CARDS = ['税込表示が整数であること', '税率0%でも壊れないこと'];
const STEPS = [
  // 1 つ目は段落を分けて、吹き出しを高くする（下の端から見えてくるのを確かめる）
  { title: '税率を決める', body: ['税率は **10%** で固定にしました。', '軽減税率は、次の変更で足します。', '設定に移すのも、次の変更です。', '定数の名前は、前のままです。', '端数の扱いは、次のステップで説明します。'].join('\n\n') },
  { title: '税込にする', body: '1 円未満は切り捨てます' },
];
const PAGE_TEXT = 'E2E のページです';
const ASK = 'テスト用のアカウントでログインしてください';
const DONE = 'MCP の確認が終わりました';
// うしろに行を足して、吹き出しを画面の外までスクロールできる長さにする
const TAX = [
  'export const TAX_RATE = 0.1;',
  '',
  'export function withTax(price: number): number {',
  '  return Math.floor(price * (1 + TAX_RATE));',
  '}',
  '',
  ...Array.from({ length: 200 }, (_, i) => `// ${i + 1} 行目`),
  '',
].join('\n');

const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name, input }];

describe('Claude が MCP でアプリを操作する', () => {
  let app: E2EApp;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    // Claude に開かせるページ（localhost は、許す先の既定に入っている）
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>E2E</title><h1>${PAGE_TEXT}</h1>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    app = await E2EApp.launch({
      trusted: true,
      files: { 'src/tax.ts': TAX },
      conversations: () => [
        {
          match: USE,
          steps: [
            tool('toolu_add', checklistToolId('card_add'), { list: LIST, list_description: '作業を終える前に確かめる', cards: CARDS.map((title) => ({ title })) }),
            tool('toolu_check', checklistToolId('card_check'), { list: LIST, numbers: '1', comment: 'テストで確かめた' }),
            tool('toolu_walk', walkthroughToolId('start_walkthrough'), {
              title: '税の計算',
              steps: [
                { path: 'src/tax.ts', start_line: 1, title: STEPS[0].title, body: STEPS[0].body },
                { path: 'src/tax.ts', start_line: 3, end_line: 5, title: STEPS[1].title, body: STEPS[1].body },
              ],
            }),
            tool('toolu_open', browserToolId('navigate'), { url }),
            tool('toolu_text', browserToolId('get_text'), {}),
            tool('toolu_ask', browserToolId(BROWSER_ASK_TOOL), { message: ASK }),
            [{ type: 'text', text: DONE }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`mcp-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('Claude が積んだチェックリストのカードと、付けたチェックが出る', async () => {
    await app.startSession(USE, { mode: 'manual' });
    await app.page.click('.activity-bar [aria-label^="チェックリスト"]');
    await app.byText('.checklist-list-name', LIST).waitFor();
    for (const title of CARDS) await app.byText('.checklist-card .checklist-title', title).waitFor();
    // 1 枚目は Claude がチェックした（Claude の印で出る）
    await app.byText('.checklist-card.checked', CARDS[0]).locator('.card-check.on.by-claude').waitFor();
    expect(await app.byText('.checklist-card', CARDS[1]).getAttribute('class')).not.toContain('checked');
  });

  it('吹き出しを画面の外までスクロールして戻すと、下の端から見えてくる', async () => {
    const page = app.page;
    const box = page.locator('.walk-box');
    await app.byText('.walk-box .walk-mark', 'ウォークスルー 1/2').waitFor();
    // 吹き出しが動いてもポインタの下が変わらないように、行番号のところでホイールを回す
    const editor = (await page.locator('.monaco-editor', { has: box }).boundingBox())!;
    await page.mouse.move(editor.x + 10, editor.y + editor.height / 2);
    // 吹き出しが上へ出きるまで、下へ
    for (let i = 0; i < 100 && (await box.isVisible()); i++) await page.mouse.wheel(0, 40);
    await box.waitFor({ state: 'hidden' });
    // 少しずつ上へ戻す。1 回ごとに描画を待ち、吹き出しが描かれたら、エディタの上端から下へ見えている高さと全体の高さを返す
    const shown = () =>
      page.evaluate(
        () =>
          new Promise<{ visible: number; height: number } | null>((resolve) =>
            requestAnimationFrame(() => {
              const zone = document.querySelector<HTMLElement>('.walk-zone')!;
              if (zone.style.display === 'none') return resolve(null);
              const rect = zone.firstElementChild!.getBoundingClientRect();
              resolve({ visible: rect.bottom - zone.closest('.monaco-editor')!.getBoundingClientRect().top, height: rect.height });
            }),
          ),
      );
    let back: { visible: number; height: number } | null = null;
    for (let i = 0; i < 400 && !back; i++) {
      await page.mouse.wheel(0, -4);
      back = await shown();
    }
    // 画面の外にある間に領域の高さが縮むと、領域の上端まで戻らないと描かれず、全体が一度に現れる
    expect(back).not.toBeNull();
    expect(back!.visible).toBeLessThan(back!.height / 2);
    // 次のテストのために、吹き出しの全体が見えるところまで戻す
    for (let i = 0; i < 100 && (await box.boundingBox())!.y < editor.y; i++) await page.mouse.wheel(0, -40);
  });

  it('吹き出しの上でホイールを回すと、エディタがスクロールする', async () => {
    const page = app.page;
    const box = page.locator('.walk-box');
    const top = async () => (await box.boundingBox())!.y;
    await box.locator('.walk-body').hover();
    const start = await top();
    // 吹き出しごと上へ動く
    await page.mouse.wheel(0, 40);
    await page.waitForFunction((y) => document.querySelector('.walk-box')!.getBoundingClientRect().top < y, start);
    // 元の位置まで戻す（ポインタは吹き出しの上のまま）
    for (let i = 0; i < 100 && (await top()) < start; i++) await page.mouse.wheel(0, -40);
  });

  it('あふれた質問の欄の上でホイールを回すと、欄の中がスクロールする（エディタは動かない）', async () => {
    const page = app.page;
    const box = page.locator('.walk-box');
    await app.byText('.walk-box .ghost-button', '質問する').click();
    const input = box.locator('.walk-ask textarea');
    await input.fill(Array.from({ length: 30 }, (_, i) => `${i + 1} 行目`).join('\n'));
    await input.evaluate((el) => {
      el.scrollTop = 0;
    });
    await input.hover();
    const before = (await box.boundingBox())!.y;
    await page.mouse.wheel(0, 40);
    await page.waitForFunction(() => document.querySelector('.walk-ask textarea')!.scrollTop > 0);
    // エディタが動いたなら、次の描画までに吹き出しの位置が変わる
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect((await box.boundingBox())!.y).toBe(before);
    await box.locator('[aria-label="やめる"]').click();
  });

  it('ウォークスルーがエディタに開き、「次へ」で進める', async () => {
    await app.byText('.walk-box .walk-mark', 'ウォークスルー 1/2').waitFor();
    expect(await app.page.locator('.walk-box .walk-title').textContent()).toBe(STEPS[0].title);
    await app.byText('.walk-box .walk-body strong', '10%').waitFor();
    await app.page.click('.walk-box [aria-label="次へ"]');
    await app.byText('.walk-box .walk-mark', 'ウォークスルー 2/2').waitFor();
    expect(await app.page.locator('.walk-box .walk-body').textContent()).toContain(STEPS[1].body);
    await app.byText('.walk-box .send-button', '終える').click();
    await app.page.locator('.walk-box').waitFor({ state: 'detached' });
  });

  it('ページを開く前に許可の確認が出て、答えるとアプリ内ブラウザに開く', async () => {
    const card = await app.menuCard('permission');
    // ツールは表示名（title）で出る。開く先の URL も出る
    expect(await card.textContent()).toContain('tanacode-browser — 開く');
    expect(await card.textContent()).toContain(url);
    await app.choose(card, /^Yes/);
    await app.page.locator('.preview-pane .preview-address input').waitFor();
    await app.page.waitForFunction((expected) => document.querySelector<HTMLInputElement>('.preview-pane .preview-address input')?.value === expected, url);
  });

  it('Claude がページの文字を読める', async () => {
    await app.waitUntil('ページの文字が Claude に届く', () => app.api.toolResults.some((r) => r.includes(PAGE_TEXT)));
  });

  it('Claude の依頼が「あなたの番です」の帯に出て、「終わった」を押すと Claude に返る', async () => {
    await app.byText('.preview-ask .preview-ask-message', ASK).waitFor();
    await app.byText('.preview-ask .send-button', '終わった').click();
    await app.page.locator('.preview-ask').waitFor({ state: 'detached' });
    await app.byText('.chat-list', DONE).waitFor();
    // 依頼の結果（押したボタンと今のページ）が Claude に届いている
    const answer = app.api.toolResults.find((r) => r.includes(url) && !r.includes(PAGE_TEXT));
    expect(answer).toBeDefined();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
