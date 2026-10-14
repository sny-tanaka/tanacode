import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude が、アプリ内ブラウザで許す先の外のページを開く。アプリが起動する Claude Code のフック（browser-gate.ts）から、
// アプリの browser-control.ts を通って、本物の webview まで。
// - 許す先の外を開くときは、「次から聞かない」で許したあとでも、許可の確認（カード）が出る。許すと開く
//   （ユーザーの設定の permissions.allow で、ブラウザのツールを許しておく。bypassPermissions でも出ることは test/cli/browser.test.ts。
//   新規セッションの画面では bypassPermissions を選べず、auto はモックの API では分類器が動かないので、ここでは使わない）
// - 許したタブの中の、同じオリジンの操作（押す・読む・同じオリジンの中の移動）には、確認が出ない
// - 別のオリジンへ移ろうとしたら止まり、continue で、また確認が出る。許すと開く
// 「外」の先は [::1]（許す先の既定 localhost・127.0.0.1・*.local に当たらない。この Mac の中で動かせる）。2 つめのオリジンは別のポート

const OPEN = '外のページを開いて確かめてください';
const DONE = '外のページを確かめました';
const SAME_TEXT = 'A の次のページです';
const OTHER_TEXT = '別のオリジン B のページです';
const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name: browserToolId(name), input }];

// [::1] で待ち受ける（ポートは空いているもの）
async function serve(pages: Record<string, string>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
  return { server, origin: `http://[::1]:${(server.address() as AddressInfo).port}` };
}

describe('Claude が許す先の外のページを開く', () => {
  let app: E2EApp;
  let a: { server: Server; origin: string };
  let b: { server: Server; origin: string };

  beforeAll(async () => {
    b = await serve({ '/': `<!doctype html><title>B</title><h1>${OTHER_TEXT}</h1>` });
    a = await serve({
      '/': '<!doctype html><title>A</title><h1>外のページ A</h1><a id="same" href="/next">同じオリジンの次へ</a>',
      '/next': `<!doctype html><title>A の次</title><h1>${SAME_TEXT}</h1><a id="other" href="${b.origin}/">別のオリジンへ</a>`,
    });
    app = await E2EApp.launch({
      trusted: true,
      // 「次から聞かない」で、ブラウザのツールを許したあと
      claudeSettings: { permissions: { allow: [browserToolId('navigate'), browserToolId('click')] } },
      conversations: () => [
        {
          match: OPEN,
          steps: [
            tool('toolu_open', 'navigate', { url: `${a.origin}/` }),
            tool('toolu_same', 'click', { selector: '#same' }),
            tool('toolu_read', 'get_text', {}),
            tool('toolu_other', 'click', { selector: '#other' }),
            tool('toolu_continue', 'navigate', { action: 'continue' }),
            tool('toolu_read_other', 'get_text', {}),
            [{ type: 'text', text: DONE }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-outside-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => a?.server.close(resolve));
    await new Promise((resolve) => b?.server.close(resolve));
  });

  const address = (expected: string) =>
    app.page.waitForFunction((url) => document.querySelector<HTMLInputElement>('.preview-pane .preview-address input')?.value === url, expected);

  it('「次から聞かない」で許したあとでも、許す先の外を開く前に許可の確認が出て、開く先のオリジンが書いてある。許すと開く', async () => {
    await app.startSession(OPEN, { mode: 'manual' });
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain(a.origin);
    await app.choose(card, /^Yes/);
    await address(`${a.origin}/`);
  });

  it('許したタブの中は、同じオリジンのリンクを押しても・読んでも、確認が出ない', async () => {
    await app.waitUntil('同じオリジンの次のページの文字が Claude に届く', () => app.api.toolResults.some((r) => r.includes(SAME_TEXT)));
    await address(`${a.origin}/next`);
    expect(app.api.toolResults.find((r) => r.startsWith('Clicked: a#same'))).toBeDefined();
  });

  it('別のオリジン（別のポート）へ移ろうとしたら止まり、continue でまた確認が出る。許すと開いて読める', async () => {
    await app.waitUntil('止めたことが Claude に届く', () =>
      app.api.toolResults.some((r) => r.includes(`Blocked an attempt to navigate to (or open) a page not allowed for Claude (${b.origin}).`) && r.includes('"continue"')),
    );
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain(b.origin);
    // 止めている間は、移っていない
    await address(`${a.origin}/next`);
    await app.choose(card, /^Yes/);
    await address(`${b.origin}/`);
    await app.byText('.chat-list', DONE).waitFor();
    expect(app.api.toolResults.some((r) => r.includes(OTHER_TEXT))).toBe(true);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
