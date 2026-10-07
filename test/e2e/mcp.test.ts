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
// - ウォークスルー: エディタにステップを開き、人が「次へ」で進める
// - アプリ内ブラウザ: ページを開いて（許可の確認に答える）文字を読み、人に操作を頼む（「終わった」を押す）

const USE = 'MCP のツールを順に使ってください';
const LIST = '完了前チェック';
const CARDS = ['税込表示が整数であること', '税率0%でも壊れないこと'];
const STEPS = [
  { title: '税率を決める', body: '税率は **10%** で固定にしました' },
  { title: '税込にする', body: '1 円未満は切り捨てます' },
];
const PAGE_TEXT = 'E2E のページです';
const ASK = 'テスト用のアカウントでログインしてください';
const DONE = 'MCP の確認が終わりました';
const TAX = ['export const TAX_RATE = 0.1;', '', 'export function withTax(price: number): number {', '  return Math.floor(price * (1 + TAX_RATE));', '}', ''].join('\n');

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
