import { nativeImage, webContents as allWebContents, type NativeImage, type Session, type WebContents } from 'electron';
import { BROWSER_MCP, browserTool, isClaudeAllowedUrl, isLocalUrl } from '@shared/browser-tools';
import type { BrowserActivity, BrowserAsk, BrowserAskChange, BrowserRect, IpcChannel, IpcEvent } from '@shared/ipc';
import { mcpToolLabel } from '@shared/mcp-tools';
import { BrowserAsks } from './browser-asks';
import { BROWSER_GATE_REQUEST } from './browser-bridge';
import { textResult, type ToolResult } from './mcp-bridge';

// Claude Code から（中継とソケット経由で）届いた、アプリ内ブラウザの操作を実行する。
// 操作するのは、そのセッションの今のタブの webview の中身（webContents）。メインプロセスが直接動かす（capturePage・CDP）。
// ページが新しいウィンドウで開くもの（target=_blank・window.open）は、同じセッションの新しいタブで開かせる（openFromPage）。
// クリックや入力は CDP（Input.*）で送る。ウィンドウが前に無くても届き、ページには本物の操作（isTrusted）として届く。
// 隠れているセッションの webview も、画面（renderer）が透明にして描かせたままにするので、撮れるし操作できる。
// ユーザーに操作を頼む（ask_user_to_act）間は、Claude の操作として扱わない（ログインで外の認証のページへ移って戻ってこられるように）。
// その間は、Claude にブラウザを使わせない（ユーザーの操作とぶつからないように）

// 要素を探したり読んだりするスクリプトを動かす、ページとは別の JavaScript の世界（ページのスクリプトに書き換えられない）
const WORLD = 1100;
const MAX_TEXT = 20_000;
const MAX_CONSOLE = 200;
const MAX_FAILED = 100;
const MAX_TREE_LINES = 1500;
// スクリーンショットの長い辺の上限（Claude が画像を読むときに縮める大きさ）
const MAX_IMAGE_SIDE = 1568;
// fullPage で撮る高さの上限（幅に対する倍率）。Claude は長い辺を縮めて読むので、細長すぎると字が読めなくなる
const MAX_FULL_PAGE_RATIO = 2.5;
// 1 回の操作の上限。中継の待ち（90 秒）より短くする
const TOOL_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT_MS = 30_000;
// 画面（renderer）が webview を作って知らせるまで待つ時間
const ATTACH_TIMEOUT_MS = 10_000;
// 今のタブの webview がまだ知らされていないとき（作った直後）に待つ時間
const ACTIVE_WAIT_MS = 3_000;
// クリックする要素に枠を出してから押すまでの間（ユーザーが目で追えるように）
const HIGHLIGHT_MS = 400;
// 最後の操作のあと、「Claude が操作中」の帯を出しておく時間
const ACTIVE_LINGER_MS = 8_000;
// 操作が終わったあとも、Claude の操作として扱う間（押したボタンの処理が少し遅れてページを移すことがあるため）
const OPERATING_GRACE_MS = 2_000;
// 1 つのセッションで開けるタブの数（ページが window.open を繰り返しても、タブで埋まらないように）
const MAX_TABS = 20;
const VIEWPORTS: Record<string, number> = { full: 0, mobile: 390, tablet: 768 };
const DEFAULT_STYLES = [
  'display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
  'color', 'background-color', 'background-image', 'opacity', 'font-family', 'font-size', 'font-weight', 'line-height',
  'text-align', 'overflow', 'z-index', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'visibility',
];

// ページの中で動かすスクリプトの前に置く部品。いちばん外のページと、同じオリジンの iframe の中（5 段まで）を、同じように探す。
// 位置は、いちばん外の見えている範囲の左上から（CDP の Input に、そのまま渡せる）。別オリジンの iframe の中は、スクリプトからは見えない
const FRAMES = `
const __view = (el) => el.ownerDocument.defaultView;
const __style = (el) => __view(el).getComputedStyle(el);
const __inner = (f) => { const r = f.getBoundingClientRect(); const cs = __style(f); return { x: r.left + f.clientLeft + parseFloat(cs.paddingLeft || '0'), y: r.top + f.clientTop + parseFloat(cs.paddingTop || '0') }; };
const __docs = () => {
  const out = [];
  const walk = (doc, ox, oy, frame, depth) => {
    out.push({ doc, ox, oy, frame });
    if (depth >= 5) return;
    for (const f of doc.querySelectorAll('iframe, frame')) {
      let d = null;
      try { d = f.contentDocument; } catch (e) {}
      if (!d || !d.documentElement) continue;
      const p = __inner(f);
      walk(d, ox + p.x, oy + p.y, f, depth + 1);
    }
  };
  walk(document, 0, 0, null, 0);
  return out;
};
const __frameOf = (d) => (d.frame ? d.doc.location.href : null);
const __all = (sel) => { const out = []; for (const d of __docs()) for (const el of d.doc.querySelectorAll(sel)) out.push({ el, ...d }); return out; };
const __offset = (doc) => __docs().find((d) => d.doc === doc) || { ox: 0, oy: 0 };
const __rect = (el) => { const r = el.getBoundingClientRect(); const o = __offset(el.ownerDocument); return { x: r.left + o.ox, y: r.top + o.oy, width: r.width, height: r.height }; };
const __shown = (el) => { const r = el.getBoundingClientRect(); const cs = __style(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
const __hit = (x, y) => {
  let el = document.elementFromPoint(x, y), ox = 0, oy = 0;
  while (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
    let d = null;
    try { d = el.contentDocument; } catch (e) {}
    if (!d) return { el, cross: true, src: el.src };
    const p = __inner(el);
    ox += p.x; oy += p.y;
    el = d.elementFromPoint(x - ox, y - oy);
  }
  return { el, cross: false };
};
const __name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
const __label = (el) => {
  // パスワードの欄は、入っている値を使わない（ユーザーが入れた値を Claude に渡さない）
  const v = el.type === 'password' ? '' : el.value;
  const t = (el.innerText || v || (el.getAttribute && el.getAttribute('aria-label')) || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const f = el.ownerDocument === document ? null : el.ownerDocument.location.href;
  return __name(el) + (t ? '「' + t + '」' : '') + (f ? '（iframe ' + f + ' の中）' : '');
};
`;

// CDP の Accessibility.getFullAXTree の 1 つ
type AXValue = { value?: unknown };
type AXNode = {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
};

type LogEntry = { level: string; text: string };
// webview ごとのコンソールと失敗した通信（今のページを開いてから）。画面がタブを知らせてくる前（ページの最初のスクリプト）から集める
type Logs = { console: LogEntry[]; failed: string[] };
// タブ 1 つ（webview 1 つ）
type Guest = {
  tabId: string;
  contents: WebContents;
  logs: Logs;
  // CDP（debugger）をつないだか
  cdp: boolean;
  // 別プロセスで動く iframe（別サイトのもの）の CDP のセッション（Target.setAutoAttach でつなぐ）。
  // 見ていないタブ（透明にして描かせているもの）では、ページに送った操作がこの iframe に届かないので、iframe のセッションに直に送る
  children: Set<string>;
};
// セッションのタブ
type Tabs = {
  tabs: Map<string, Guest>;
  // 今のタブ（画面が知らせてくる。Claude の操作はこのタブに対して行う）
  active: string | null;
  // Claude の操作の間に、許していない先へ移ろう（開こう）として止めたもの・新しいタブで開いたもの（呼び出しごとに空にする）
  blocked: string | null;
  opened: string[];
};

type Deps = {
  // 画面（renderer）へ送る。チャンネルごとの中身は shared/ipc.ts の IpcEvent
  send: <C extends keyof IpcEvent>(channel: C, payload: IpcEvent[C]) => void;
  // メニューで、Claude にアプリ内ブラウザを操作させるのがオンか
  enabled: () => boolean;
  // ユーザーが足した、Claude に許す先
  extraHosts: () => string[];
  // アプリの画面（webview を持っている webContents）
  host: () => WebContents | null;
  // あるセッションか（アーカイブしたものも含む）
  hasSession: (id: string) => boolean;
  // ユーザーに操作を頼んだ・終わった（ask が null）。一覧の印と通知に使う（画面の帯は channels.ask で送る）
  onAsk: (sessionId: string, ask: BrowserAsk | null) => void;
  channels: {
    open: typeof IpcChannel.BrowserOpen;
    activity: typeof IpcChannel.BrowserActivity;
    viewport: typeof IpcChannel.BrowserViewport;
    newTab: typeof IpcChannel.BrowserNewTab;
    selectTab: typeof IpcChannel.BrowserSelectTab;
    closeTab: typeof IpcChannel.BrowserCloseTab;
    ask: typeof IpcChannel.BrowserAsk;
  };
};

class ToolError extends Error {}

export class BrowserControl {
  private readonly sessions = new Map<string, Tabs>();
  // webContents の ID → コンソールと失敗した通信
  private readonly logs = new Map<number, Logs>();
  private readonly waiters = new Map<string, ((guest: Guest) => void)[]>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  // 動いている呼び出しの数（セッションごと）。0 になって少したったら、帯を消す
  private readonly running = new Map<string, number>();
  // 最後の呼び出しが終わった時刻（セッションごと）
  private readonly endedAt = new Map<string, number>();
  // ユーザーに頼んでいる操作
  private readonly asks: BrowserAsks;

  constructor(private readonly deps: Deps) {
    this.asks = new BrowserAsks((sessionId, ask) => {
      this.deps.send(this.deps.channels.ask, { sessionId, ask } satisfies BrowserAskChange);
      this.deps.onAsk(sessionId, ask);
    });
  }

  // 失敗した通信（4xx・5xx・つながらなかったもの）を集める。プレビューの webview が使うセッションに 1 回だけ付ける
  watchNetwork(session: Session): void {
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    const record = (contentsId: number | undefined, text: string) => {
      const logs = contentsId === undefined ? undefined : this.logs.get(contentsId);
      if (!logs) return;
      logs.failed.push(text);
      if (logs.failed.length > MAX_FAILED) logs.failed.splice(0, logs.failed.length - MAX_FAILED);
    };
    session.webRequest.onCompleted(filter, (details) => {
      if (details.statusCode >= 400) record(details.webContentsId, `${details.statusCode} ${details.method} ${details.url}（${details.resourceType}）`);
    });
    session.webRequest.onErrorOccurred(filter, (details) => {
      // 移ったための中断（ERR_ABORTED）は失敗にしない
      if (details.error !== 'net::ERR_ABORTED') record(details.webContentsId, `${details.error} ${details.method} ${details.url}（${details.resourceType}）`);
    });
  }

  // プレビューの webview ができたとき（did-attach-webview）。コンソールと失敗した通信を、この時から集める
  track(contents: WebContents): Logs {
    const existing = this.logs.get(contents.id);
    if (existing) return existing;
    const logs: Logs = { console: [], failed: [] };
    const id = contents.id;
    this.logs.set(id, logs);
    contents.on('console-message', (event) => {
      const { level, message, sourceId, lineNumber } = event;
      const where = sourceId ? ` (${sourceId}${lineNumber ? `:${lineNumber}` : ''})` : '';
      logs.console.push({ level, text: `${message}${where}` });
      if (logs.console.length > MAX_CONSOLE) logs.console.splice(0, logs.console.length - MAX_CONSOLE);
    });
    // 新しいページを開いたら、コンソールと失敗した通信を空にする（「今のページを開いてから」のもの）
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) {
        logs.console.length = 0;
        logs.failed.length = 0;
      }
    });
    contents.once('destroyed', () => this.logs.delete(id));
    return logs;
  }

  // 画面（renderer）が、セッションのタブの webview を作って知らせてきた。アプリの画面の中の webview だけを受け付ける
  attach(sessionId: string, tabId: string, contentsId: number): void {
    const contents = allWebContents.fromId(contentsId);
    const host = this.deps.host();
    if (!contents || !host || contents.getType() !== 'webview' || contents.hostWebContents !== host) return;
    const session = this.tabsOf(sessionId);
    if (session.tabs.get(tabId)?.contents === contents) return;
    const guest: Guest = { tabId, contents, logs: this.track(contents), cdp: false, children: new Set() };
    session.tabs.set(tabId, guest);
    // 並びは、画面がタブを作った順（タブの ID の番号）
    session.tabs = new Map([...session.tabs].sort(([a], [b]) => tabNumber(a) - tabNumber(b)));
    contents.debugger.on('detach', () => {
      guest.cdp = false;
      guest.children.clear();
    });
    contents.debugger.on('message', (_event, method, params: { sessionId?: string; targetInfo?: { type?: string } }) => {
      if (method === 'Target.attachedToTarget' && params.sessionId && params.targetInfo?.type === 'iframe') guest.children.add(params.sessionId);
      if (method === 'Target.detachedFromTarget' && params.sessionId) guest.children.delete(params.sessionId);
    });
    contents.once('destroyed', () => {
      const current = this.sessions.get(sessionId);
      if (current?.tabs.get(tabId) === guest) current.tabs.delete(tabId);
    });
    for (const resolve of this.waiters.get(sessionId) ?? []) resolve(guest);
    this.waiters.delete(sessionId);
  }

  // 画面で今のタブが変わった（タブが無くなったら null）
  activate(sessionId: string, tabId: string | null): void {
    this.tabsOf(sessionId).active = tabId;
  }

  // Claude が操作している最中（と、終わってすぐ）の webview か。この間は、許していない先へ移らせず、開かせない
  isOperating(contents: WebContents): boolean {
    const found = this.find(contents);
    return !!found && this.operating(found.sessionId);
  }

  // webview のトップのフレームが url へ移ろうとしている（リンク・リダイレクト・ページのスクリプト）。
  // Claude の操作で、許していない先へ移ろうとしていれば止める（true を返す）。ユーザーの操作は止めない
  blocksNavigation(contents: WebContents, url: string): boolean {
    const found = this.find(contents);
    if (!found || !this.operating(found.sessionId) || this.allowed(url)) return false;
    found.session.blocked = url;
    return true;
  }

  // ページが新しいウィンドウで開こうとした（target=_blank・window.open）。同じセッションの新しいタブで開かせる。
  // Claude の操作で、許していない先を開こうとしたものは開かない。知らない webview なら false（呼び出し元が扱う）
  openFromPage(contents: WebContents, url: string, disposition: string): boolean {
    const found = this.find(contents);
    if (!found) return false;
    const { sessionId, session } = found;
    if (session.tabs.size >= MAX_TABS) return true;
    const operating = this.operating(sessionId);
    if (operating && !this.allowed(url)) {
      session.blocked = url;
      return true;
    }
    if (operating) session.opened.push(url);
    // ⌘ を押したままのクリックは、裏で開く（Claude の操作は、続けて操作できるよう前に出す）
    this.deps.send(this.deps.channels.newTab, { sessionId, url, background: !operating && disposition === 'background-tab', openerTabId: found.guest.tabId });
    return true;
  }

  // ユーザーに操作を頼んでいるか・頼んでいるもの（画面を作り直したとき用）
  isAsking(sessionId: string): boolean {
    return this.asks.has(sessionId);
  }

  pendingAsks(): BrowserAskChange[] {
    return this.asks.list();
  }

  // ユーザーが帯のボタンを押した
  answerAsk(sessionId: string, askId: unknown, answer: unknown): void {
    this.asks.answer(sessionId, askId, answer);
  }

  // メニューで Claude の操作をオフにした。頼んでいるものはやめる（帯が残って、押すとページを返すことのないように）
  cancelAsks(): void {
    this.asks.cancelAll('アプリ内ブラウザの操作がオフになったので、頼むのをやめました');
  }

  // セッションを消した・アーカイブしたとき
  forget(sessionId: string): void {
    this.asks.cancel(sessionId);
    this.sessions.delete(sessionId);
    this.running.delete(sessionId);
    this.endedAt.delete(sessionId);
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
  }

  // 中継から届いた呼び出し。signal: Claude Code が呼び出しを取り消した（中継がソケットを閉じた）
  async handle(sessionId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (name === BROWSER_GATE_REQUEST) return this.gate(sessionId);
    const tool = browserTool(name);
    if (!tool) return textResult(`知らないツールです: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult('アプリ内ブラウザの操作は、tanacode のメニュー（tanacode → Claude にアプリ内ブラウザを操作させる）でオフになっています', true);
    }
    if (!this.deps.hasSession(sessionId)) return textResult('このセッションは tanacode にありません', true);
    if (tool.kind === 'ask') {
      this.yieldToUser(sessionId);
      return this.asks.wait(sessionId, args.message, () => this.askedPage(sessionId), signal);
    }
    if (this.asks.has(sessionId)) {
      return textResult(
        'ユーザーに操作を頼んでいるところです。ユーザーが帯の「終わった」か「できない」を押すまで、ブラウザは使えません。操作せずに返事を待ってください（ユーザーがチャットで済んだと言ってきたら、帯の「終わった」を押してもらってください）',
        true,
      );
    }
    this.begin(sessionId, mcpToolLabel(BROWSER_MCP, tool));
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError(`${TOOL_TIMEOUT_MS / 1000} 秒たっても終わりませんでした`)), TOOL_TIMEOUT_MS);
      });
      return await Promise.race([this.run(sessionId, name, args), timeout]);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      clearTimeout(timer);
      this.end(sessionId);
    }
  }

  // ユーザーの返事に添える、今のページ。許していない先のページ（外の認証のページなど）は、タイトルも URL の道筋も読ませない
  // （ページが書ける・認証の途中の値が URL に入っていることがある）
  private askedPage(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    const guest = session?.active ? session.tabs.get(session.active) : undefined;
    const url = guest && !guest.contents.isDestroyed() ? guest.contents.getURL() : '';
    if (!guest || isBlank(url)) return ['今のタブ: （ページを開いていません）'];
    if (!this.allowed(url)) return [`今のページは Claude に許していない先（${originOf(url) ?? '読めない URL'}）です。これ以上は読めず、操作もできません`];
    return [`今のページ: ${guest.contents.getTitle() || '（タイトルなし）'}`, `URL: ${url}`];
  }

  // JavaScript の実行の確認のフック（browser-gate.ts）への答え。今のタブが localhost のページなら、確認を省いてよい。
  // タブが無い・空のときは、確認を出させる側に倒す（待たない。フックは短い間しか待たない）
  private gate(sessionId: string): ToolResult {
    const session = this.sessions.get(sessionId);
    const guest = session?.active ? session.tabs.get(session.active) : undefined;
    const url = guest && !guest.contents.isDestroyed() ? guest.contents.getURL() : '';
    return textResult(JSON.stringify({ local: isLocalUrl(url), url }));
  }

  private async run(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.tabsOf(sessionId);
    session.blocked = null;
    session.opened = [];
    const result = await this.dispatch(sessionId, name, args);
    if (result.isError) return result;
    // 操作の途中で、許していない先へ移ろうとして止めたら、そう伝える
    if (session.blocked) result.content.push({ type: 'text', text: `許していない先（${this.shownUrl(session.blocked)}）へ移ろう（開こう）としたので、止めました` });
    // 新しいタブで開いたら、そのタブができるのを待って伝える（画面がそのタブを今のタブにする）
    if (session.opened.length > 0) {
      const guest = await this.activeGuest(sessionId).catch(() => null);
      if (guest) await waitForLoad(guest.contents);
      const index = guest ? [...session.tabs.keys()].indexOf(guest.tabId) + 1 : 0;
      result.content.push({
        type: 'text',
        text: `新しいタブ${index > 0 ? `（タブ ${index}）` : ''}で開きました: ${session.opened.join('、')}。このあとの操作は、このタブに対して行います（list_tabs・select_tab でタブを切り替えられます）`,
      });
    }
    return result;
  }

  private async dispatch(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === 'navigate') return this.navigate(sessionId, args);
    if (name === 'list_tabs') return this.listTabs(sessionId);
    if (name === 'select_tab') return this.selectTab(sessionId, args.index);
    if (name === 'close_tab') return this.closeTab(sessionId, args.index);
    const guest = await this.current(sessionId);
    switch (name) {
      case 'screenshot':
        return this.screenshot(guest, optionalString(args.selector), args.fullPage === true);
      case 'get_text':
        return this.text(guest, optionalString(args.selector));
      case 'get_accessibility_tree':
        return this.tree(guest);
      case 'inspect':
        return this.inspect(guest, requiredString(args.selector, 'selector'), stringList(args.properties));
      case 'get_console_logs':
        return this.consoleLogs(guest, optionalString(args.level) ?? 'all', args.clear === true);
      case 'get_failed_requests':
        return this.failedRequests(guest, args.clear === true);
      case 'click':
        return this.click(sessionId, guest, args);
      case 'type':
        return this.type(sessionId, guest, args);
      case 'press_key':
        return this.pressKey(guest, requiredString(args.key, 'key'), stringList(args.modifiers) ?? []);
      case 'scroll':
        return this.scroll(guest, optionalString(args.selector), numberOr(args.deltaX, 0), numberOr(args.deltaY, 0));
      case 'wait_for':
        return this.waitFor(guest, args);
      case 'set_viewport':
        return this.setViewport(sessionId, guest, requiredString(args.width, 'width'));
      case 'evaluate':
        return this.evaluate(guest, requiredString(args.expression, 'expression'));
    }
    return textResult(`知らないツールです: ${name}`, true);
  }

  // ---- 開く ----

  private async navigate(sessionId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const action = optionalString(args.action);
    const rawUrl = optionalString(args.url);
    if (!action && !rawUrl) throw new ToolError('url か action を渡してください');
    if (action) {
      const guest = await this.current(sessionId);
      const history = guest.contents.navigationHistory;
      if (action === 'reload') guest.contents.reload();
      else {
        const index = history.getActiveIndex() + (action === 'back' ? -1 : 1);
        if (index < 0 || index >= history.length()) throw new ToolError(action === 'back' ? '戻る先がありません' : '進む先がありません');
        const target = history.getEntryAtIndex(index).url;
        this.checkUrl(target, '移る先');
        if (action === 'back') history.goBack();
        else history.goForward();
      }
      await waitForLoad(guest.contents);
      return this.pageResult(guest, action === 'reload' ? '読み込み直しました' : action === 'back' ? '戻りました' : '進みました');
    }
    const url = toUrl(rawUrl!);
    this.checkUrl(url, '開く先');
    const session = this.tabsOf(sessionId);
    let guest = await this.activeGuest(sessionId).catch(() => null);
    if (!guest || args.newTab === true) {
      // まだブラウザを開いていないセッションか、新しいタブ。画面に webview を作らせ、知らせを待つ
      const attached = this.waitAttach(sessionId);
      if (guest) this.deps.send(this.deps.channels.newTab, { sessionId, url, background: false, openerTabId: guest.tabId });
      else this.deps.send(this.deps.channels.open, { sessionId, url });
      guest = await attached;
      await waitForLoad(guest.contents);
      if (session.blocked) throw new ToolError(`${url} は、許していない先（${this.shownUrl(session.blocked)}）へ移ろうとしたので、止めました`);
    } else {
      const opened = guest;
      await opened.contents.loadURL(url).catch((error: unknown) => {
        // 許していない先へのリダイレクトを止めた
        if (session.blocked) throw new ToolError(`${url} は、許していない先（${this.shownUrl(session.blocked)}）へ移ろうとしたので、止めました`);
        // 移ったための中断（リダイレクトなど）は失敗にしない
        if (!/ERR_ABORTED/.test(String(error))) throw new ToolError(`${url} を開けませんでした（${error instanceof Error ? error.message : String(error)}）`);
      });
    }
    return this.pageResult(guest, args.newTab === true ? `新しいタブ（タブ ${[...session.tabs.keys()].indexOf(guest.tabId) + 1}）で開きました` : '開きました');
  }

  // ---- タブ ----

  private listTabs(sessionId: string): ToolResult {
    const session = this.tabsOf(sessionId);
    const tabs = [...session.tabs.values()].filter((g) => !g.contents.isDestroyed());
    if (tabs.length === 0) return textResult('タブはありません（navigate で開けます）');
    const lines = tabs.map((guest, i) => {
      const url = guest.contents.getURL();
      // 許していない先のページは、タイトルも URL の道筋も読ませない（ページが書ける・認証の途中の値が URL に入っていることがある）。
      // 空のタブ（「＋」で開いたもの）は、許していない先ではない（navigate で開ける）。タイトルは読まない
      const title = isBlank(url) ? '（タイトルなし）' : this.allowed(url) ? guest.contents.getTitle() || '（タイトルなし）' : '（Claude に許していない先）';
      return `${guest.tabId === session.active ? '*' : ' '} ${i + 1}. ${title} — ${isBlank(url) ? '（空のタブ）' : this.shownUrl(url)}`;
    });
    return textResult(`タブ（* が今のタブ）:\n${lines.join('\n')}`);
  }

  // index: 1 から数えたタブの番号
  private tabAt(sessionId: string, index: unknown): Guest {
    const tabs = [...this.tabsOf(sessionId).tabs.values()].filter((g) => !g.contents.isDestroyed());
    const guest = typeof index === 'number' && Number.isInteger(index) ? tabs[index - 1] : undefined;
    if (!guest) throw new ToolError(`タブ ${String(index)} はありません（タブは ${tabs.length} 個。list_tabs で確かめられます）`);
    return guest;
  }

  private async selectTab(sessionId: string, index: unknown): Promise<ToolResult> {
    const guest = this.tabAt(sessionId, index);
    this.tabsOf(sessionId).active = guest.tabId;
    this.deps.send(this.deps.channels.selectTab, { sessionId, tabId: guest.tabId });
    await sleep(150);
    return this.pageResult(guest, `タブ ${String(index)} に切り替えました`);
  }

  private async closeTab(sessionId: string, index: unknown): Promise<ToolResult> {
    const session = this.tabsOf(sessionId);
    const guest = index === undefined ? await this.activeGuest(sessionId) : this.tabAt(sessionId, index);
    const number = [...session.tabs.keys()].indexOf(guest.tabId) + 1;
    this.deps.send(this.deps.channels.closeTab, { sessionId, tabId: guest.tabId });
    session.tabs.delete(guest.tabId);
    // 今のタブを閉じたときは、画面が次のタブを今のタブにして知らせてくる
    await sleep(150);
    return textResult(`タブ ${number} を閉じました（残りのタブ: ${session.tabs.size} 個）`);
  }

  // 開いたあとのページの様子。許していない先に移っていたら、そう伝える（タイトルと URL の道筋は伏せる）
  private pageResult(guest: Guest, done: string): ToolResult {
    const url = guest.contents.getURL();
    // 空のタブ（「＋」で開いたもの）は、許していない先ではない。navigate で、このタブに開けることを伝える
    if (isBlank(url)) return textResult(`${done}: （空のタブ）\n今のタブは空です。navigate で、このタブにページを開けます`);
    const allowed = this.allowed(url);
    const lines = [`${done}: ${allowed ? guest.contents.getTitle() || '（タイトルなし）' : '（Claude に許していない先）'}`, `URL: ${this.shownUrl(url)}`];
    if (!allowed) lines.push('このページは Claude に許していない先なので、これ以上は読めず、操作もできません');
    const errors = guest.logs.console.filter((l) => l.level === 'error').length;
    if (errors > 0) lines.push(`コンソールにエラーが ${errors} 件あります（get_console_logs で読めます）`);
    if (guest.logs.failed.length > 0) lines.push(`失敗した通信が ${guest.logs.failed.length} 件あります（get_failed_requests で読めます）`);
    return textResult(lines.join('\n'));
  }

  // ---- 読む ----

  private async screenshot(guest: Guest, selector: string | undefined, fullPage: boolean): Promise<ToolResult> {
    const { contents } = guest;
    let image: NativeImage;
    // CDP で撮るものは、はじめからページの大きさ（CSS の px）
    let note: string;
    if (selector) {
      const target = await this.locate(guest, selector);
      const pad = 8;
      const x = Math.max(0, Math.floor(target.rect.x - pad));
      const y = Math.max(0, Math.floor(target.rect.y - pad));
      const width = Math.min(target.viewport.width - x, Math.ceil(target.rect.width + pad * 2));
      const height = Math.min(target.viewport.height - y, Math.ceil(target.rect.height + pad * 2));
      if (width <= 0 || height <= 0) throw new ToolError(`「${selector}」は大きさが 0 で、撮れません`);
      image = await contents.capturePage({ x, y, width, height });
      note = `${selector}（${target.description}）`;
    } else if (fullPage) {
      const metrics = (await this.cdp(guest, 'Page.getLayoutMetrics')) as { cssContentSize: { width: number; height: number }; cssLayoutViewport: { clientWidth: number } };
      const width = metrics.cssLayoutViewport.clientWidth;
      const total = Math.ceil(metrics.cssContentSize.height);
      const height = Math.min(total, Math.round(width * MAX_FULL_PAGE_RATIO));
      const shot = (await this.cdp(guest, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })) as { data: string };
      image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      note = height < total ? `ページの上から ${height}px（全体の高さは ${total}px。続きは scroll してから撮る）` : `ページ全体（${width}×${height}）`;
    } else {
      image = await contents.capturePage();
      note = '見えている範囲';
    }
    if (image.isEmpty()) throw new ToolError('スクリーンショットを撮れませんでした（ページがまだ描かれていないかもしれません）');
    image = shrink(image, fullPage ? 1 : (await this.viewport(guest)).dpr);
    const size = image.getSize();
    return {
      content: [
        { type: 'image', data: image.toPNG().toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `${note}・${contents.getURL()}・画像 ${size.width}×${size.height}` },
      ],
    };
  }

  // 同じオリジンの iframe の中の文字も、iframe ごとに分けて読む
  private async text(guest: Guest, selector: string | undefined): Promise<ToolResult> {
    const result = (await this.world(
      guest,
      `(() => {${FRAMES}
        const textOf = (el) => (el ? el.innerText || el.textContent || '' : '');
        ${
          selector
            ? `const hit = __all(${JSON.stringify(selector)})[0];
        if (!hit) return null;
        const parts = [{ frame: __frameOf(hit), text: textOf(hit.el) }];`
            : `const parts = __docs().map((d) => ({ frame: __frameOf(d), text: textOf(d.doc.body) }));`
        }
        return { title: document.title, url: location.href, parts };
      })()`,
    )) as { title: string; url: string; parts: { frame: string | null; text: string }[] } | null;
    if (!result) throw new ToolError(`「${selector}」に当たる要素がありません`);
    // ページ全体のときは、別プロセスの iframe（許す先のものだけ）の文字も読む
    if (!selector) {
      for (const frame of await this.childFrames(guest)) {
        if (!this.allowed(frame.url)) continue;
        const value = (await this.cdp(guest, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, frame.child).catch(() => null)) as { result?: { value?: unknown } } | null;
        if (typeof value?.result?.value === 'string') result.parts.push({ frame: frame.url, text: value.result.value });
      }
    }
    const body = result.parts
      .map((p) => `${p.frame ? `--- iframe（${p.frame}）の中 ---\n` : ''}${p.text.replace(/\n{3,}/g, '\n\n').trim()}`)
      .join('\n\n');
    return textResult([`タイトル: ${result.title || '（なし）'}`, `URL: ${result.url}`, '', clip(body, MAX_TEXT)].join('\n'));
  }

  private async tree(guest: Guest): Promise<ToolResult> {
    // いちばん外のページと、同じプロセスで動く iframe（同じオリジンなど）のフレームごとに読む。許していない先の iframe は読まない
    type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
    const { frameTree } = (await this.cdp(guest, 'Page.getFrameTree')) as { frameTree: FrameTree };
    const frames: { id: string; url: string; top: boolean }[] = [];
    const collect = (node: FrameTree, top: boolean) => {
      frames.push({ id: node.frame.id, url: node.frame.url, top });
      node.childFrames?.forEach((child) => collect(child, false));
    };
    collect(frameTree, true);
    const lines: string[] = [];
    for (const frame of frames) {
      if (lines.length >= MAX_TREE_LINES) break;
      if (!frame.top) {
        if (!this.allowed(frame.url)) continue;
        lines.push(`--- iframe（${frame.url}）の中 ---`);
      }
      const result = (await this.cdp(guest, 'Accessibility.getFullAXTree', { frameId: frame.id }).catch(() => null)) as { nodes: AXNode[] } | null;
      if (result) this.formatTree(result.nodes, lines);
    }
    // 別プロセスの iframe（許す先のものだけ）
    for (const frame of await this.childFrames(guest)) {
      if (lines.length >= MAX_TREE_LINES || !this.allowed(frame.url)) continue;
      lines.push(`--- iframe（${frame.url}）の中 ---`);
      const result = (await this.cdp(guest, 'Accessibility.getFullAXTree', {}, frame.child).catch(() => null)) as { nodes: AXNode[] } | null;
      if (result) this.formatTree(result.nodes, lines);
    }
    if (lines.length >= MAX_TREE_LINES) lines.push(`…（${MAX_TREE_LINES} 行で切りました）`);
    return textResult([`URL: ${guest.contents.getURL()}`, ...lines].join('\n'));
  }

  // CDP のアクセシビリティのツリーを、字下げした一覧にして lines に足す
  private formatTree(nodes: AXNode[], lines: string[]): void {
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    const STATES = ['focused', 'checked', 'pressed', 'selected', 'expanded', 'disabled', 'required', 'invalid', 'level'];
    const walk = (node: AXNode | undefined, depth: number) => {
      if (!node || lines.length >= MAX_TREE_LINES) return;
      const role = String(node.role?.value ?? '');
      const name = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim();
      // 中身の無い入れ物は飛ばして、子を同じ深さで出す
      const skip = node.ignored || ((role === 'generic' || role === 'none' || role === 'InlineTextBox' || role === 'LineBreak') && !name) || role === 'StaticText';
      let next = depth;
      if (!skip) {
        const states = (node.properties ?? [])
          .filter((p) => STATES.includes(p.name) && p.value.value !== false && p.value.value !== 'false')
          .map((p) => (p.value.value === true || p.value.value === 'true' ? p.name : `${p.name}=${String(p.value.value)}`));
        const value = node.value?.value !== undefined && node.value.value !== '' ? ` 値=${JSON.stringify(String(node.value.value).slice(0, 100))}` : '';
        lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` "${name.slice(0, 200)}"` : ''}${value}${states.length ? ` [${states.join(', ')}]` : ''}`);
        next = depth + 1;
      }
      for (const child of node.childIds ?? []) walk(byId.get(child), next);
    };
    walk(root, 0);
  }

  private async inspect(guest: Guest, selector: string, properties: string[] | undefined): Promise<ToolResult> {
    const props = properties && properties.length > 0 ? properties : DEFAULT_STYLES;
    const found = (await this.world(
      guest,
      `(() => {${FRAMES}
        const props = ${JSON.stringify(props)};
        let all;
        try { all = __all(${JSON.stringify(selector)}); } catch (e) { return { error: 'セレクタの書き方が違います: ' + e.message }; }
        return { total: all.length, items: all.slice(0, 10).map((hit) => {
          const el = hit.el;
          const r = __rect(el);
          const cs = __style(el);
          const html = el.outerHTML;
          return {
            html: html.length > 2000 ? html.slice(0, 2000) + '…' : html,
            rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            visible: __shown(el) && cs.display !== 'none',
            frame: __frameOf(hit),
            styles: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])),
          };
        }) };
      })()`,
    )) as { error?: string; total: number; items: { html: string; rect: BrowserRect; visible: boolean; frame: string | null; styles: Record<string, string> }[] };
    if (found.error) throw new ToolError(found.error);
    if (found.total === 0) throw new ToolError(`「${selector}」に当たる要素がありません`);
    const parts = found.items.map((item, i) =>
      [
        `## ${i + 1} つ目（${item.visible ? '見えている' : '見えていない'}・x=${item.rect.x} y=${item.rect.y} ${item.rect.width}×${item.rect.height}${item.frame ? `・iframe（${item.frame}）の中` : ''}）`,
        '```html',
        item.html,
        '```',
        ...Object.entries(item.styles).map(([k, v]) => `- ${k}: ${v}`),
      ].join('\n'),
    );
    const more = found.total > found.items.length ? `\n\n（ほかに ${found.total - found.items.length} 個あります）` : '';
    return textResult(`「${selector}」に当たる要素: ${found.total} 個\n\n${parts.join('\n\n')}${more}`);
  }

  private consoleLogs(guest: Guest, level: string, clear: boolean): ToolResult {
    const levels = level === 'error' ? ['error'] : level === 'warning' ? ['error', 'warning'] : null;
    const logs = guest.logs.console.filter((l) => !levels || levels.includes(l.level));
    if (clear) guest.logs.console.length = 0;
    if (logs.length === 0) return textResult('コンソールに出たものはありません');
    return textResult(clip(logs.map((l) => `[${l.level}] ${l.text}`).join('\n'), MAX_TEXT));
  }

  private failedRequests(guest: Guest, clear: boolean): ToolResult {
    const failed = [...guest.logs.failed];
    if (clear) guest.logs.failed.length = 0;
    return textResult(failed.length === 0 ? '失敗した通信はありません' : clip(failed.join('\n'), MAX_TEXT));
  }

  // ---- 動かす ----

  // selector か、見えている範囲の x・y（スクリーンショットの位置）で押す
  private async click(sessionId: string, guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const selector = optionalString(args.selector);
    const double = args.double === true;
    const button = optionalString(args.button) ?? 'left';
    let target: { rect: BrowserRect; description: string; covered: string | null; child?: { session: string; x: number; y: number } };
    if (selector) target = await this.locate(guest, selector);
    else if (typeof args.x === 'number' && typeof args.y === 'number' && Number.isFinite(args.x) && Number.isFinite(args.y)) target = await this.pointAt(guest, args.x, args.y);
    else throw new ToolError('selector か、x と y を渡してください');
    const before = guest.contents.getURL();
    await this.highlight(sessionId, target.rect);
    // 別プロセスの iframe の中は、その iframe のセッションに、iframe の中の位置で送る
    const { x, y } = target.child ?? center(target.rect);
    const child = target.child?.session;
    const pressButton = button === 'right' || button === 'middle' ? button : 'left';
    await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, child);
    for (let count = 1; count <= (double ? 2 : 1); count++) {
      await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: pressButton, clickCount: count }, child);
      await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: pressButton, clickCount: count }, child);
    }
    await settle(guest.contents);
    const lines = [`${double ? 'ダブルクリック' : 'クリック'}しました: ${target.description}`];
    if (target.covered) lines.push(`（押した位置には、ほかの要素 ${target.covered} が重なっていました）`);
    const after = guest.contents.getURL();
    // 移る前に止められなかった形（ページの「戻る」ボタンの history.back など）で許していない先へ移ったときは、オリジンだけを伝える
    if (after !== before) lines.push(`ページが移りました: ${this.shownUrl(after)}${this.allowed(after) ? '' : '（Claude に許していない先なので、これ以上は読めず、操作もできません）'}`);
    return textResult(lines.join('\n'));
  }

  private async type(sessionId: string, guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const text = typeof args.text === 'string' ? args.text : '';
    const selector = optionalString(args.selector);
    let where = '今フォーカスのある場所';
    if (selector) {
      const target = await this.locate(guest, selector);
      await this.highlight(sessionId, target.rect);
      const { x, y } = center(target.rect);
      await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      where = target.description;
    }
    // フォーカスが別プロセスの iframe の中なら、そのセッションに送る
    const child = await this.focusedChild(guest);
    if (args.clear === true && child) {
      await this.cdp(
        guest,
        'Runtime.evaluate',
        { expression: '(() => { const el = document.activeElement; if (el && typeof el.select === "function") el.select(); else if (el && el.isContentEditable) getSelection().selectAllChildren(el); })()' },
        child,
      );
      await this.key(guest, 'Backspace', [], child);
    } else if (args.clear === true) {
      // 欄の文字を全部選んでから消す（ページには、ふつうの削除として届く）
      await this.world(
        guest,
        `(() => {
          // フォーカスが同じオリジンの iframe の中にあれば、その中の欄
          let el = document.activeElement;
          while (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
            let d = null;
            try { d = el.contentDocument; } catch (e) {}
            if (!d) break;
            el = d.activeElement;
          }
          if (el && typeof el.select === 'function') el.select();
          else if (el && el.isContentEditable) el.ownerDocument.getSelection().selectAllChildren(el);
        })()`,
      );
      await this.key(guest, 'Backspace', []);
    }
    if (text) await this.cdp(guest, 'Input.insertText', { text }, child);
    if (args.submit === true) await this.key(guest, 'Enter', [], child);
    await settle(guest.contents);
    return textResult(`${where}に入力しました${args.submit === true ? '（Enter も押しました）' : ''}`);
  }

  private async pressKey(guest: Guest, key: string, modifiers: string[]): Promise<ToolResult> {
    await this.key(guest, key, modifiers, await this.focusedChild(guest));
    await settle(guest.contents);
    return textResult(`${[...modifiers, key].join('+')} を押しました`);
  }

  private async key(guest: Guest, name: string, modifiers: string[], child?: string): Promise<void> {
    const spec = keySpec(name);
    if (!spec) throw new ToolError(`知らないキーです: ${name}`);
    const bits = modifiers.reduce((sum, m) => sum | (MODIFIER_BITS[m] ?? 0), 0);
    // Ctrl・⌘ と一緒に押すときは、文字を入れない
    const text = bits & (MODIFIER_BITS.control | MODIFIER_BITS.meta) ? undefined : spec.text;
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers: bits };
    await this.cdp(guest, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) }, child);
    await this.cdp(guest, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base }, child);
  }

  private async scroll(guest: Guest, selector: string | undefined, deltaX: number, deltaY: number): Promise<ToolResult> {
    if (!selector && !deltaX && !deltaY) throw new ToolError('selector か deltaX・deltaY を渡してください');
    const position = (await this.world(
      guest,
      `(() => {${FRAMES}
        const target = ${selector ? `(__all(${JSON.stringify(selector)})[0] || {}).el` : 'null'};
        ${selector ? `if (!target) return null; target.scrollIntoView({ block: 'center', inline: 'nearest' });` : ''}
        const dx = ${deltaX}, dy = ${deltaY};
        let scroller = document.scrollingElement || document.documentElement;
        if (dx || dy) {
          // 真ん中（selector があればその要素）から上へたどって、動かせる入れ物を探す。iframe の中のページの上まで来たら、iframe の外へ
          const can = (e) => {
            const cs = __style(e);
            const root = e === e.ownerDocument.scrollingElement;
            return (dy && e.scrollHeight > e.clientHeight && (root || /(auto|scroll|overlay)/.test(cs.overflowY))) ||
              (dx && e.scrollWidth > e.clientWidth && (root || /(auto|scroll|overlay)/.test(cs.overflowX)));
          };
          const start = target || __hit(innerWidth / 2, innerHeight / 2).el;
          for (let e = start; e; ) {
            if (can(e)) { scroller = e; break; }
            e = e.parentElement || __view(e).frameElement;
          }
          scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        }
        const page = scroller === scroller.ownerDocument.scrollingElement;
        return { x: Math.round(scroller.scrollLeft), y: Math.round(scroller.scrollTop), where: page ? (scroller.ownerDocument === document ? 'ページ' : 'iframe の中のページ') : '中の入れ物' };
      })()`,
    )) as { x: number; y: number; where: string } | null;
    if (!position) throw new ToolError(`「${selector}」に当たる要素がありません`);
    return textResult(`スクロールしました（${position.where}の位置: x=${position.x} y=${position.y}）`);
  }

  private async waitFor(guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const selector = optionalString(args.selector);
    const text = optionalString(args.text);
    if (!selector && !text) throw new ToolError('selector か text を渡してください');
    const state = optionalString(args.state) ?? 'visible';
    const timeout = Math.min(Math.max(numberOr(args.timeoutMs, 10_000), 0), 30_000);
    const check = `(() => {${FRAMES}
      const state = ${JSON.stringify(state)};
      let el = null;
      ${selector ? `el = (__all(${JSON.stringify(selector)})[0] || {}).el || null;` : ''}
      ${
        text
          ? `if (!${selector ? 'el' : 'false'}) {
        const want = ${JSON.stringify(text)};
        for (const d of __docs()) {
          if (!d.doc.body) continue;
          const walker = d.doc.createTreeWalker(d.doc.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(want)) { el = n.parentElement; break; }
          if (el) break;
        }
      }`
          : ''
      }
      const visible = !!el && __shown(el);
      return state === 'attached' ? !!el : state === 'hidden' ? !visible : visible;
    })()`;
    const started = Date.now();
    while (true) {
      if (await this.world(guest, check).catch(() => false)) {
        return textResult(`${selector ? `「${selector}」` : `「${text}」`}が${state === 'hidden' ? '消えました' : '出ました'}（${Date.now() - started} ms）`);
      }
      if (Date.now() - started > timeout) throw new ToolError(`${timeout} ms 待っても、${selector ? `「${selector}」` : `「${text}」`}が${state === 'hidden' ? '消えませんでした' : '出ませんでした'}`);
      await sleep(150);
    }
  }

  private async setViewport(sessionId: string, guest: Guest, width: string): Promise<ToolResult> {
    // in だと、Object の持ち物の名前（toString・constructor・__proto__）も通るので、自分の持つキーだけを受け付ける
    if (!Object.hasOwn(VIEWPORTS, width)) throw new ToolError(`表示幅は full・mobile・tablet のどれかです: ${width}`);
    this.deps.send(this.deps.channels.viewport, { sessionId, width: VIEWPORTS[width] });
    // 画面が webview の幅を変えて、ページが描き直すのを待つ
    await sleep(400);
    const viewport = await this.viewport(guest);
    return textResult(`表示幅を ${width} にしました（ページの幅 ${viewport.width}px・高さ ${viewport.height}px）`);
  }

  private async evaluate(guest: Guest, expression: string): Promise<ToolResult> {
    let value: unknown;
    const logged = guest.logs.console.length;
    try {
      value = await guest.contents.executeJavaScript(expression);
    } catch (error) {
      // 投げられたエラーの中身は、例外には入らずコンソールに出る（届くのを少し待つ）
      await sleep(100);
      const thrown = guest.logs.console.slice(logged).filter((l) => l.level === 'error').map((l) => l.text);
      throw new ToolError(`実行に失敗しました: ${thrown.length > 0 ? thrown.join('\n') : error instanceof Error ? error.message : String(error)}`);
    }
    let text: string;
    try {
      text = value === undefined ? 'undefined' : (JSON.stringify(value, null, 2) ?? String(value));
    } catch {
      text = String(value);
    }
    return textResult(clip(text, MAX_TEXT));
  }

  // ---- 部品 ----

  // 今のタブのページ。開いていない・許していない先なら、理由を添えて断る
  private async current(sessionId: string): Promise<Guest> {
    const guest = await this.activeGuest(sessionId);
    const url = guest.contents.getURL();
    if (isBlank(url)) throw new ToolError('今のタブは空です。navigate で開いてください');
    this.checkUrl(url, '今のページ');
    return guest;
  }

  // 今のタブ。作った直後で、まだ画面から知らせが来ていなければ少し待つ
  private async activeGuest(sessionId: string): Promise<Guest> {
    const started = Date.now();
    while (true) {
      const session = this.sessions.get(sessionId);
      const guest = session?.active ? session.tabs.get(session.active) : undefined;
      if (guest && !guest.contents.isDestroyed()) return guest;
      if (!session?.active || Date.now() - started > ACTIVE_WAIT_MS) {
        throw new ToolError('このセッションのアプリ内ブラウザで、まだページを開いていません。navigate で開いてください');
      }
      await sleep(50);
    }
  }

  private tabsOf(sessionId: string): Tabs {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { tabs: new Map(), active: null, blocked: null, opened: [] };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private find(contents: WebContents): { sessionId: string; session: Tabs; guest: Guest } | null {
    for (const [sessionId, session] of this.sessions) {
      for (const guest of session.tabs.values()) if (guest.contents === contents) return { sessionId, session, guest };
    }
    return null;
  }

  // ユーザーに操作を頼んでいる間は、並べて呼ばれた読むツールが動いていても、Claude の操作として扱わない（ユーザーがログインで外へ移れるように）
  private operating(sessionId: string): boolean {
    if (this.asks.has(sessionId)) return false;
    return (this.running.get(sessionId) ?? 0) > 0 || Date.now() - (this.endedAt.get(sessionId) ?? 0) < OPERATING_GRACE_MS;
  }

  private allowed(url: string): boolean {
    return isClaudeAllowedUrl(url, this.deps.extraHosts());
  }

  // Claude に見せる URL。許していない先は、オリジンだけ（ログインで外の認証のページへ移ったとき、URL に認証の途中の値が入っていることがある）
  private shownUrl(url: string): string {
    return this.allowed(url) ? url : (originOf(url) ?? '読めない URL');
  }

  private checkUrl(url: string, what: string): void {
    if (this.allowed(url)) return;
    throw new ToolError(
      `${what}（${this.shownUrl(url)}）は、Claude に許していない先です。Claude が開けるのは localhost・127.0.0.1・*.local と、ユーザーが tanacode のメニュー（tanacode → アプリ内ブラウザで Claude に許す先…）で足した先だけです。必要なら、ユーザーに足してもらってください`,
    );
  }

  private waitAttach(sessionId: string): Promise<Guest> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ToolError('アプリ内ブラウザを開けませんでした（tanacode の画面が応えませんでした）')), ATTACH_TIMEOUT_MS);
      const list = this.waiters.get(sessionId) ?? [];
      list.push((guest) => {
        clearTimeout(timer);
        resolve(guest);
      });
      this.waiters.set(sessionId, list);
    });
  }

  private world(guest: Guest, code: string): Promise<unknown> {
    return guest.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
  }

  // CDP の命令を送る。child: 別プロセスの iframe のセッション（無ければページ）
  private async cdp(guest: Guest, method: string, params?: Record<string, unknown>, child?: string): Promise<unknown> {
    const dbg = guest.contents.debugger;
    if (!guest.cdp || !dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch (error) {
        if (!dbg.isAttached()) throw new ToolError(`ページを操作する準備ができませんでした（${error instanceof Error ? error.message : String(error)}）`);
      }
      guest.cdp = true;
      // 別プロセスの iframe にもつなぐ（つながると Target.attachedToTarget が届く）
      await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
      await sleep(150);
    }
    return dbg.sendCommand(method, params, child);
  }

  // 別プロセスの iframe と、その今の URL
  private async childFrames(guest: Guest): Promise<{ child: string; url: string }[]> {
    await this.cdp(guest, 'Target.getTargets').catch(() => undefined);
    const frames: { child: string; url: string }[] = [];
    for (const child of guest.children) {
      const result = (await this.cdp(guest, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, child).catch(() => null)) as { result?: { value?: unknown } } | null;
      if (typeof result?.result?.value === 'string') frames.push({ child, url: result.result.value });
    }
    return frames;
  }

  // src の iframe が別プロセスで動いていれば、そのセッション（オリジンで見つける）
  private async childFor(guest: Guest, src: string): Promise<{ child: string; url: string } | null> {
    const origin = originOf(src);
    if (!origin) return null;
    return (await this.childFrames(guest)).find((f) => originOf(f.url) === origin) ?? null;
  }

  // 今キーボードのフォーカスがある、別プロセスの iframe のセッション（ページの中なら undefined）。許していない先なら断る
  private async focusedChild(guest: Guest): Promise<string | undefined> {
    const src = (await this.world(
      guest,
      `(() => {
        let el = document.activeElement;
        while (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
          let d = null;
          try { d = el.contentDocument; } catch (e) {}
          if (!d) return el.src || null;
          el = d.activeElement;
        }
        return null;
      })()`,
    )) as string | null;
    if (!src) return undefined;
    const frame = await this.childFor(guest, src);
    const url = frame?.url ?? src;
    if (!this.allowed(url)) throw new ToolError(`フォーカスが、許していない先の iframe（${frameShown(url)}）の中にあるので、入力できません`);
    return frame?.child;
  }

  private async viewport(guest: Guest): Promise<{ width: number; height: number; dpr: number }> {
    return (await this.world(guest, '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })')) as { width: number; height: number; dpr: number };
  }

  // セレクタに当たる要素（同じオリジンの iframe の中も）のうち、見えている最初のものを、見える位置まで動かして、その位置を返す
  private async locate(guest: Guest, selector: string): Promise<{ rect: BrowserRect; viewport: { width: number; height: number }; description: string; covered: string | null }> {
    const found = (await this.world(
      guest,
      `(() => {${FRAMES}
        let all;
        try { all = __all(${JSON.stringify(selector)}); } catch (e) { return { error: 'セレクタの書き方が違います: ' + e.message }; }
        if (all.length === 0) return { error: 'none' };
        const hit = all.find((h) => __shown(h.el));
        if (!hit) return { error: 'hidden', count: all.length };
        const el = hit.el;
        // iframe の中の要素は、外のページも合わせて動かす
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = __rect(el);
        const top = __hit(r.x + r.width / 2, r.y + r.height / 2).el;
        return {
          rect: r,
          viewport: { width: innerWidth, height: innerHeight },
          description: __label(el),
          covered: top && top !== el && !el.contains(top) && !top.contains(el) ? __name(top) : null,
        };
      })()`,
    )) as { error?: string; count?: number; rect: BrowserRect; viewport: { width: number; height: number }; description: string; covered: string | null };
    if (found.error === 'none') throw new ToolError(`「${selector}」に当たる要素がありません`);
    if (found.error === 'hidden') throw new ToolError(`「${selector}」に当たる要素（${found.count} 個）は、どれも見えていません`);
    if (found.error) throw new ToolError(found.error);
    return found;
  }

  // 見えている範囲の (x, y) にある要素。別オリジンの iframe の中は、その iframe の src が許す先のときだけ押せる
  // （スクリプトからは中が見えないので、どのページかは src で決める）
  private async pointAt(
    guest: Guest,
    x: number,
    y: number,
  ): Promise<{ rect: BrowserRect; description: string; covered: string | null; child?: { session: string; x: number; y: number } }> {
    const found = (await this.world(
      guest,
      `(() => {${FRAMES}
        const x = ${x}, y = ${y};
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { error: 'outside', width: innerWidth, height: innerHeight };
        const hit = __hit(x, y);
        if (!hit.el) return { error: 'none' };
        const inner = hit.cross ? __inner(hit.el) : null;
        const o = hit.cross ? __offset(hit.el.ownerDocument) : null;
        return {
          cross: hit.cross,
          src: hit.src || null,
          // 別オリジンの iframe の中身の左上（いちばん外の見えている範囲から）
          frame: inner ? { x: inner.x + o.ox, y: inner.y + o.oy } : null,
          description: hit.cross ? __name(hit.el) : __label(hit.el),
        };
      })()`,
    )) as { error?: string; width?: number; height?: number; cross: boolean; src: string | null; frame: { x: number; y: number } | null; description: string };
    if (found.error === 'outside') throw new ToolError(`x=${x} y=${y} は、見えている範囲（${found.width}×${found.height}）の外です`);
    if (found.error) throw new ToolError(`x=${x} y=${y} には要素がありません`);
    const rect = { x: x - 10, y: y - 10, width: 20, height: 20 };
    if (!found.cross) return { rect, description: `x=${x} y=${y} の ${found.description}`, covered: null };
    // 別オリジンの iframe。別プロセスで動いていれば、そのセッションに、iframe の中の位置で送る
    const frame = found.src ? await this.childFor(guest, found.src) : null;
    const url = frame?.url ?? found.src;
    if (!url || !this.allowed(url)) throw new ToolError(`x=${x} y=${y} は、許していない先の iframe（${url ? frameShown(url) : 'src なし'}）の中なので、押せません`);
    return {
      rect,
      description: `x=${x} y=${y}（別オリジンの iframe ${url} の中）`,
      covered: null,
      child: frame && found.frame ? { session: frame.child, x: x - found.frame.x, y: y - found.frame.y } : undefined,
    };
  }

  // 押す要素に枠を出す（ブラウザを見ているユーザーに、どこを押すかを見せる）
  private async highlight(sessionId: string, rect: BrowserRect): Promise<void> {
    this.emit({ sessionId, active: true, label: null, box: rect });
    await sleep(HIGHLIGHT_MS);
  }

  // ユーザーに頼む前に、「Claude が操作中」の帯を下ろし、Claude の操作として扱うのをやめる（終わってすぐの間も）。
  // ほかの呼び出しが動いている途中なら、それが終わるのに任せる
  private yieldToUser(sessionId: string): void {
    if ((this.running.get(sessionId) ?? 0) > 0) return;
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
    this.endedAt.delete(sessionId);
    this.emit({ sessionId, active: false, label: null, box: null });
  }

  private begin(sessionId: string, label: string): void {
    clearTimeout(this.idleTimers.get(sessionId));
    this.running.set(sessionId, (this.running.get(sessionId) ?? 0) + 1);
    this.emit({ sessionId, active: true, label, box: null });
  }

  private end(sessionId: string): void {
    const left = (this.running.get(sessionId) ?? 1) - 1;
    this.running.set(sessionId, left);
    this.endedAt.set(sessionId, Date.now());
    if (left > 0) return;
    // 枠は押し終わったら消す。帯は、続けて操作することが多いので少し残す
    this.emit({ sessionId, active: true, label: null, box: null });
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.set(
      sessionId,
      setTimeout(() => {
        this.idleTimers.delete(sessionId);
        this.emit({ sessionId, active: false, label: null, box: null });
      }, ACTIVE_LINGER_MS),
    );
  }

  private emit(activity: BrowserActivity): void {
    this.deps.send(this.deps.channels.activity, activity);
  }
}

// ---- 小さな部品 ----

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// 断る文に出す、許していない先の iframe の URL。オリジンだけ（iframe の今の URL はページからは読めず、認証・決済の途中の値が入っていることがある）。
// URL として読めないものは、ページに書いてある src そのものなので、そのまま
function frameShown(url: string): string {
  return originOf(url) ?? url;
}

// 空のタブ（「＋」で開いたもの・まだ何も開いていないもの）
function isBlank(url: string): boolean {
  return url === '' || url === 'about:blank';
}

// タブの ID（tab-<番号>）の番号
function tabNumber(tabId: string): number {
  return Number(tabId.replace(/\D/g, '')) || 0;
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, meta: 4, shift: 8 };

type KeySpec = { key: string; code: string; keyCode: number; text?: string };

const NAMED_KEYS: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

export function keySpec(name: string): KeySpec | null {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return named;
  const f = /^f([1-9]|1[0-2])$/i.exec(name);
  if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]) };
  if ([...name].length !== 1) return null;
  const upper = name.toUpperCase();
  if (/[A-Z]/.test(upper)) return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: name };
  if (/[0-9]/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
  return { key: name, code: '', keyCode: 0, text: name };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  const text = optionalString(value);
  if (!text) throw new ToolError(`${name} を渡してください`);
  return text;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// 「localhost:3000」のようにスキームが無ければ http:// を付ける
function toUrl(input: string): string {
  const text = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
}

function center(rect: BrowserRect): { x: number; y: number } {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（${text.length - max} 文字を省きました）` : text;
}

// Retina では、撮った画像はページの大きさ（CSS の px）の dpr 倍になる。ページの大きさに縮め、長い辺も上限までにする
function shrink(image: NativeImage, dpr: number): NativeImage {
  const { width, height } = image.getSize();
  const scale = Math.min(dpr > 1 ? 1 / dpr : 1, MAX_IMAGE_SIDE / Math.max(width, height, 1));
  if (scale >= 1) return image;
  return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 読み込みが終わるまで待つ（移り始めるのを少し待ってから、読み込み中でなくなるまで）
async function waitForLoad(contents: WebContents): Promise<void> {
  const started = Date.now();
  await sleep(100);
  while (Date.now() - started < LOAD_TIMEOUT_MS) {
    if (contents.isDestroyed()) return;
    const url = contents.getURL();
    if (!contents.isLoading() && url && url !== 'about:blank') return;
    await sleep(100);
  }
}

// 操作のあと、ページが落ち着くのを待つ。移り始めたら、読み込みが終わるまで
async function settle(contents: WebContents): Promise<void> {
  await sleep(250);
  if (!contents.isDestroyed() && contents.isLoading()) await waitForLoad(contents);
}
