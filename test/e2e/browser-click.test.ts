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
const OTHER = 'ほかの作業のセッションです';
const OTHER_READY = 'ほかの準備ができました';
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
  { name: '開いた shadow DOM の中のボタン', call: ['click', { selector: '#xo' }] },
  { name: '閉じた shadow DOM の中のボタン（本物）', call: ['click', { selector: '#xc' }] },
  { name: 'range（本物）', call: ['click', { selector: '#range' }] },
  { name: 'contenteditable', call: ['click', { selector: '#editor' }] },
  { name: 'contenteditable に打つ', call: ['type', { text: 'Z' }] },
  { name: 'hover で反応する要素', call: ['click', { selector: '#hover' }] },
  { name: 'pointerdown で setPointerCapture する要素', call: ['click', { selector: '#capture' }] },
  { name: '同じオリジンの iframe の中の文字', call: ['click', { selector: '#inner' }] },
  { name: 'iframe の中を押したあとに打つ', call: ['type', { text: 'zz' }] },
  { name: 'select（本物）', call: ['click', { selector: '#sel option:nth-child(2)' }] },
  { name: 'ファイルを選ぶ欄（本物）', call: ['click', { selector: '#file' }] },
  { name: 'ドラッグできる要素（本物）', call: ['click', { selector: '#drag' }] },
  { name: 'real の指定（本物）', call: ['click', { selector: '#btn', real: true }] },
  { name: '新しい窓を開くリンク（本物）', call: ['click', { selector: '#blank' }] },
  { name: '人がページにいるときのボタン', call: ['click', { selector: '#btn' }] },
  { name: 'ほかのセッションのページに人がいるときの本物の押下', call: ['click', { selector: '#btn', real: true }] },
  { name: 'タップ', call: ['touch', { action: 'tap', selector: '#btn' }] },
].map((r, i) => ({ ...r, prompt: `ページを押してください ${i}`, hold: `押します ${i}`, done: `押しました ${i}` }));

type PageState = {
  clicked: number;
  dbl: number;
  hash: string;
  check: boolean;
  r2: boolean;
  field: string;
  q: string;
  submitted: number;
  active: string;
  sel: string;
  trusted: string[];
  open: number;
  closed: number;
  range: string;
  editor: string;
  hovered: boolean;
  captured: boolean;
};

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
        sel: document.querySelector('#sel').value, trusted: __trusted.slice(), open: Number(document.body.dataset.open || 0),
        closed: Number(document.body.dataset.closed || 0), range: document.querySelector('#range').value, editor: document.querySelector('#editor').textContent,
        hovered: document.body.dataset.hovered === '1', captured: document.body.dataset.captured === '1' })`);
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
  <x-open id="xo" style="display:block;width:100px;height:24px"></x-open>
  <x-closed id="xc" style="display:block;width:100px;height:24px"></x-closed>
  <input id="range" type="range" min="0" max="100" value="0" style="width:200px" aria-label="範囲">
  <div id="editor" contenteditable="true" style="display:inline-block;font:16px monospace">aaaaabbbbb</div>
  <div id="hover" style="width:100px;height:20px">乗せる</div>
  <div id="capture" style="width:100px;height:20px">つかむ</div>
  <iframe id="inner" srcdoc="<p style='margin:0'>中の文字</p>" style="display:block;width:200px;height:40px;border:0"></iframe>
</div>
<script>
  window.__trusted = [];
  document.addEventListener('mousedown', (e) => __trusted.push(e.target.closest('[id]')?.id + ':' + e.isTrusted), true);
  document.querySelector('#btn').addEventListener('click', () => (document.body.dataset.clicked = Number(document.body.dataset.clicked || 0) + 1));
  document.querySelector('#btn').addEventListener('dblclick', () => (document.body.dataset.dbl = Number(document.body.dataset.dbl || 0) + 1));
  for (const [name, mode] of [['x-open', 'open'], ['x-closed', 'closed']]) {
    customElements.define(name, class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode });
        root.innerHTML = '<button style="width:100%;height:24px">中</button>';
        root.querySelector('button').addEventListener('click', () => (document.body.dataset[mode] = Number(document.body.dataset[mode] || 0) + 1));
      }
    });
  }
  document.querySelector('#hover').addEventListener('mouseover', () => (document.body.dataset.hovered = '1'));
  document.querySelector('#capture').addEventListener('pointerdown', (e) => { e.target.setPointerCapture(e.pointerId); document.body.dataset.captured = '1'; });
  document.querySelector('#form').addEventListener('submit', (e) => { e.preventDefault(); document.body.dataset.submitted = Number(document.body.dataset.submitted || 0) + 1; });
</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = await E2EApp.launch({
      trusted: true,
      claudeSettings: { permissions: { allow: ['navigate', 'click', 'type', 'press_key', 'touch'].map(browserToolId) } },
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
        { match: OTHER, steps: [[{ type: 'text', text: OTHER_READY }]] },
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

  it('開いた shadow DOM の中のボタンは、中まで届く。閉じた shadow DOM（中が見えない部品）は、本物の押下で押す', async () => {
    await runWhileInChat(12);
    expect((await page()).open).toBe(1);
    await runWhileInChat(13);
    expect((await page()).closed).toBe(1);
    expect(app.api.toolResults.at(-1)).toContain('with a real mouse press, because JavaScript cannot reach inside the element (x-closed)');
  });

  it('range は本物の押下で押す（押した位置に動く）', async () => {
    await runWhileInChat(14);
    expect(Number((await page()).range)).toBeGreaterThan(30);
  });

  it('contenteditable: 押した位置にカーソルが置かれ、続けて打てる', async () => {
    await runWhileInChat(15);
    await runWhileInChat(16);
    expect((await page()).editor).toBe('aaaaaZbbbbb');
  });

  it('hover で反応する要素: 乗せたときのイベントも届く', async () => {
    await runWhileInChat(17);
    expect((await page()).hovered).toBe(true);
  });

  // Chromium では、マウスのポインター（pointerId 1）は、押していなくても setPointerCapture できる（Radix の Slider などの部品が投げない）。
  // ページの処理がエラーを投げたときに、real で押し直すよう添えることは、部品のテストで確かめる
  it('pointerdown で setPointerCapture する要素: エラーにならずに、ページの処理が最後まで動く', async () => {
    await runWhileInChat(18);
    expect((await page()).captured).toBe(true);
    expect(app.api.toolResults.at(-1)).not.toContain('real: true');
  });

  it('同じオリジンの iframe の中の、押せる所の無い要素を押したら、そのあとのキーは外の欄に入らない', async () => {
    await runWhileInChat(19);
    await runWhileInChat(20);
    expect((await page()).field).toBe('abc');
  });

  it('<select>・ファイルを選ぶ欄・ドラッグできる要素・real の指定は、本物の押下で押し、人のフォーカスを入力欄へ戻す', async () => {
    await runWhileInChat(21);
    expect((await page()).sel).toBe('b');
    await runWhileInChat(22);
    expect(await app.app.evaluate(() => (globalThis as { __fileChooser?: number }).__fileChooser)).toBe(1);
    await runWhileInChat(23);
    await runWhileInChat(24);
    const state = await page();
    expect(state.clicked).toBe(7);
    // 本物の押下は、ページには本物の操作として届く（ふだんの JS の押下は、本物の操作ではない）
    expect(state.trusted.filter((t) => t.endsWith(':true')).map((t) => t.split(':')[0])).toEqual(['xc', 'range', 'sel', 'file', 'drag', 'btn']);
  });

  it('新しい窓を開くリンクは、本物の押下で押して新しいタブで開き、人のフォーカスを入力欄へ戻す', async () => {
    await runWhileInChat(25);
    await expect.poll(() => browserTabs().count()).toBe(2);
  });

  it('人のフォーカスがページにあるときは、ページのまま（押した要素に、ページの中でフォーカスが入る）', async () => {
    const round = rounds[26];
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

  // 直す前: 人のフォーカスがどの webview にあっても「人がページにいる」とみなし、戻さなかった（人のキーが Claude のページに入った）
  it('人がほかのセッションのブラウザのページにいる間に、Claude が本物で押しても、人のフォーカスはそのページへ戻る', async () => {
    const round = rounds[27];
    const results = app.api.toolResults.length;
    await app.send(round.prompt);
    await holds.get(round.hold)!.reached;
    // 人が、ほかのセッションのブラウザでページを開いて使っている
    await app.startSession(OTHER, { mode: 'manual' });
    await app.byText('.chat-list', OTHER_READY).waitFor();
    const address = '.preview-pane .preview-address input';
    await app.page.locator(address).waitFor();
    await app.page.fill(address, `${origin}/new`);
    await app.page.press(address, 'Enter');
    await app.byText('.preview-pane .preview-tab', '新しい窓').waitFor();
    const human = await app.page.evaluate(() => {
      const shown = [...document.querySelectorAll<HTMLElement & { getWebContentsId(): number }>('.preview-pane webview')].find((el) => el.getClientRects().length > 0)!;
      shown.focus();
      return shown.getWebContentsId();
    });
    await app.page.waitForFunction(() => document.activeElement?.tagName === 'WEBVIEW');
    holds.get(round.hold)!.release();
    await app.waitUntil(`${round.name} の結果`, () => app.api.toolResults.length > results);
    await app.rendered();
    expect(app.api.toolResults.at(-1)).toContain('with a real mouse press, as requested');
    expect(await app.page.evaluate(() => (document.activeElement as HTMLElement & { getWebContentsId?(): number })?.getWebContentsId?.() ?? null)).toBe(human);
    expect((await page()).clicked).toBe(9);
    // 戻る
    await app.page.locator('.session-list .session-row', { hasText: START }).click();
    await app.byText('.chat-list', READY).waitFor();
  });

  it('タップ（touch）でも、人の入力欄からフォーカスを奪わない（奪われたら、すぐ戻す）', async () => {
    // タッチは、ブラウザに出ているところにしか届かない
    if ((await app.page.locator('.preview-pane').getAttribute('aria-hidden')) === 'true') await app.page.click('.activity-bar [aria-label="ブラウザ"]');
    await browserTabs().first().click();
    await runWhileInChat(28);
    expect((await page()).clicked).toBe(10);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
