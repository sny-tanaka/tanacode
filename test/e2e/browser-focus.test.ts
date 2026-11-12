import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude がページの欄を押して打ち、別の欄を押すと、前の欄に blur・focusout が届く（欄から出たときに処理が走るフォームが動く）。
// 直す前: tanacode は人のキーボードのフォーカスを奪わないよう、ページ（webview）にフォーカスを渡さない。ページは「フォーカスの無いウインドウ」
// 扱い（document.hasFocus() が false）で、欄の focus()・押下でフォーカスが移っても、focus・blur・focusin・focusout が 1 つも出なかった
// （楽楽精算の明細で、内訳コード・金額の欄から出たときの処理が走らず、登録できなかった）。
// 直したあと: Claude が操作するタブでは、CDP でページにフォーカスがある扱いにする（Emulation.setFocusEmulationEnabled）。
// 人のフォーカス（チャットの入力欄）は動かさない（browser-click.test.ts が確かめる）。
// このテストだけでは、直す前の様子は再現できない。Playwright は、つないだページ（webview も）を、フォーカスがある扱いに固定する
// （Emulation.setFocusEmulationEnabled）ので、直す前のソースでも通る。tanacode が扱いを付けることは test/browser-control-mouse.test.ts が、
// Playwright をつながないときに直ることは、開発用ビルドで確かめた（CONTRIBUTING.md の「アプリ内ブラウザのフォーカス」）

const START = 'フォームに入力してください';
const DONE = '入力しました';
const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name: browserToolId(name), input }];

describe('Claude がページの欄を操作すると、フォーカスのイベントが普通に起きる', () => {
  let app: E2EApp;
  let server: Server;
  let url: string;

  // ページで起きたフォーカスのイベント（「種類:欄」）と、document.hasFocus()
  const page = () =>
    app.app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && !w.isDestroyed() && w.getURL() === url);
      return guest!.executeJavaScript(`({ events: __events.slice(), hasFocus: document.hasFocus(), code: document.querySelector('#code').value, amount: document.querySelector('#amount').value, name: document.querySelector('#name').value, total: document.querySelector('#total').value })`);
    }, url) as Promise<{ events: string[]; hasFocus: boolean; code: string; amount: string; name: string; total: string }>;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // 内訳コードの欄から出たら内訳名を、金額の欄から出たら小計を入れる（楽楽精算の明細と同じ作り）
      res.end(`<!doctype html><title>明細</title>
<body style="margin:0">
<input id="code" aria-label="内訳コード" style="display:block;width:200px;height:24px">
<input id="name" aria-label="内訳名" readonly style="display:block;width:200px;height:24px">
<input id="amount" aria-label="金額" style="display:block;width:200px;height:24px">
<input id="total" aria-label="小計" readonly style="display:block;width:200px;height:24px">
<script>
  window.__events = [];
  for (const type of ['focus', 'blur', 'focusin', 'focusout']) {
    document.addEventListener(type, (e) => { if (e.target.id) __events.push(type + ':' + e.target.id); }, true);
  }
  document.querySelector('#code').addEventListener('blur', (e) => { document.querySelector('#name').value = e.target.value === 'A01' ? '交通費' : ''; });
  document.querySelector('#amount').addEventListener('blur', (e) => { document.querySelector('#total').value = String(Number(e.target.value) * 2); });
</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    app = await E2EApp.launch({
      trusted: true,
      claudeSettings: { permissions: { allow: ['navigate', 'click', 'type'].map(browserToolId) } },
      conversations: () => [
        {
          match: START,
          steps: [
            tool('toolu_open', 'navigate', { url }),
            // ふだんの押下（ページの中の JavaScript）で欄を押して打ち、別の欄を押す
            tool('toolu_code', 'click', { selector: '#code' }),
            tool('toolu_code_type', 'type', { text: 'A01' }),
            tool('toolu_amount', 'click', { selector: '#amount' }),
            // セレクタありの type（欄を押してから打つ）
            tool('toolu_amount_type', 'type', { selector: '#amount', text: '100' }),
            // 本物の押下（real）で別の欄を押す。人のフォーカスを戻しても、ページのフォーカスはそのまま
            tool('toolu_code_real', 'click', { selector: '#code', real: true }),
            tool('toolu_amount_real', 'click', { selector: '#amount', real: true }),
            [{ type: 'text', text: DONE }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-focus-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('欄を押して打ち、別の欄を押すと、前の欄に blur と focusout が届き、出たときの処理が走る', async () => {
    await app.startSession(START, { mode: 'manual' });
    await app.byText('.chat-list', DONE).waitFor();
    const state = await page();
    expect(state.hasFocus).toBe(true);
    expect(state.code).toBe('A01');
    expect(state.amount).toBe('100');
    expect(state.name).toBe('交通費');
    expect(state.total).toBe('200');
    expect(state.events).toEqual([
      'focus:code',
      'focusin:code',
      'blur:code',
      'focusout:code',
      'focus:amount',
      'focusin:amount',
      // 本物の押下で #code へ
      'blur:amount',
      'focusout:amount',
      'focus:code',
      'focusin:code',
      // 本物の押下で #amount へ
      'blur:code',
      'focusout:code',
      'focus:amount',
      'focusin:amount',
    ]);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
