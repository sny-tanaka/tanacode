import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude がアプリ内ブラウザのページを押しても（click・セレクタありの type）、人がいるチャットの入力欄からフォーカスを奪わない。
// 直す前: 押すのを CDP のマウスの押下で送っていた。Chromium は、押されたページを持つ webview にフォーカスを移すので、人のフォーカスが
// webview へ移り、打っている途中の文字・変換が途切れた（ブラウザを閉じていても、裏で描かせているタブで起きた）。
// ふだんはページの中の JavaScript で押す（フォーカスを動かさない）。ボタン・リンク・チェックボックス・ラジオ・入力欄・フォームの送信は、
// 今までどおり効く。<select>・ファイルを選ぶ欄・新しい窓を開くリンク・ドラッグできる要素と、Claude が real を指定したときは、
// 本物の押下で押し、押したらすぐ人のフォーカスを元の場所へ戻す。人のフォーカスがページにあるときは、ページのまま

const START = 'ページを押す準備をしてください';
const READY = '準備できました';
const DRAFT = '人の下書き';
const tool = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name: browserToolId(name), input });
const rounds = [
  { name: 'ボタン', call: ['click', { selector: '#btn' }] },
  { name: 'リンク', call: ['click', { selector: '#link' }] },
  { name: 'チェックボックス', call: ['click', { selector: '#check' }] },
  { name: 'ラジオ', call: ['click', { selector: '#r2' }] },
  { name: '入力欄', call: ['click', { selector: '#field' }] },
  { name: '入力欄に打つ', call: ['type', { text: 'abc' }] },
  { name: 'セレクタありの type と送信', call: ['type', { selector: '#q', text: 'q', submit: true }] },
  { name: '送信のボタン', call: ['click', { selector: '#submit' }] },
  { name: '位置で押す', call: ['click', { x: 30, y: 15 }] },
  { name: 'ダブルクリック', call: ['click', { selector: '#btn', double: true }] },
  { name: '変換中のボタン', call: ['click', { selector: '#btn' }] },
  { name: 'ブラウザを閉じているときのボタン', call: ['click', { selector: '#btn' }] },
  { name: 'select（本物）', call: ['click', { selector: '#sel option:nth-child(2)' }] },
  { name: 'ファイルを選ぶ欄（本物）', call: ['click', { selector: '#file' }] },
  { name: 'ドラッグできる要素（本物）', call: ['click', { selector: '#drag' }] },
  { name: 'real の指定（本物）', call: ['click', { selector: '#btn', real: true }] },
  { name: '新しい窓を開くリンク（本物）', call: ['click', { selector: '#blank' }] },
  { name: '人がページにいるときのボタン', call: ['click', { selector: '#btn' }] },
].map((r, i) => ({ ...r, prompt: `ページを押してください ${i}`, hold: `押します ${i}`, done: `押しました ${i}` }));

type PageState = { clicked: number; dbl: number; hash: string; check: boolean; r2: boolean; field: string; q: string; submitted: number; active: string; sel: string; trusted: string[] };

describe('Claude がページを押しても、人の入力欄からフォーカスを奪わない', () => {
  let app: E2EApp;
  let server: Server;
  let origin: string;
  const holds = new Map<string, { reached: Promise<void>; reach: () => void; release: () => void }>();
  const input = () => app.page.locator('.chat-input textarea');
  const focused = () =>
    app.page.evaluate(() => {
      const el = document.activeElement;
      return el?.matches('.chat-input textarea') ? 'chat' : el ? `${el.tagName.toLowerCase()}.${String(el.className)}` : null;
    });
  // ページ（最初のタブ。新しい窓を開くリンクで、タブが増える）の様子。main で読む
  const page = () =>
    app.app.evaluate(async ({ webContents }, url) => {
      // 押すページ（新しい窓のタブ /new ではないもの。リンクで #linked が付く）
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && !w.isDestroyed() && w.getURL().split('#')[0] === url);
      return guest!.executeJavaScript(`({ clicked: Number(document.body.dataset.clicked || 0), dbl: Number(document.body.dataset.dbl || 0), hash: location.hash,
        check: document.querySelector('#check').checked, r2: document.querySelector('#r2').checked, field: document.querySelector('#field').value,
        q: document.querySelector('#q').value, submitted: Number(document.body.dataset.submitted || 0), active: document.activeElement.id,
        sel: document.querySelector('#sel').value, trusted: __trusted.slice() })`);
    }, `${origin}/`) as Promise<PageState>;
  const browserTabs = () => app.page.locator('.preview-pane .preview-tab');
  // 止めたところで、人がチャットの入力欄で下書きを打っている（composing: 下書きのあとに、変換している途中の文字がある）。
  // そこで Claude に押させ、ツールの結果が返るまで待つ。人の入力欄の文字とフォーカスは変わらない
  const runWhileInChat = async (index: number, { composing = false } = {}) => {
    const round = rounds[index];
    const results = app.api.toolResults.length;
    await app.send(round.prompt);
    await holds.get(round.hold)!.reached;
    await input().fill('');
    await input().focus();
    await app.page.keyboard.type(DRAFT);
    const cdp = composing ? await app.page.context().newCDPSession(app.page) : null;
    await cdp?.send('Input.imeSetComposition', { text: 'へんか', selectionStart: 3, selectionEnd: 3 });
    holds.get(round.hold)!.release();
    await app.waitUntil(`${round.name} の結果`, () => app.api.toolResults.length > results);
    await app.byText('.chat-list', round.done).waitFor();
    await app.rendered();
    expect(await focused()).toBe('chat');
    if (cdp) {
      // 変換を続けて確定できる（途中で外れていたら、変換は確定済みで、ここで足す文字が後ろに付く）
      await cdp.send('Input.imeSetComposition', { text: 'へんかん', selectionStart: 4, selectionEnd: 4 });
      await cdp.send('Input.insertText', { text: '変換' });
      await cdp.detach();
      expect(await input().inputValue()).toBe(`${DRAFT}変換`);
    } else {
      expect(await input().inputValue()).toBe(DRAFT);
    }
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if ((req.url ?? '/').startsWith('/new')) {
        res.end('<!doctype html><title>新しい窓</title><p>新しい窓</p>');
        return;
      }
      res.end(`<!doctype html><title>押すページ</title>
<body style="margin:0">
<button id="btn" style="position:absolute;left:0;top:0;width:120px;height:30px">押す</button>
<div style="position:absolute;left:0;top:60px">
  <a id="link" href="#linked">リンク</a>
  <input id="check" type="checkbox" aria-label="チェック">
  <input id="r1" type="radio" name="r" checked aria-label="一"><input id="r2" type="radio" name="r" aria-label="二">
  <input id="field" aria-label="欄">
  <form id="form"><input id="q" aria-label="検索"><button id="submit">送る</button></form>
  <select id="sel" size="3" aria-label="選ぶ"><option value="a">a</option><option value="b">b</option><option value="c">c</option></select>
  <input id="file" type="file" aria-label="ファイル">
  <div id="drag" draggable="true" style="width:80px;height:20px;background:#ccc">ドラッグ</div>
  <a id="blank" href="/new" target="_blank">新しい窓</a>
</div>
<script>
  window.__trusted = [];
  document.addEventListener('mousedown', (e) => __trusted.push(e.target.closest('[id]')?.id + ':' + e.isTrusted), true);
  document.querySelector('#btn').addEventListener('click', () => (document.body.dataset.clicked = Number(document.body.dataset.clicked || 0) + 1));
  document.querySelector('#btn').addEventListener('dblclick', () => (document.body.dataset.dbl = Number(document.body.dataset.dbl || 0) + 1));
  document.querySelector('#form').addEventListener('submit', (e) => { e.preventDefault(); document.body.dataset.submitted = Number(document.body.dataset.submitted || 0) + 1; });
</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = await E2EApp.launch({
      trusted: true,
      claudeSettings: { permissions: { allow: ['navigate', 'click', 'type', 'press_key'].map(browserToolId) } },
      conversations: () => [
        {
          match: START,
          steps: [
            [tool('toolu_open', 'navigate', { url: `${origin}/` })],
            [{ type: 'text', text: READY }],
            ...rounds.flatMap((r, i): Block[][] => [
              [{ type: 'text', text: r.hold }, tool(`toolu_click_${i}`, r.call[0] as string, r.call[1] as Record<string, unknown>)],
              [{ type: 'text', text: r.done }],
            ]),
          ],
        },
      ],
    });
    for (const r of rounds) {
      let reach = () => {};
      const reached = new Promise<void>((resolve) => (reach = resolve));
      holds.set(r.hold, { reached, reach, release: () => {} });
    }
    app.api.holdText = (text) => {
      const entry = holds.get(text);
      if (!entry) return Promise.resolve();
      entry.reach();
      return new Promise<void>((resolve) => (entry.release = resolve));
    };
    await app.startSession(START, { mode: 'manual' });
    await app.byText('.chat-list', READY).waitFor();
    // ファイルを選ぶ窓は出さない（本物の押下で開くと、裏で起動していても前に出る）。CDP で選ぶ窓を止め、開こうとしたことだけを控える
    await app.app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview')!;
      if (!guest.debugger.isAttached()) guest.debugger.attach('1.3');
      (globalThis as { __fileChooser?: number }).__fileChooser = 0;
      guest.debugger.on('message', (_e, method) => {
        if (method === 'Page.fileChooserOpened') (globalThis as { __fileChooser?: number }).__fileChooser! += 1;
      });
      await guest.debugger.sendCommand('Page.enable');
      await guest.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-click-${task.name}`);
  });

  afterAll(async () => {
    for (const entry of holds.values()) entry.release();
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('ボタン: 押せて、人の入力欄のフォーカスと下書きはそのまま', async () => {
    await runWhileInChat(0);
    expect((await page()).clicked).toBe(1);
  });

  it('リンク・チェックボックス・ラジオ: 今までどおり効く', async () => {
    await runWhileInChat(1);
    expect((await page()).hash).toBe('#linked');
    await runWhileInChat(2);
    expect((await page()).check).toBe(true);
    await runWhileInChat(3);
    expect((await page()).r2).toBe(true);
  });

  it('入力欄: ページの中でその欄にフォーカスが入り、続けて打てる', async () => {
    await runWhileInChat(4);
    expect((await page()).active).toBe('field');
    await runWhileInChat(5);
    expect((await page()).field).toBe('abc');
  });

  it('セレクタありの type（submit）・送信のボタン: 欄に入れてフォームを送る', async () => {
    await runWhileInChat(6);
    let state = await page();
    expect(state.q).toBe('q');
    expect(state.submitted).toBe(1);
    await runWhileInChat(7);
    state = await page();
    expect(state.submitted).toBe(2);
  });

  it('位置で押す・ダブルクリック: 押せる', async () => {
    await runWhileInChat(8);
    expect((await page()).clicked).toBe(2);
    await runWhileInChat(9);
    const state = await page();
    expect(state.clicked).toBe(4);
    expect(state.dbl).toBe(1);
  });

  it('日本語を変換している途中でも、入力欄のまま変換を続けられる', async () => {
    await runWhileInChat(10, { composing: true });
    expect((await page()).clicked).toBe(5);
  });

  it('ブラウザを閉じているとき（裏で描かせているタブ）も、入力欄のまま', async () => {
    await app.page.click('.preview-pane [aria-label="ブラウザを閉じる"]');
    await expect.poll(() => app.page.locator('.preview-pane').getAttribute('aria-hidden')).toBe('true');
    await runWhileInChat(11, { composing: true });
    expect((await page()).clicked).toBe(6);
  });

  it('<select>・ファイルを選ぶ欄・ドラッグできる要素・real の指定は、本物の押下で押し、人のフォーカスを入力欄へ戻す', async () => {
    await runWhileInChat(12);
    expect((await page()).sel).toBe('b');
    await runWhileInChat(13);
    expect(await app.app.evaluate(() => (globalThis as { __fileChooser?: number }).__fileChooser)).toBe(1);
    await runWhileInChat(14);
    await runWhileInChat(15);
    const state = await page();
    expect(state.clicked).toBe(7);
    // 本物の押下は、ページには本物の操作として届く（ふだんの JS の押下は、本物の操作ではない）
    expect(state.trusted.filter((t) => t.endsWith(':true')).map((t) => t.split(':')[0])).toEqual(['sel', 'file', 'drag', 'btn']);
  });

  it('新しい窓を開くリンクは、本物の押下で押して新しいタブで開き、人のフォーカスを入力欄へ戻す', async () => {
    await runWhileInChat(16);
    await expect.poll(() => browserTabs().count()).toBe(2);
  });

  it('人のフォーカスがページにあるときは、ページのまま（押した要素に、ページの中でフォーカスが入る）', async () => {
    const round = rounds[17];
    const results = app.api.toolResults.length;
    await app.send(round.prompt);
    await holds.get(round.hold)!.reached;
    // 人がページ（最初のタブ）を使っている
    await app.page.click('.activity-bar [aria-label="ブラウザ"]');
    await browserTabs().first().click();
    await app.page.evaluate(() => {
      const shown = [...document.querySelectorAll<HTMLElement>('.preview-pane webview')].find((el) => el.getClientRects().length > 0)!;
      shown.focus();
    });
    await app.page.waitForFunction(() => document.activeElement?.tagName === 'WEBVIEW');
    holds.get(round.hold)!.release();
    await app.waitUntil(`${round.name} の結果`, () => app.api.toolResults.length > results);
    await app.byText('.chat-list', round.done).waitFor();
    await app.rendered();
    expect(await app.page.evaluate(() => document.activeElement?.tagName)).toBe('WEBVIEW');
    const state = await page();
    expect(state.clicked).toBe(8);
    expect(state.active).toBe('btn');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
