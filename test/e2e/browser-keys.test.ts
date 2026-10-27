import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude がアプリ内ブラウザのページで打つキー（press_key・type）は、ページに届き、人がいるチャットの入力欄には入らない。
// 直す前: キーを CDP（Input.dispatchKeyEvent・Input.insertText）で送っていた。CDP は、ブラウザ全体でフォーカスのある所へキーを届けるので、
// webview にフォーカスが無い（人がチャットへ戻った）と、Claude のキーが人の入力欄に入った（⌘Enter なら、人の発言として送られうる）。
// 日本語・修飾キー・Enter・Tab・Backspace も、ページで今までどおり効くこと

const START = 'ページでキーを打つ準備をしてください';
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
].map((r, i) => ({ ...r, prompt: `ページでキーを打ってください ${i}`, hold: `キーを打ちます ${i}`, done: `打ちました ${i}` }));

describe('Claude がページで打つキーは、ページに届き、人の入力欄には入らない', () => {
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
  // ページの様子（欄の文字・フォーカスのある欄・送信した回数・届いたキー）
  const page = () =>
    app.page.evaluate(() => {
      const wv = document.querySelector<HTMLElement & { executeJavaScript(code: string): Promise<unknown> }>('.preview-pane webview')!;
      return wv.executeJavaScript(
        `({ name: document.querySelector('#name').value, second: document.querySelector('#second').value, area: document.querySelector('#area').value,
            active: document.activeElement.id, submitted: Number(document.body.dataset.submitted || 0), keys: __keys.slice() })`,
      ) as Promise<{ name: string; second: string; area: string; active: string; submitted: number; keys: string[] }>;
    });
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
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>キーのページ</title>
<form id="f"><input id="name" aria-label="名前"><input id="second" aria-label="二つ目"><button>送る</button></form>
<textarea id="area" aria-label="欄"></textarea>
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
    expect((await page()).active).toBe('name');
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-keys-${task.name}`);
  });

  afterAll(async () => {
    for (const entry of holds.values()) entry.release();
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
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

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
