import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import { E2EApp } from './app';

// 人の操作でないのに、チャットの入力欄からフォーカスを奪わない。
// - ターミナルのパネルを開いたまま、チャットに打っている間に、シェルがタイトルを変えても（zsh の precmd など）・パネルの高さが変わっても、
//   入力欄のまま（直す前: タブの名前が変わるたびに、xterm へフォーカスが移った）
// - Claude がアプリ内ブラウザを開いても、入力欄のまま（直す前: ページを開く前の空のブラウザが出て、アドレス欄へ移った）
//   日本語を変換している途中でも同じ
// - 人の操作でないのに外れたら、アプリのログ（userData/focus.log）に残る
// - 人がパネルを開いた（ボタン・⌘J）・タブを押した・新しいタブを開いたときは、今までどおり xterm（ブラウザはアドレス欄）へ移る

const START = 'フォーカスを試してください';
const READY = '準備できました';
const BROWSE = 'ブラウザでページを開いてください';
const OPENING = 'ページを開きます';
const OPENED = 'ページを開きました';
// 人が最初に開いたシェル（アプリのシェルの通し番号）
const SHELL = 'shell-1';

describe('人の操作でないのに、チャットの入力欄からフォーカスを奪わない', () => {
  let app: E2EApp;
  let server: Server;
  let origin: string;
  let releaseOpening = () => {};
  // 「ページを開きます」を書き終える前に止まった
  let reachOpening = () => {};
  const openingReached = new Promise<void>((resolve) => (reachOpening = resolve));
  const input = () => app.page.locator('.chat-input textarea');
  const shell = () => app.page.locator('.terminal-panel .terminal-instance:not([hidden])');
  const terminalTab = (n: number) => app.page.locator('.terminal-panel .terminal-tab').nth(n);
  // 今フォーカスのあるところ（チャットの入力欄・見えている xterm・ブラウザのアドレス欄・そのほか）
  const focused = () =>
    app.page.evaluate(() => {
      const el = document.activeElement;
      if (el?.matches('.chat-input textarea')) return 'chat';
      if (el?.closest('.terminal-panel .terminal-instance:not([hidden])')) return 'terminal';
      if (el?.getAttribute('aria-label') === '開く URL') return 'address';
      return el ? `${el.tagName.toLowerCase()}.${el.className}` : null;
    });
  // シェルに打つ（人が xterm で打ったのと同じく pty へ書く。フォーカスは動かさない）
  const writeToShell = (text: string) =>
    app.page.evaluate(
      ([id, data]) => (window as unknown as { tanacode: { shell: { write(id: string, data: string): void } } }).tanacode.shell.write(id, data),
      [SHELL, text] as const,
    );
  // シェルにタイトルを変えさせる（zsh の precmd などと同じ OSC 0）
  const setTitle = (title: string) => writeToShell(`printf '\\033]0;${title}\\007'\r`);
  const typeInChat = async (text: string) => {
    await input().focus();
    await app.page.keyboard.type(text);
  };
  // パネルの高さを、境目をマウスで動かして変える（押しても、フォーカスは動かない）
  const dragResizer = async (dy: number) => {
    const box = (await app.page.locator('.terminal-resizer').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await app.page.mouse.move(x, y);
    await app.page.mouse.down();
    await app.page.mouse.move(x, y + dy, { steps: 4 });
    await app.page.mouse.up();
  };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>開いたページ</title><p>中身</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = await E2EApp.launch({
      trusted: true,
      claudeSettings: { permissions: { allow: [browserToolId('navigate')] } },
      conversations: () => [
        {
          match: START,
          steps: [
            [{ type: 'text', text: READY }],
            // 2 つめの指示（BROWSE）への答え
            [
              { type: 'text', text: OPENING },
              { type: 'tool_use', id: 'toolu_open', name: browserToolId('navigate'), input: { url: `${origin}/` } },
            ],
            [{ type: 'text', text: OPENED }],
          ],
        },
      ],
    });
    // 「ページを開きます」を書き終える前に止める（そのあいだに、人がチャットに打ち始める）
    app.api.holdText = (text) => {
      if (text !== OPENING) return Promise.resolve();
      reachOpening();
      return new Promise<void>((resolve) => (releaseOpening = resolve));
    };
    await app.startSession(START, { mode: 'manual' });
    await app.byText('.chat-list', READY).waitFor();
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`focus-steal-${task.name}`);
  });

  afterAll(async () => {
    releaseOpening();
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('ボタンでターミナルのパネルを開くと、xterm にフォーカスが入る', async () => {
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await shell().locator('.xterm-rows').waitFor();
    await app.page.waitForFunction(() => !!document.activeElement?.closest('.terminal-panel .terminal-instance:not([hidden])'));
  });

  it('チャットに打っている間に、シェルがタイトルを変えても、入力欄からフォーカスが外れない', async () => {
    await typeInChat('あいう');
    await setTitle('tc-title-1');
    await app.page.locator('.terminal-panel .terminal-tab[title="tc-title-1"]').waitFor();
    await app.rendered();
    expect(await focused()).toBe('chat');
    await app.page.keyboard.type('えお');
    expect(await input().inputValue()).toBe('あいうえお');
  });

  // 日本語を変換している途中（本物の IME の代わりに、Chromium に変換中の文字を渡す。CDP の Input.imeSetComposition）
  it('チャットで日本語を変換している途中に、シェルがタイトルを変えても、入力欄からフォーカスが外れず、変換を続けられる', async () => {
    await input().fill('');
    await input().focus();
    const cdp = await app.page.context().newCDPSession(app.page);
    const compose = (text: string) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await compose('へんか');
    expect(await app.page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value)).toBe('へんか');
    await setTitle('tc-title-ime');
    await app.page.locator('.terminal-panel .terminal-tab[title="tc-title-ime"]').waitFor();
    await app.rendered();
    expect(await focused()).toBe('chat');
    await compose('へんかん');
    await cdp.send('Input.insertText', { text: '変換' });
    await cdp.detach();
    expect(await input().inputValue()).toBe('変換');
  });

  it('チャットに打っている間に、パネルの高さが変わっても、入力欄からフォーカスが外れない', async () => {
    await input().focus();
    await dragResizer(-40);
    await app.rendered();
    expect(await focused()).toBe('chat');
  });

  it('xterm で打っている間に、パネルの高さやタイトルが変わっても、xterm のフォーカスはそのまま', async () => {
    await shell().locator('.xterm-helper-textarea').focus();
    await dragResizer(40);
    await setTitle('tc-title-2');
    await app.page.locator('.terminal-panel .terminal-tab[title="tc-title-2"]').waitFor();
    await app.rendered();
    expect(await focused()).toBe('terminal');
  });

  it('新しいタブを開く・タブを押すと、そのタブの xterm にフォーカスが入る', async () => {
    await input().focus();
    await app.page.click('.terminal-panel [aria-label="新しいターミナル"]');
    await app.page.locator('.terminal-panel .terminal-tab').nth(1).waitFor();
    await app.page.waitForFunction(() => !!document.activeElement?.closest('.terminal-panel .terminal-instance:not([hidden])'));
    expect(await terminalTab(1).getAttribute('aria-selected')).toBe('true');
    await input().focus();
    await terminalTab(0).click();
    await app.page.waitForFunction(() => !!document.activeElement?.closest('.terminal-panel .terminal-instance:not([hidden])'));
    expect(await terminalTab(0).getAttribute('aria-selected')).toBe('true');
  });

  it('チャットで ⌘J を押してパネルを閉じて開くと、xterm にフォーカスが入る', async () => {
    await input().focus();
    await app.page.keyboard.press('Meta+j');
    await app.page.locator('.terminal-panel').waitFor({ state: 'hidden' });
    expect(await focused()).toBe('chat');
    await app.page.keyboard.press('Meta+j');
    await shell().locator('.xterm-rows').waitFor();
    await app.page.waitForFunction(() => !!document.activeElement?.closest('.terminal-panel .terminal-instance:not([hidden])'));
  });

  it('チャットに打っている間に、Claude がアプリ内ブラウザを開いても、入力欄からフォーカスが外れない', async () => {
    await app.send(BROWSE);
    await openingReached;
    await typeInChat('かきく');
    releaseOpening();
    await app.byText('.chat-list', OPENED).waitFor();
    await app.page.locator('.preview-pane .preview-webview').waitFor();
    await app.rendered();
    expect(await focused()).toBe('chat');
    expect(await input().inputValue()).toBe('かきく');
  });

  it('ブラウザで新しいタブを開くと、アドレス欄にフォーカスが入る', async () => {
    await input().focus();
    await app.page.click('.preview-pane [aria-label="新しいタブ"]');
    await app.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '開く URL');
  });

  // 原因を突き止められなかったときのため、次に起きたときに読めるログ（userData/focus.log）
  it('日本語を変換している途中に、人の操作でないのに入力欄から外れたら、focus.log に移った先・変換中だったこと・外した処理のスタックが残る', async () => {
    const log = join(app.userData, 'focus.log');
    const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
    await input().focus();
    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send('Input.imeSetComposition', { text: 'にゅう', selectionStart: 3, selectionEnd: 3 });
    // 直前に人が押したもの（前のテストのクリック）を、人の操作とみなす間（1 秒）の外にする
    await app.page.waitForTimeout(1100);
    const before = lines().length;
    await app.page.evaluate(() => (document.querySelector('.terminal-panel [aria-label="新しいターミナル"]') as HTMLElement).focus());
    await app.waitUntil('focus.log に書く', () => lines().length > before);
    await cdp.detach();
    const entry = JSON.parse(lines().at(-1)!.replace(/^\S+ /, '')) as { reason: string; to: string; composing: boolean; stack: string | null };
    expect(entry).toMatchObject({ reason: 'focusout', to: expect.stringContaining('in .terminal-panel'), composing: true });
    expect(entry.stack).toMatch(/onFocusOut|focusout|Error/);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
