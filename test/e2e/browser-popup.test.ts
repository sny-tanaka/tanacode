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
// - 空のページ（window.open('')）を開いてから location を移すもの（MSAL などの OAuth）も、別ウインドウで開いて opener に届く
// - Claude の操作で、許す先の外（[::1]）のポップアップは開かない
// - ポップアップがさらに開くポップアップも、同じ守りの別ウインドウで開く
// - 1 つのタブから開いておけるのは 5 個まで（続けて開いても）。タブを閉じると、そのタブから開いた別ウインドウだけが閉じる

const OPEN = 'ログインのポップアップを確かめてください';
const DONE = 'ポップアップを確かめました';
const BLOCK = '外のログインを押してください';
const BLOCKED = '外のログインは開きませんでした';
// ポップアップが opener に送る報告（Node・アプリの API が無く、file: にも blob: にも移らなかった）
const REPORT = 'popup node:undefined/undefined,app:undefined,stayed';
// 作られた別ウインドウ。preview: プレビューのセッション / normal: ふつうのウインドウ（閉じられる・フォーカスできる・不透明・動かせる・
// 最小化できる・最前面でない・影がある・ほかのデスクトップに出ない）/ inside: tanacode のウインドウがある画面の中 / closed: 閉じた
type Popup = { preview: boolean; normal: boolean; inside: boolean; closed: boolean };
const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name: browserToolId(name), input }];

// outside: 許す先の外のオリジン
const opener = (outside: string) => `<!doctype html><title>開く側</title><h1>ログインの前</h1>
<button id="login" onclick="window.open('/popup', 'login', 'width=480,height=640,left=-10000,top=-10000,nodeIntegration=yes,sandbox=no,contextIsolation=no,webviewTag=yes,closable=no,focusable=no,opacity=0,movable=no,minimizable=no,alwaysOnTop=yes,hasShadow=no,visibleOnAllWorkspaces=yes,type=panel')">ログイン</button>
<button id="blank-login" onclick="const w = window.open('', 'msal', 'width=480,height=640'); w.location.assign('/popup')">空のページから</button>
<button id="outside-login" onclick="window.open('${outside}/', 'outside', 'width=480,height=640')">外のログイン</button>
<button id="nested" onclick="window.open('/nest', 'nest', 'width=400,height=400')">入れ子</button>
<p id="result">まだ</p>
<script>
  let count = 0;
  addEventListener('message', (e) => {
    if (e.origin === location.origin) document.getElementById('result').textContent = e.data + ' #' + ++count;
  });
</script>`;

// ポップアップが、さらにポップアップを開く。中のポップアップの報告を、自分を開いたタブに伝える
const NEST = `<!doctype html><title>入れ子</title>
<script>
  addEventListener('message', (e) => {
    if (e.origin === location.origin) opener.postMessage('nested ' + e.data, location.origin);
  });
  window.open('/popup', 'inner', 'width=300,height=300');
</script>`;

// 続けて 7 つのポップアップを開く（開いたものは、開いたまま）
const BURST = `<!doctype html><title>まとめて開く</title>
<script>window.burst = () => { for (let i = 0; i < 7; i++) window.open('/hold?' + i, 'hold' + i, 'width=200,height=200'); return 'opened'; };</script>`;

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
  let outsideServer: Server;
  let origin: string;
  let outside: string;

  beforeAll(async () => {
    // 許す先の外（[::1]。許す先の既定 localhost・127.0.0.1・*.local に当たらない）
    outsideServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>外のログイン</title>');
    });
    await new Promise<void>((resolve) => outsideServer.listen(0, '::1', resolve));
    outside = `http://[::1]:${(outsideServer.address() as AddressInfo).port}`;
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const path = (req.url ?? '/').split('?')[0];
      res.end(path === '/popup' ? POPUP : path === '/nest' ? NEST : path === '/burst' ? BURST : path === '/hold' ? '<!doctype html><title>開いたまま</title>' : opener(outside));
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
            // 2 つめの発言（BLOCK）の応答
            tool('toolu_outside', 'click', { selector: '#outside-login' }),
            [{ type: 'text', text: BLOCKED }],
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
    await new Promise((resolve) => outsideServer?.close(resolve));
  });

  const popups = () => app.app.evaluate(() => (globalThis as { __popups?: Popup[] }).__popups ?? []);
  const windows = () => app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  // path のページを開いているタブ（webview）で、code を動かす。人の操作と同じく、ユーザーの操作の扱い（userGesture）で
  const runIn = (path: string, code: string) =>
    app.app.evaluate(
      async ({ webContents }, [where, script]) => {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() !== '' && new URL(c.getURL()).pathname === where);
        return guest?.executeJavaScript(script, true);
      },
      [path, code] as const,
    );
  // 開く側のページに届いた報告
  const result = () => runIn('/', 'document.getElementById("result").textContent');

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
    await runIn('/', 'document.getElementById("login").click()');
    await expect.poll(popups, { timeout: 10_000 }).toHaveLength(2);
    await expect.poll(result, { timeout: 15_000 }).toBe(`${REPORT} #2`);
    await expect.poll(popups, { timeout: 10_000 }).toEqual([
      { preview: true, normal: true, inside: true, closed: true },
      { preview: true, normal: true, inside: true, closed: true },
    ]);
  });

  it('空のページ（window.open(\'\')）を開いてから location を移すものも、別ウインドウで開いて opener に届く', async () => {
    await runIn('/', 'document.getElementById("blank-login").click()');
    await expect.poll(popups, { timeout: 10_000 }).toHaveLength(3);
    await expect.poll(result, { timeout: 15_000 }).toBe(`${REPORT} #3`);
    await expect.poll(async () => (await popups())[2], { timeout: 10_000 }).toEqual({ preview: true, normal: true, inside: true, closed: true });
  });

  it('Claude の操作で、許す先の外のポップアップは開かず、止めたことを Claude に伝える', async () => {
    await app.send(BLOCK);
    await app.byText('.chat-list', BLOCKED).waitFor();
    const clicked = app.api.toolResults.find((r) => r.startsWith('Clicked: button#outside-login'));
    expect(clicked).toContain(`Blocked an attempt to navigate to (or open) a page not allowed for Claude (${outside}).`);
    expect(clicked).not.toContain('Opened a popup window');
    expect(await popups()).toHaveLength(3);
  });

  it('ポップアップがさらに開くポップアップも、同じ守りの別ウインドウで開き、それを開いたポップアップに届く', async () => {
    await runIn('/', 'document.getElementById("nested").click()');
    await expect.poll(result, { timeout: 15_000 }).toBe(`nested ${REPORT} #4`);
    // 入れ子を開いた別ウインドウは開いたまま、中の別ウインドウは自分で閉じる
    await expect.poll(async () => (await popups()).slice(3), { timeout: 10_000 }).toEqual([
      { preview: true, normal: true, inside: true, closed: false },
      { preview: true, normal: true, inside: true, closed: true },
    ]);
  });

  it('1 つのタブから開いておける別ウインドウは 5 個まで（続けて 7 つ開いても）', async () => {
    // 新しいタブで、続けて開くページを開く
    await app.page.click('.preview-pane .preview-tab-new');
    await app.page.fill('.preview-pane .preview-address input', `${origin}/burst`);
    await app.page.press('.preview-pane .preview-address input', 'Enter');
    await app.byText('.preview-pane .preview-tab', 'まとめて開く').waitFor();
    // ページが読み込み終わってから押す（burst を作り終えてから）
    await expect.poll(() => runIn('/burst', 'typeof window.burst'), { timeout: 10_000 }).toBe('function');
    expect(await runIn('/burst', 'burst()')).toBe('opened');
    // 別ウインドウは、window.open のたびに、続きのスクリプトより先に作られる（Electron 44.7 で実測）。押し終えた時点で数が決まっている
    expect((await popups()).slice(5).map((p) => p.closed)).toEqual([false, false, false, false, false]);
  });

  it('タブを閉じると、そのタブから開いた別ウインドウが閉じる。ほかのタブから開いたものは残る', async () => {
    await app.page.click('.preview-pane .preview-tab.active [aria-label="タブを閉じる"]');
    await expect.poll(async () => (await popups()).slice(5).map((p) => p.closed), { timeout: 10_000 }).toEqual([true, true, true, true, true]);
    // 開く側のタブから開いた入れ子の別ウインドウは、開いたまま
    expect((await popups())[3]?.closed).toBe(false);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
