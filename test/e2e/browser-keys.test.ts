import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude がアプリ内ブラウザのページで打つキー（press_key・type）は、ページに届き、人がいるチャットの入力欄には入らない。
// 直す前: キーを CDP（Input.dispatchKeyEvent・Input.insertText）で送っていた。CDP は、ブラウザ全体でフォーカスのある所へキーを届けるので、
// webview にフォーカスが無い（人がチャットへ戻った）と、Claude のキーが人の入力欄に入った（⌘Enter なら、人の発言として送られうる）。
// 日本語・修飾キー・Enter・Tab・Backspace・clear・ASCII 以外の 1 文字のキーも、ページで今までどおり効くこと。
// Claude が送った ⌘ のキーは、アプリのショートカット（⌘W・⌘1・⌘2・⌃⌘↓）にならず、人の画面を動かさないこと。
// フォーカスが別プロセスの iframe（別サイト）の中なら、その iframe に入り、人の入力欄には入らないこと

const START = 'ページでキーを打つ準備をしてください';
const OTHER = 'ほかの作業のセッションです';
const OTHER_READY = 'ほかの準備ができました';
const READY = '準備できました';
const DRAFT = '人の下書き';
const tool = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name: browserToolId(name), input });
// 回ごとの指示・止める文・打つツール
const rounds = [
  { name: 'type（セレクタ無し）', call: ['type', { text: 'abc' }] },
  { name: 'press_key（文字）', call: ['press_key', { key: 'x' }] },
  { name: 'type（日本語）', call: ['type', { text: 'たなか' }] },
  { name: 'press_key（Backspace）', call: ['press_key', { key: 'Backspace' }] },
  { name: 'press_key（修飾キー）', call: ['press_key', { key: 'k', modifiers: ['control', 'meta'] }] },
  { name: 'press_key（Tab）', call: ['press_key', { key: 'Tab' }] },
  { name: 'type（submit で Enter）', call: ['type', { text: 'q', submit: true }] },
  { name: 'press_key（Enter で改行）', call: ['press_key', { key: 'Enter' }] },
  { name: 'type（セレクタあり）', call: ['type', { selector: '#area', text: 'sel' }] },
  { name: 'type（clear）', call: ['type', { text: 'new', clear: true }] },
  { name: 'press_key（é）', call: ['press_key', { key: 'é' }] },
  { name: 'press_key（あ）', call: ['press_key', { key: 'あ' }] },
  { name: 'press_key（絵文字）', call: ['press_key', { key: '😀' }] },
  { name: 'press_key（⌘W）', call: ['press_key', { key: 'w', modifiers: ['meta'] }] },
  { name: 'press_key（⌘2）', call: ['press_key', { key: '2', modifiers: ['meta'] }] },
  { name: 'press_key（⌘1）', call: ['press_key', { key: '1', modifiers: ['meta'] }] },
  { name: 'press_key（⌃⌘↓）', call: ['press_key', { key: 'ArrowDown', modifiers: ['control', 'meta'] }] },
  // 別プロセスの iframe の中の欄を、位置で押す（iframe は左上 0,200 に置き、中の欄は iframe の左上）
  { name: 'click（iframe の中の欄）', call: ['click', { x: 20, y: 210 }] },
  { name: 'press_key（iframe）', call: ['press_key', { key: 'z' }] },
  { name: 'type（iframe）', call: ['type', { text: 'frame' }] },
].map((r, i) => ({ ...r, prompt: `ページでキーを打ってください ${i}`, hold: `キーを打ちます ${i}`, done: `打ちました ${i}` }));

describe('Claude がページで打つキーは、ページに届き、人の入力欄には入らない', () => {
  let app: E2EApp;
  let server: Server;
  let frameServer: Server;
  let origin: string;
  const holds = new Map<string, { reached: Promise<void>; reach: () => void; release: () => void }>();
  const input = () => app.page.locator('.chat-input textarea');
  const focused = () =>
    app.page.evaluate(() => {
      const el = document.activeElement;
      return el?.matches('.chat-input textarea') ? 'chat' : el ? `${el.tagName.toLowerCase()}.${String(el.className)}` : null;
    });
  // ページの様子（欄の文字・フォーカスのある欄・送信した回数・届いたキー）
  const page = () =>
    app.page.evaluate(() => {
      const wv = document.querySelector<HTMLElement & { executeJavaScript(code: string): Promise<unknown> }>('.preview-pane webview')!;
      return wv.executeJavaScript(
        `({ name: document.querySelector('#name').value, second: document.querySelector('#second').value, area: document.querySelector('#area').value,
            active: document.activeElement.id, submitted: Number(document.body.dataset.submitted || 0), keys: __keys.slice() })`,
      ) as Promise<{ name: string; second: string; area: string; active: string; submitted: number; keys: string[] }>;
    });
  // 別プロセスの iframe の中の欄の文字（アプリの画面からは読めないので、main で読む）
  const innerValue = () =>
    app.app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && !w.isDestroyed());
      const frame = guest?.mainFrame.frames.find((f) => f !== guest.mainFrame);
      return frame ? ((await frame.executeJavaScript('document.querySelector("#inner").value')) as string) : null;
    });
  const browserTabs = () => app.page.locator('.preview-pane .preview-tab');
  // 選んでいるセッションの ID（行の文字には「作業中」などの様子も入り、ターンの終わりで変わるので、ID で比べる）
  const activeSession = () => app.page.locator('.session-list .session-row.active').getAttribute('data-key-id');
  // 止めたところで、人がチャットの入力欄で下書きを打っている。そこで Claude に打たせ、ツールの結果が返るまで待つ
  const runWhileInChat = async (index: number) => {
    const round = rounds[index];
    const results = app.api.toolResults.length;
    await app.send(round.prompt);
    await holds.get(round.hold)!.reached;
    await input().fill('');
    await input().focus();
    await app.page.keyboard.type(DRAFT);
    holds.get(round.hold)!.release();
    await app.waitUntil(`${round.name} の結果`, () => app.api.toolResults.length > results);
    await app.byText('.chat-list', round.done).waitFor();
    await app.rendered();
    // 人の入力欄には入らない
    expect(await input().inputValue()).toBe(DRAFT);
  };

  beforeAll(async () => {
    frameServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><body style="margin:0"><input id="inner" aria-label="iframe の欄" style="margin:0;width:200px;height:30px">');
    });
    await new Promise<void>((resolve) => frameServer.listen(0, 'localhost', resolve));
    const frameUrl = `http://localhost:${(frameServer.address() as AddressInfo).port}/`;
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>キーのページ</title>
<form id="f"><input id="name" aria-label="名前"><input id="second" aria-label="二つ目"><button>送る</button></form>
<textarea id="area" aria-label="欄"></textarea>
<iframe src="${frameUrl}" style="position:absolute;left:0;top:200px;width:320px;height:80px;border:0"></iframe>
<script>
  window.__keys = [];
  document.addEventListener('keydown', (e) => __keys.push([e.key, e.ctrlKey, e.metaKey, e.altKey, e.shiftKey, e.isTrusted].join(':')), true);
  document.querySelector('#f').addEventListener('submit', (e) => { e.preventDefault(); document.body.dataset.submitted = Number(document.body.dataset.submitted || 0) + 1; });
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
            // ページの欄にフォーカスを置く（このあと、人がチャットへ戻る）
            [tool('toolu_click', 'click', { selector: '#name' })],
            [{ type: 'text', text: READY }],
            ...rounds.flatMap((r, i): Block[][] => [
              [{ type: 'text', text: r.hold }, tool(`toolu_key_${i}`, r.call[0] as string, r.call[1] as Record<string, unknown>)],
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
    // ⌃⌘↓ でセッションが替わるかを見るため、ほかのセッションを先に作っておく
    await app.startSession(OTHER, { mode: 'manual' });
    await app.byText('.chat-list', OTHER_READY).waitFor();
    await app.startSession(START, { mode: 'manual' });
    await app.byText('.chat-list', READY).waitFor();
    expect((await page()).active).toBe('name');
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-keys-${task.name}`);
  });

  afterAll(async () => {
    for (const entry of holds.values()) entry.release();
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
    await new Promise((resolve) => frameServer?.close(resolve));
  });

  it('type（セレクタ無し）: ページのフォーカスのある欄に入り、人の入力欄には入らない。人のフォーカスも動かない', async () => {
    await runWhileInChat(0);
    expect((await page()).name).toBe('abc');
    expect(await focused()).toBe('chat');
  });

  it('press_key（文字）: ページの欄に入る', async () => {
    await runWhileInChat(1);
    expect((await page()).name).toBe('abcx');
    expect(await focused()).toBe('chat');
  });

  it('type（日本語）: IME を通す文字もページの欄に入る', async () => {
    await runWhileInChat(2);
    expect((await page()).name).toBe('abcxたなか');
  });

  it('press_key（Backspace）: ページの欄の 1 文字を消す', async () => {
    await runWhileInChat(3);
    expect((await page()).name).toBe('abcxたな');
  });

  it('press_key（修飾キー）: 修飾キーがページに届き、文字は入らない', async () => {
    await runWhileInChat(4);
    const state = await page();
    expect(state.name).toBe('abcxたな');
    expect(state.keys.at(-1)).toBe('k:true:true:false:false:true');
  });

  it('press_key（Tab）: ページの中で次の欄へ移る', async () => {
    await runWhileInChat(5);
    expect((await page()).active).toBe('second');
    expect(await focused()).toBe('chat');
  });

  it('type（submit）: 打ったあとの Enter で、ページのフォームを送る', async () => {
    await runWhileInChat(6);
    const state = await page();
    expect(state.second).toBe('q');
    expect(state.submitted).toBe(1);
  });

  it('press_key（Enter）: 人の入力欄では改行にも送信にもならない（ページのフォームをもう一度送る）', async () => {
    await runWhileInChat(7);
    expect((await page()).submitted).toBe(2);
  });

  // セレクタありは、先に要素を押す（マウスの押下の扱いは変えていないので、人のフォーカスは webview へ移る）。キーはページに入る
  it('type（セレクタあり）: 押した欄に入り、人の入力欄には入らない', async () => {
    await runWhileInChat(8);
    expect((await page()).area).toBe('sel');
  });

  it('type（clear）: 欄の文字を消してから入れる（消すのと入れるのが入れ替わらない）', async () => {
    await runWhileInChat(9);
    expect((await page()).area).toBe('new');
  });

  it('press_key（ASCII 以外の 1 文字）: é・あ・絵文字もページの欄に入る', async () => {
    await runWhileInChat(10);
    await runWhileInChat(11);
    await runWhileInChat(12);
    expect((await page()).area).toBe('newéあ😀');
    // ページが受ける keydown の key は空になる（sendInputEvent には key を決める項目が無く、Electron がこれらの文字のキーを知らないため。
    // 直す前の CDP では、key がその文字だった）。文字は入る
    expect((await page()).keys.slice(-3).map((k) => k.split(':')[0])).toEqual(['', '', '']);
    expect(await focused()).toBe('chat');
  });

  it('press_key（⌘W・⌘2・⌘1・⌃⌘↓）: Claude の送ったキーは、アプリのショートカットにならない（タブを閉じない・人のフォーカスもセッションも動かない）。ページには届く', async () => {
    const session = await activeSession();
    expect(session).toBeTruthy();
    const before = (await page()).keys.length;
    await runWhileInChat(13);
    expect(await browserTabs().count()).toBe(1);
    await runWhileInChat(14);
    expect(await focused()).toBe('chat');
    await runWhileInChat(15);
    expect(await focused()).toBe('chat');
    await runWhileInChat(16);
    expect(await activeSession()).toBe(session);
    expect(await focused()).toBe('chat');
    expect((await page()).keys.slice(before).filter((k) => k.endsWith(':true'))).toEqual([
      'w:false:true:false:false:true',
      '2:false:true:false:false:true',
      '1:false:true:false:false:true',
      'ArrowDown:true:true:false:false:true',
    ]);
  });

  it('別プロセスの iframe（別サイト）の中の欄: press_key・type が iframe の欄に入り、人の入力欄には入らない', async () => {
    await runWhileInChat(17);
    await runWhileInChat(18);
    await runWhileInChat(19);
    expect(await innerValue()).toBe('zframe');
    expect(await focused()).toBe('chat');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
