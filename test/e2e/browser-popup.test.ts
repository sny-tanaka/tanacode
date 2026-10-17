import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// アプリ内ブラウザのページが window.open でポップアップ（features 付き。OAuth のログインの窓など）を開くと、アプリ内ブラウザの外の
// 別ウインドウで開き、開いたページ（window.opener）とつながるか。アプリの index.ts・browser-windows.ts を通って、本物の webview と BrowserWindow まで。
// - ポップアップから opener に postMessage が届く。ポップアップの window.close() で、別ウインドウが閉じる
// - 別ウインドウにも、タブと同じ守りが効く: Node もアプリの API（preload の window.tanacode）も無い（features で nodeIntegration=yes などを
//   渡しても）・features で閉じられない・フォーカスできない・透明・動かせない・最前面などを指定しても、ふつうのウインドウ・トップのフレームは http(s) と about:blank だけ（file: にも blob: にも移れない）・プレビューのセッション
// - 別ウインドウは、ページが画面の外の位置を指定しても、tanacode のウインドウがある画面の中に開く
// - 別ウインドウは Claude の操作の対象にしない（タブの一覧に出ない）。Claude の操作で開いたら、そのことを Claude に伝える
// - 人の操作（Claude の操作の外）で開いたものも、同じように開く

const OPEN = 'ログインのポップアップを確かめてください';
const DONE = 'ポップアップを確かめました';
// ポップアップが opener に送る報告（Node・アプリの API が無く、file: にも blob: にも移らなかった）
const REPORT = 'popup node:undefined/undefined,app:undefined,stayed';
// 作られた別ウインドウ。preview: プレビューのセッション / normal: ふつうのウインドウ（閉じられる・フォーカスできる・不透明・動かせる・
// 最小化できる・最前面でない・影がある・ほかのデスクトップに出ない）/ inside: tanacode のウインドウがある画面の中 / closed: 閉じた
type Popup = { preview: boolean; normal: boolean; inside: boolean; closed: boolean };
const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name: browserToolId(name), input }];

const OPENER = `<!doctype html><title>開く側</title><h1>ログインの前</h1>
<button id="login" onclick="window.open('/popup', 'login', 'width=480,height=640,left=-10000,top=-10000,nodeIntegration=yes,sandbox=no,contextIsolation=no,webviewTag=yes,closable=no,focusable=no,opacity=0,movable=no,minimizable=no,alwaysOnTop=yes,hasShadow=no,visibleOnAllWorkspaces=yes,type=panel')">ログイン</button>
<p id="result">まだ</p>
<script>
  let count = 0;
  addEventListener('message', (e) => {
    if (e.origin === location.origin) document.getElementById('result').textContent = e.data + ' #' + ++count;
  });
</script>`;

// 移れてしまったら、移った先のページが opener に知らせる（移らなければ、もとのページが報告する）
const POPUP = `<!doctype html><title>ポップアップ</title><p>ログインの窓</p>
<script>
  const env = 'node:' + typeof require + '/' + typeof process + ',app:' + typeof window.tanacode;
  const moved = URL.createObjectURL(new Blob(['<script>opener.postMessage("moved-to-blob", "*")<\\/script>'], { type: 'text/html' }));
  setTimeout(() => { location.href = 'file:///etc/hosts'; }, 100);
  setTimeout(() => { location.href = moved; }, 400);
  setTimeout(() => {
    window.opener.postMessage('popup ' + env + ',stayed', location.origin);
    setTimeout(() => window.close(), 500);
  }, 1500);
</script>`;

describe('アプリ内ブラウザのページが開くポップアップ', () => {
  let app: E2EApp;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/popup' ? POPUP : OPENER);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = await E2EApp.launch({
      trusted: true,
      claudeSettings: { permissions: { allow: [browserToolId('navigate'), browserToolId('click'), browserToolId('wait_for')] } },
      conversations: () => [
        {
          match: OPEN,
          steps: [
            tool('toolu_open', 'navigate', { url: `${origin}/` }),
            tool('toolu_login', 'click', { selector: '#login' }),
            tool('toolu_wait', 'wait_for', { text: 'stayed', timeoutMs: 15_000 }),
            tool('toolu_read', 'get_text', { selector: '#result' }),
            tool('toolu_tabs', 'list_tabs', {}),
            [{ type: 'text', text: DONE }],
          ],
        },
      ],
    });
    // 作られたウインドウ（アプリのウインドウのあとのもの）と、そのセッションがプレビューのものか・tanacode のウインドウがある画面の中かを控える
    await app.app.evaluate(({ app: electronApp, BrowserWindow, screen, session }) => {
      const created: Popup[] = [];
      (globalThis as { __popups?: typeof created }).__popups = created;
      electronApp.on('browser-window-created', (_event, win) => {
        const normal =
          win.isClosable() && win.isFocusable() && win.getOpacity() === 1 && win.isMovable() && win.isMinimizable() && !win.isAlwaysOnTop() && win.hasShadow() && !win.isVisibleOnAllWorkspaces();
        const entry = { preview: win.webContents.session === session.fromPartition('persist:tanacode-preview'), normal, inside: false, closed: false };
        created.push(entry);
        // 位置は、作られた時点ではまだ決まっていない（詰めないと、Electron があとでページの指定の位置へ動かす。実測）。
        // ページを読み込み終えてから閉じるまで、0.1 秒ごとに見て、ずっと画面の中にあったかを控える
        // （ページの window.close() では close の知らせが出ずに閉じるので、閉じるときには見られない）
        const seen: boolean[] = [];
        const look = () => {
          if (win.isDestroyed()) return false;
          const main = BrowserWindow.getAllWindows().find((w) => w !== win);
          const area = main ? screen.getDisplayMatching(main.getBounds()).workArea : null;
          const b = win.getBounds();
          seen.push(!!area && b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height);
          entry.inside = seen.every(Boolean);
          return true;
        };
        win.webContents.once('did-finish-load', () => {
          look();
          const timer = setInterval(() => {
            if (!look()) clearInterval(timer);
          }, 100);
        });
        win.on('closed', () => (entry.closed = true));
      });
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-popup-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  const popups = () => app.app.evaluate(() => (globalThis as { __popups?: Popup[] }).__popups ?? []);
  const windows = () => app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  it('Claude が押して開いたポップアップは別ウインドウで開き、opener に届く。Node もアプリの API も無く、file: にも blob: にも移れない', async () => {
    await app.startSession(OPEN, { mode: 'manual' });
    await app.byText('.chat-list', DONE).waitFor();
    expect(app.api.toolResults.find((r) => r.startsWith('Clicked: button#login'))).toContain(`Opened a popup window outside the in-app browser (${origin})`);
    expect(app.api.toolResults.find((r) => r.includes(REPORT))).toContain(`${REPORT} #1`);
    // 別ウインドウは、タブの一覧に出ない
    expect(app.api.toolResults.find((r) => r.startsWith('Tabs (* marks the current tab):'))).toBe(`Tabs (* marks the current tab):\n* 1. 開く側 — ${origin}/`);
    expect((await popups())[0]?.preview).toBe(true);
  });

  it('ポップアップの window.close() で、別ウインドウが閉じる。ページが画面の外の位置を指定しても、閉じるまで画面の中にある', async () => {
    await expect.poll(popups, { timeout: 10_000 }).toEqual([{ preview: true, normal: true, inside: true, closed: true }]);
    expect(await windows()).toBe(1);
  });

  it('人の操作（Claude の操作の外）で開いたポップアップも、別ウインドウで開いて opener に届く', async () => {
    // 人がボタンを押したのと同じく、ユーザーの操作の扱い（userGesture）でページのボタンを押す
    await app.app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().endsWith('/'));
      await guest?.executeJavaScript('document.getElementById("login").click()', true);
    });
    await expect.poll(popups, { timeout: 10_000 }).toHaveLength(2);
    await expect
      .poll(() => app.app.evaluate(({ webContents }) => webContents.getAllWebContents().find((c) => c.getType() === 'webview')?.executeJavaScript('document.getElementById("result").textContent')), { timeout: 15_000 })
      .toBe(`${REPORT} #2`);
    await expect.poll(popups, { timeout: 10_000 }).toEqual([
      { preview: true, normal: true, inside: true, closed: true },
      { preview: true, normal: true, inside: true, closed: true },
    ]);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
