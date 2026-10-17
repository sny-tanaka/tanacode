import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { BACKGROUND, E2EApp } from './app';

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
// - 空のページの別ウインドウの題には、about:blank と、中身を書いた開いたページのオリジンが付く（ページが書いた題だけ・アプリ名にならない）。
//   読み込みが確定しない（204 の）先を開いたものも、開く先のオリジンではなく、中身を書いた開いたページのオリジンが付く
// - 空のページを、開いたページが移すときも守りが効く: 人の操作でも data:・blob: へは移れない。Claude の操作では、許す先の外へ移れない（止めたことを Claude に伝える）
// - ページが window.focus() を呼んでも、別ウインドウにフォーカスは移らない。裏で起動しているとき（手元の Mac）は、画面にも出ない
// - 別ウインドウの中身の設定（getLastWebPreferences）が守りの値（sandbox・contextIsolation が有効で、Node・webview・preload が無い。ダイアログを出さない）
// - 別ウインドウのページの alert()・confirm() は出さず、すぐに返す（prompt() は Electron がもともと出さない）

const OPEN = 'ログインのポップアップを確かめてください';
const DONE = 'ポップアップを確かめました';
const BLOCK = '外のログインを押してください';
const BLOCKED = '外のログインは開きませんでした';
const BLANK_OUT = '空のページから外へ移すログインを押してください';
const BLANK_BLOCKED = '空のページから外へは移りませんでした';
// ポップアップが opener に送る報告（Node・アプリの API が無く、file: にも blob: にも移らなかった）
const REPORT = 'popup node:undefined/undefined,app:undefined,stayed';
// 作られた別ウインドウ。preview: プレビューのセッション / secure: 中身の設定が守りの値 / normal: ふつうのウインドウ（閉じられる・
// フォーカスできる・不透明・動かせる・最小化できる・最前面でない・影がある・ほかのデスクトップに出ない）/ inside: tanacode のウインドウが
// ある画面の中 / closed: 閉じた
type Popup = { preview: boolean; secure: boolean; normal: boolean; inside: boolean; closed: boolean };
// 作られた別ウインドウ（テストが中を見る分だけ）と、その中身のトップのフレームが移り始めた先（did-start-navigation）
type PopupWindow = {
  win: {
    isDestroyed(): boolean;
    isVisible(): boolean;
    isFocused(): boolean;
    getTitle(): string;
    webContents: { getURL(): string; isLoading(): boolean; executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> };
  };
  starts: string[];
  console: string[];
};
// 守りの効いた別ウインドウ（閉じたかのほか）
const GUARDED = { preview: true, secure: true, normal: true, inside: true };
const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name: browserToolId(name), input }];

// outside: 許す先の外のオリジン
const opener = (outside: string) => `<!doctype html><title>開く側</title><h1>ログインの前</h1>
<button id="login" onclick="window.open('/popup', 'login', 'width=480,height=640,left=-10000,top=-10000,nodeIntegration=yes,sandbox=no,contextIsolation=no,webviewTag=yes,closable=no,focusable=no,opacity=0,movable=no,minimizable=no,alwaysOnTop=yes,hasShadow=no,visibleOnAllWorkspaces=yes,type=panel')">ログイン</button>
<button id="blank-login" onclick="const w = window.open('', 'msal', 'width=480,height=640'); w.location.assign('/popup')">空のページから</button>
<button id="outside-login" onclick="window.open('${outside}/', 'outside', 'width=480,height=640')">外のログイン</button>
<button id="nested" onclick="window.open('/nest', 'nest', 'width=400,height=400')">入れ子</button>
<button id="blank-title" onclick="const w = window.open('', 'blank-title', 'width=480,height=400'); w.document.write('<title>tanacode の再ログイン</title><p>空のページに書いた画面</p>'); w.document.close();">空のページに題を書く</button>
<button id="blank-plain" onclick="window.plain = window.open('', 'blank-plain', 'width=480,height=400')">空のページだけ</button>
<button id="blank-outside" onclick="window.msal2 = window.open('', 'msal2', 'width=480,height=640'); window.msal2.location.assign('${outside}/')">空のページから外へ</button>
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
  // 許す先の外のサーバーに来た通信の数（どれも止めるので 0 のまま）
  let outsideRequests = 0;

  beforeAll(async () => {
    // 許す先の外（[::1]。許す先の既定 localhost・127.0.0.1・*.local に当たらない）
    outsideServer = createServer((req, res) => {
      // 中身の無い応答（204）。読み込みが確定せず、別ウインドウの中身は、開いたページが書ける空の文書のまま
      if (req.url === '/no-content') {
        res.writeHead(204);
        res.end();
        return;
      }
      outsideRequests += 1;
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
            // 3 つめの発言（BLANK_OUT）の応答
            tool('toolu_blank_outside', 'click', { selector: '#blank-outside' }),
            [{ type: 'text', text: BLANK_BLOCKED }],
          ],
        },
      ],
    });
    // 作られたウインドウ（アプリのウインドウのあとのもの）と、そのセッションがプレビューのものか・tanacode のウインドウがある画面の中かを控える
    await app.app.evaluate(({ app: electronApp, BrowserWindow, screen, session }) => {
      const created: Popup[] = [];
      const windows: { win: unknown; starts: string[]; console: string[] }[] = [];
      (globalThis as { __popups?: typeof created }).__popups = created;
      (globalThis as { __popupWindows?: typeof windows }).__popupWindows = windows;
      electronApp.on('browser-window-created', (_event, win) => {
        const normal =
          win.isClosable() && win.isFocusable() && win.getOpacity() === 1 && win.isMovable() && win.isMinimizable() && !win.isAlwaysOnTop() && win.hasShadow() && !win.isVisibleOnAllWorkspaces();
        // 中身の設定（Electron が中身を作るときに使ったもの。d.ts には無い）
        const prefs = (win.webContents as unknown as { getLastWebPreferences?: () => Record<string, unknown> | null }).getLastWebPreferences?.();
        const secure =
          !!prefs &&
          prefs.sandbox === true &&
          prefs.contextIsolation === true &&
          !prefs.nodeIntegration &&
          !prefs.nodeIntegrationInSubFrames &&
          !prefs.nodeIntegrationInWorker &&
          !prefs.webviewTag &&
          !prefs.preload &&
          prefs.disableDialogs === true;
        const entry = { preview: win.webContents.session === session.fromPartition('persist:tanacode-preview'), secure, normal, inside: false, closed: false };
        created.push(entry);
        // 中身のトップのフレームが移り始めた先と、コンソールの文
        const starts: string[] = [];
        const console: string[] = [];
        windows.push({ win, starts, console });
        win.webContents.on('did-start-navigation', (details) => {
          if (details.isMainFrame) starts.push(details.url);
        });
        win.webContents.on('console-message', (details) => console.push(details.message));
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
  // index 番めに作られた別ウインドウの、今の URL・読み込み中か・トップのフレームが移り始めた先・コンソールの文・出ているか・フォーカスがあるか
  // （閉じていれば null）
  const popupState = (index: number) =>
    app.app.evaluate((_electron, i) => {
      const entry = (globalThis as { __popupWindows?: PopupWindow[] }).__popupWindows?.[i];
      if (!entry || entry.win.isDestroyed()) return null;
      const { win, starts, console } = entry;
      return { url: win.webContents.getURL(), loading: win.webContents.isLoading(), starts: [...starts], console: [...console], visible: win.isVisible(), focused: win.isFocused(), title: win.getTitle() };
    }, index);
  // index 番めに作られた別ウインドウの中で、code を動かす
  const runInPopup = (index: number, code: string) =>
    app.app.evaluate(
      (_electron, [i, script]) => (globalThis as { __popupWindows?: PopupWindow[] }).__popupWindows?.[i]?.win.webContents.executeJavaScript(script, true),
      [index, code] as const,
    );

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
    await expect.poll(popups, { timeout: 10_000 }).toEqual([{ ...GUARDED, closed: true }]);
    expect(await windows()).toBe(1);
  });

  it('人の操作（Claude の操作の外）で開いたポップアップも、別ウインドウで開いて opener に届く', async () => {
    // 人がボタンを押したのと同じく、ユーザーの操作の扱い（userGesture）でページのボタンを押す
    await runIn('/', 'document.getElementById("login").click()');
    await expect.poll(popups, { timeout: 10_000 }).toHaveLength(2);
    await expect.poll(result, { timeout: 15_000 }).toBe(`${REPORT} #2`);
    await expect.poll(popups, { timeout: 10_000 }).toEqual([
      { ...GUARDED, closed: true },
      { ...GUARDED, closed: true },
    ]);
  });

  it('空のページ（window.open(\'\')）を開いてから location を移すものも、別ウインドウで開いて opener に届く', async () => {
    await runIn('/', 'document.getElementById("blank-login").click()');
    await expect.poll(popups, { timeout: 10_000 }).toHaveLength(3);
    await expect.poll(result, { timeout: 15_000 }).toBe(`${REPORT} #3`);
    await expect.poll(async () => (await popups())[2], { timeout: 10_000 }).toEqual({ ...GUARDED, closed: true });
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
      { ...GUARDED, closed: false },
      { ...GUARDED, closed: true },
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

  it('空のページの別ウインドウの題には、about:blank と開いたページのオリジンが付く（ページが題を書いたとき・書かないとき）', async () => {
    await runIn('/', 'document.getElementById("blank-title").click()');
    await runIn('/', 'document.getElementById("blank-plain").click()');
    const titles = () => app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    await expect.poll(titles, { timeout: 10_000 }).toEqual(expect.arrayContaining([`about:blank (${origin}) — tanacode の再ログイン`, `about:blank (${origin})`]));
  });

  it('人の操作でも、開いたページは空のページの別ウインドウを data: や blob: のページへ移せない（空のページのまま）', async () => {
    await runIn('/', `window.toData = window.open('', 'to-data', 'width=480,height=400'); window.toData.location.assign('data:text/html,<title>data</title>'); 'ok'`);
    await runIn('/', `window.toBlob = window.open('', 'to-blob', 'width=480,height=400'); window.toBlob.location.assign(URL.createObjectURL(new Blob(['<title>blob</title>'], { type: 'text/html' }))); 'ok'`);
    await expect.poll(popups, { timeout: 10_000 }).toHaveLength(14);
    // 止まったことが分かってから見る。data: は、Chromium が移り始める前に止める（コンソールに出す。Electron 44.7 で確かめた）。
    // blob: は、移り始めた（did-start-navigation）のを、アプリの見張りが止める（移れたなら、そのページを読み込み終えるまで読み込み中）
    type Seen = { starts: string[]; console: string[] };
    const tried = {
      data: (state: Seen) => state.console.some((text) => text.startsWith('Not allowed to navigate top frame to data URL')),
      blob: (state: Seen) => state.starts.some((url) => url.startsWith('blob:')),
    };
    for (const [index, kind] of [
      [12, 'data'],
      [13, 'blob'],
    ] as const) {
      await expect
        .poll(
          async () => {
            const state = await popupState(index);
            return state && { tried: tried[kind](state), loading: state.loading, starts: state.starts };
          },
          { timeout: 10_000 },
        )
        .toMatchObject({ tried: true, loading: false });
      expect((await popupState(index))?.url).toBe('about:blank');
    }
    // 開いたページから見ても、空のページのまま（移れていれば、別のオリジンになって読めない）
    expect(await runIn('/', 'window.toData.location.href + " " + window.toBlob.location.href')).toBe('about:blank about:blank');
    // 開いておける数（1 つのタブから 5 個まで）に当たらないよう閉じる
    await runIn('/', 'window.toData.close(); window.toBlob.close(); "closed"');
    await expect.poll(async () => (await popups()).slice(12).map((p) => p.closed), { timeout: 10_000 }).toEqual([true, true]);
  });

  it('ページが window.focus() を呼んでも、別ウインドウにフォーカスは移らない。裏で起動しているときは、画面にも出ない', async () => {
    // 空のページだけの別ウインドウ（11 番め。開いたまま）を、開いたページ（w.focus()）と、別ウインドウの中（window.focus()）から前に出そうとする
    expect(await runIn('/', 'window.plain.focus(); "focused"')).toBe('focused');
    expect(await runInPopup(11, 'window.focus(); "focused"')).toBe('focused');
    // 両方のページともう一度行き来してから見る
    expect(await runIn('/', 'document.title')).toBe('開く側');
    expect(await runInPopup(11, 'location.href')).toBe('about:blank');
    // 開いたままのほかの別ウインドウ（入れ子・題を書いた空のページ）も。フォーカスは、どの起動の仕方でも移らない。
    // 画面に出ないことは、アプリを裏で起動したとき（BACKGROUND。手元の Mac）だけ確かめる。前に出して流すとき（CI）は、tanacode に
    // フォーカスがあれば、別ウインドウはフォーカスを移さずに画面に出る（決めた動き）
    for (const index of [3, 10, 11]) {
      const state = await popupState(index);
      expect(state?.focused, `${index} 番めの別ウインドウ`).toBe(false);
      if (BACKGROUND) expect(state?.visible, `${index} 番めの別ウインドウ`).toBe(false);
    }
  });

  it('別ウインドウのページの alert()・confirm() は出さず、すぐに返す（出すのを待っている間・裏での起動でも、ほかのアプリの前に出さない）', async () => {
    // 守りの値で切っていることを先に確かめる（切っていないまま呼ぶと、ダイアログが前に出て止まるため）
    expect((await popups())[11]?.secure).toBe(true);
    expect(await runInPopup(11, 'String(alert("a")) + "/" + String(confirm("b"))')).toBe('undefined/false');
    // prompt() は、Electron がもともと出さない（投げる）
    expect(await runInPopup(11, '(() => { try { return String(prompt("c")); } catch (e) { return e.message; } })()')).toBe('prompt() is not supported.');
  });

  it('読み込みが確定しない（204 の）許す先の外を開いた別ウインドウに、開いたページが題を書いても、その外のオリジンを題に出さない', async () => {
    await runIn(
      '/',
      `window.noContent = window.open('${outside}/no-content', 'no-content', 'width=480,height=400'); window.noContent.document.body.innerHTML = '<p>書いた画面</p>'; window.noContent.document.title = 'ログイン'; 'ok'`,
    );
    await expect.poll(popups, { timeout: 10_000 }).toHaveLength(15);
    // 204 の読み込みが終わって（確定せずに）から見る
    await expect
      .poll(
        async () => {
          const state = await popupState(14);
          return state && { tried: state.starts.includes(`${outside}/no-content`), loading: state.loading, url: state.url };
        },
        { timeout: 10_000 },
      )
      .toEqual({ tried: true, loading: false, url: '' });
    // 中身は、開いたページが書いたもののまま
    expect(await runIn('/', 'window.noContent.document.body.textContent')).toBe('書いた画面');
    const title = (await popupState(14))?.title;
    expect(title).toBe(`about:blank (${origin}) — ログイン`);
    expect(title).not.toContain(outside);
    // 開いておける数（1 つのタブから 5 個まで）に当たらないよう閉じる
    await runIn('/', 'window.noContent.close(); "closed"');
    await expect.poll(async () => (await popups())[14]?.closed, { timeout: 10_000 }).toBe(true);
  });

  it('空のページを開いてから許す先の外へ移すポップアップを Claude が押すと、別ウインドウは開くが、移るのを止めて Claude に伝える（空のページのまま）', async () => {
    await app.send(BLANK_OUT);
    await app.byText('.chat-list', BLANK_BLOCKED).waitFor();
    const clicked = app.api.toolResults.find((r) => r.startsWith('Clicked: button#blank-outside'));
    expect(clicked).toContain('Opened a popup window outside the in-app browser (about:blank).');
    expect(clicked).toContain(`Blocked an attempt to move a popup window opened by the page to a page not allowed for Claude (${outside}).`);
    expect(await popups()).toHaveLength(16);
    // ページは移ろうとしたが、止めたので、空のページのまま（Electron から見ても、開いたページから見ても）。許す先の外には通信していない
    await expect.poll(async () => (await popupState(15))?.loading, { timeout: 10_000 }).toBe(false);
    expect((await popupState(15))?.starts).toContain(`${outside}/`);
    expect((await popupState(15))?.url).toBe('about:blank');
    expect(await runIn('/', 'window.msal2.location.href')).toBe('about:blank');
    expect(outsideRequests).toBe(0);
    await runIn('/', 'window.msal2.close(); "closed"');
    await expect.poll(async () => (await popups())[15], { timeout: 10_000 }).toEqual({ ...GUARDED, closed: true });
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
