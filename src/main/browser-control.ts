import { nativeImage, webContents as allWebContents, type NativeImage, type Session, type WebContents } from 'electron';
import { browserTool, isClaudeAllowedUrl } from '@shared/browser-tools';
import type { BrowserActivity, BrowserRect } from '@shared/ipc';
import { textResult, type ToolResult } from './browser-bridge';

// Claude Code から（中継とソケット経由で）届いた、アプリ内ブラウザの操作を実行する。
// 操作するのは、そのセッションの webview の中身（webContents）。メインプロセスが直接動かす（capturePage・CDP）。
// クリックや入力は CDP（Input.*）で送る。ウィンドウが前に無くても届き、ページには本物の操作（isTrusted）として届く。
// 隠れているセッションの webview も、画面（renderer）が透明にして描かせたままにするので、撮れるし操作できる

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
// クリックする要素に枠を出してから押すまでの間（ユーザーが目で追えるように）
const HIGHLIGHT_MS = 400;
// 最後の操作のあと、「Claude が操作中」の帯を出しておく時間
const ACTIVE_LINGER_MS = 8_000;
// 操作が終わったあとも、Claude の操作として扱う間（押したボタンの処理が少し遅れてページを移すことがあるため）
const OPERATING_GRACE_MS = 2_000;
const VIEWPORTS: Record<string, number> = { full: 0, mobile: 390, tablet: 768 };
const DEFAULT_STYLES = [
  'display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
  'color', 'background-color', 'background-image', 'opacity', 'font-family', 'font-size', 'font-weight', 'line-height',
  'text-align', 'overflow', 'z-index', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'visibility',
];

type LogEntry = { level: string; text: string };
type Guest = {
  contents: WebContents;
  console: LogEntry[];
  failed: string[];
  // CDP（debugger）をつないだか
  cdp: boolean;
  // Claude の操作の間に、許していない先へ移ろうとして止めたもの（呼び出しごとに空にする）
  blocked: string | null;
};

type Deps = {
  // 画面（renderer）へ送る
  send: (channel: string, payload: unknown) => void;
  // メニューで、Claude にアプリ内ブラウザを操作させるのがオンか
  enabled: () => boolean;
  // ユーザーが足した、Claude に許す先
  extraHosts: () => string[];
  // アプリの画面（webview を持っている webContents）
  host: () => WebContents | null;
  // あるセッションか（アーカイブしたものも含む）
  hasSession: (id: string) => boolean;
  channels: { open: string; activity: string; viewport: string };
};

class ToolError extends Error {}

export class BrowserControl {
  private readonly guests = new Map<string, Guest>();
  private readonly waiters = new Map<string, ((guest: Guest) => void)[]>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  // 動いている呼び出しの数（セッションごと）。0 になって少したったら、帯を消す
  private readonly running = new Map<string, number>();
  // 最後の呼び出しが終わった時刻（セッションごと）
  private readonly endedAt = new Map<string, number>();

  constructor(private readonly deps: Deps) {}

  // 失敗した通信（4xx・5xx・つながらなかったもの）を集める。プレビューの webview が使うセッションに 1 回だけ付ける
  watchNetwork(session: Session): void {
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    session.webRequest.onCompleted(filter, (details) => {
      if (details.statusCode < 400 || details.webContentsId === undefined) return;
      this.guestByContents(details.webContentsId)?.failed.push(`${details.statusCode} ${details.method} ${details.url}（${details.resourceType}）`);
      this.trimFailed(details.webContentsId);
    });
    session.webRequest.onErrorOccurred(filter, (details) => {
      // 移ったための中断（ERR_ABORTED）は失敗にしない
      if (details.webContentsId === undefined || details.error === 'net::ERR_ABORTED') return;
      this.guestByContents(details.webContentsId)?.failed.push(`${details.error} ${details.method} ${details.url}（${details.resourceType}）`);
      this.trimFailed(details.webContentsId);
    });
  }

  // 画面（renderer）が、セッションの webview を作って知らせてきた。アプリの画面の中の webview だけを受け付ける
  attach(sessionId: string, contentsId: number): void {
    const contents = allWebContents.fromId(contentsId);
    const host = this.deps.host();
    if (!contents || !host || contents.getType() !== 'webview' || contents.hostWebContents !== host) return;
    if (this.guests.get(sessionId)?.contents === contents) return;
    const guest: Guest = { contents, console: [], failed: [], cdp: false, blocked: null };
    this.guests.set(sessionId, guest);
    contents.on('console-message', (event) => {
      const { level, message, sourceId, lineNumber } = event;
      const where = sourceId ? ` (${sourceId}${lineNumber ? `:${lineNumber}` : ''})` : '';
      guest.console.push({ level, text: `${message}${where}` });
      if (guest.console.length > MAX_CONSOLE) guest.console.splice(0, guest.console.length - MAX_CONSOLE);
    });
    // 新しいページを開いたら、コンソールと失敗した通信を空にする（「今のページを開いてから」のもの）
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) {
        guest.console = [];
        guest.failed = [];
      }
    });
    contents.debugger.on('detach', () => (guest.cdp = false));
    contents.once('destroyed', () => {
      if (this.guests.get(sessionId) === guest) this.guests.delete(sessionId);
    });
    for (const resolve of this.waiters.get(sessionId) ?? []) resolve(guest);
    this.waiters.delete(sessionId);
  }

  // Claude が操作している最中（と、終わってすぐ）の webview か。この間は、許していない先へ移らせず、新しいウィンドウも開かせない
  isOperating(contents: WebContents): boolean {
    for (const [sessionId, guest] of this.guests) {
      if (guest.contents !== contents) continue;
      return (this.running.get(sessionId) ?? 0) > 0 || Date.now() - (this.endedAt.get(sessionId) ?? 0) < OPERATING_GRACE_MS;
    }
    return false;
  }

  // webview のトップのフレームが url へ移ろうとしている（リンク・リダイレクト・ページのスクリプト）。
  // Claude の操作で、許していない先へ移ろうとしていれば止める（true を返す）。ユーザーの操作は止めない
  blocksNavigation(contents: WebContents, url: string): boolean {
    if (!this.isOperating(contents) || this.allowed(url)) return false;
    for (const guest of this.guests.values()) if (guest.contents === contents) guest.blocked = url;
    return true;
  }

  // セッションを消した・アーカイブしたとき
  forget(sessionId: string): void {
    this.guests.delete(sessionId);
    this.running.delete(sessionId);
    this.endedAt.delete(sessionId);
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
  }

  // 中継から届いた呼び出し
  async handle(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = browserTool(name);
    if (!tool) return textResult(`知らないツールです: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult('アプリ内ブラウザの操作は、tanacode のメニュー（tanacode → Claude にアプリ内ブラウザを操作させる）でオフになっています', true);
    }
    if (!this.deps.hasSession(sessionId)) return textResult('このセッションは tanacode にありません', true);
    this.begin(sessionId, tool.label);
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

  private async run(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const existing = this.guests.get(sessionId);
    if (existing) existing.blocked = null;
    const result = await this.dispatch(sessionId, name, args);
    // 操作の途中で、許していない先へ移ろうとして止めたら、そう伝える
    const blocked = this.guests.get(sessionId)?.blocked;
    if (blocked && !result.isError) {
      result.content.push({ type: 'text', text: `許していない先（${blocked}）へ移ろうとしたので、止めました` });
    }
    return result;
  }

  private async dispatch(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === 'navigate') return this.navigate(sessionId, args);
    const guest = this.current(sessionId);
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
        return this.click(sessionId, guest, requiredString(args.selector, 'selector'), args.double === true, optionalString(args.button) ?? 'left');
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
      const guest = this.current(sessionId);
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
    let guest = this.guests.get(sessionId);
    if (!guest || guest.contents.isDestroyed()) {
      // まだブラウザを開いていないセッション。画面に webview を作らせ、知らせを待つ
      const attached = this.waitAttach(sessionId);
      this.deps.send(this.deps.channels.open, { sessionId, url });
      guest = await attached;
      await waitForLoad(guest.contents);
    } else {
      const opened = guest;
      await opened.contents.loadURL(url).catch((error: unknown) => {
        // 許していない先へのリダイレクトを止めた
        if (opened.blocked) throw new ToolError(`${url} は、許していない先（${opened.blocked}）へ移ろうとしたので、止めました`);
        // 移ったための中断（リダイレクトなど）は失敗にしない
        if (!/ERR_ABORTED/.test(String(error))) throw new ToolError(`${url} を開けませんでした（${error instanceof Error ? error.message : String(error)}）`);
      });
    }
    return this.pageResult(guest, '開きました');
  }

  // 開いたあとのページの様子。許していない先に移っていたら、そう伝える
  private pageResult(guest: Guest, done: string): ToolResult {
    const url = guest.contents.getURL();
    const lines = [`${done}: ${guest.contents.getTitle() || '（タイトルなし）'}`, `URL: ${url}`];
    if (!this.allowed(url)) lines.push('このページは Claude に許していない先なので、これ以上は読めず、操作もできません');
    const errors = guest.console.filter((l) => l.level === 'error').length;
    if (errors > 0) lines.push(`コンソールにエラーが ${errors} 件あります（get_console_logs で読めます）`);
    if (guest.failed.length > 0) lines.push(`失敗した通信が ${guest.failed.length} 件あります（get_failed_requests で読めます）`);
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

  private async text(guest: Guest, selector: string | undefined): Promise<ToolResult> {
    const result = (await this.world(
      guest,
      `(() => {
        const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
        if (!root) return null;
        return { title: document.title, url: location.href, text: root.innerText || root.textContent || '' };
      })()`,
    )) as { title: string; url: string; text: string } | null;
    if (!result) throw new ToolError(`「${selector}」に当たる要素がありません`);
    return textResult([`タイトル: ${result.title || '（なし）'}`, `URL: ${result.url}`, '', clip(result.text.replace(/\n{3,}/g, '\n\n').trim(), MAX_TEXT)].join('\n'));
  }

  private async tree(guest: Guest): Promise<ToolResult> {
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
    const { nodes } = (await this.cdp(guest, 'Accessibility.getFullAXTree')) as { nodes: AXNode[] };
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    const lines: string[] = [];
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
    if (lines.length >= MAX_TREE_LINES) lines.push(`…（${MAX_TREE_LINES} 行で切りました）`);
    return textResult([`URL: ${guest.contents.getURL()}`, ...lines].join('\n'));
  }

  private async inspect(guest: Guest, selector: string, properties: string[] | undefined): Promise<ToolResult> {
    const props = properties && properties.length > 0 ? properties : DEFAULT_STYLES;
    const found = (await this.world(
      guest,
      `(() => {
        const props = ${JSON.stringify(props)};
        const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
        return { total: all.length, items: all.slice(0, 10).map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const html = el.outerHTML;
          return {
            html: html.length > 2000 ? html.slice(0, 2000) + '…' : html,
            rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
            styles: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])),
          };
        }) };
      })()`,
    )) as { total: number; items: { html: string; rect: BrowserRect; visible: boolean; styles: Record<string, string> }[] };
    if (found.total === 0) throw new ToolError(`「${selector}」に当たる要素がありません`);
    const parts = found.items.map((item, i) =>
      [
        `## ${i + 1} つ目（${item.visible ? '見えている' : '見えていない'}・x=${item.rect.x} y=${item.rect.y} ${item.rect.width}×${item.rect.height}）`,
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
    const logs = guest.console.filter((l) => !levels || levels.includes(l.level));
    if (clear) guest.console = [];
    if (logs.length === 0) return textResult('コンソールに出たものはありません');
    return textResult(clip(logs.map((l) => `[${l.level}] ${l.text}`).join('\n'), MAX_TEXT));
  }

  private failedRequests(guest: Guest, clear: boolean): ToolResult {
    const failed = [...guest.failed];
    if (clear) guest.failed = [];
    return textResult(failed.length === 0 ? '失敗した通信はありません' : clip(failed.join('\n'), MAX_TEXT));
  }

  // ---- 動かす ----

  private async click(sessionId: string, guest: Guest, selector: string, double: boolean, button: string): Promise<ToolResult> {
    const target = await this.locate(guest, selector);
    const before = guest.contents.getURL();
    await this.highlight(sessionId, target.rect);
    const { x, y } = center(target.rect);
    const pressButton = button === 'right' || button === 'middle' ? button : 'left';
    await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (let count = 1; count <= (double ? 2 : 1); count++) {
      await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: pressButton, clickCount: count });
      await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: pressButton, clickCount: count });
    }
    await settle(guest.contents);
    const lines = [`${double ? 'ダブルクリック' : 'クリック'}しました: ${target.description}`];
    if (target.covered) lines.push(`（押した位置には、ほかの要素 ${target.covered} が重なっていました）`);
    const after = guest.contents.getURL();
    if (after !== before) lines.push(`ページが移りました: ${after}${this.allowed(after) ? '' : '（Claude に許していない先なので、これ以上は読めず、操作もできません）'}`);
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
    if (args.clear === true) {
      // 欄の文字を全部選んでから消す（ページには、ふつうの削除として届く）
      await this.world(
        guest,
        `(() => {
          const el = document.activeElement;
          if (el && typeof el.select === 'function') el.select();
          else if (el && el.isContentEditable) getSelection().selectAllChildren(el);
        })()`,
      );
      await this.key(guest, 'Backspace', []);
    }
    if (text) await this.cdp(guest, 'Input.insertText', { text });
    if (args.submit === true) await this.key(guest, 'Enter', []);
    await settle(guest.contents);
    return textResult(`${where}に入力しました${args.submit === true ? '（Enter も押しました）' : ''}`);
  }

  private async pressKey(guest: Guest, key: string, modifiers: string[]): Promise<ToolResult> {
    await this.key(guest, key, modifiers);
    await settle(guest.contents);
    return textResult(`${[...modifiers, key].join('+')} を押しました`);
  }

  private async key(guest: Guest, name: string, modifiers: string[]): Promise<void> {
    const spec = keySpec(name);
    if (!spec) throw new ToolError(`知らないキーです: ${name}`);
    const bits = modifiers.reduce((sum, m) => sum | (MODIFIER_BITS[m] ?? 0), 0);
    // Ctrl・⌘ と一緒に押すときは、文字を入れない
    const text = bits & (MODIFIER_BITS.control | MODIFIER_BITS.meta) ? undefined : spec.text;
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers: bits };
    await this.cdp(guest, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.cdp(guest, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  private async scroll(guest: Guest, selector: string | undefined, deltaX: number, deltaY: number): Promise<ToolResult> {
    if (!selector && !deltaX && !deltaY) throw new ToolError('selector か deltaX・deltaY を渡してください');
    const position = (await this.world(
      guest,
      `(() => {
        const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
        ${selector ? `if (!target) return null; target.scrollIntoView({ block: 'center', inline: 'nearest' });` : ''}
        const dx = ${deltaX}, dy = ${deltaY};
        let scroller = document.scrollingElement || document.documentElement;
        if (dx || dy) {
          // 真ん中（selector があればその要素）から上へたどって、動かせる入れ物を探す
          let el = target || document.elementFromPoint(innerWidth / 2, innerHeight / 2);
          for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
            const cs = getComputedStyle(el);
            const canY = dy && /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight;
            const canX = dx && /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth;
            if (canY || canX) { scroller = el; break; }
          }
          scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        }
        return { x: Math.round(scroller.scrollLeft), y: Math.round(scroller.scrollTop), page: scroller === (document.scrollingElement || document.documentElement) };
      })()`,
    )) as { x: number; y: number; page: boolean } | null;
    if (!position) throw new ToolError(`「${selector}」に当たる要素がありません`);
    return textResult(`スクロールしました（${position.page ? 'ページ' : '中の入れ物'}の位置: x=${position.x} y=${position.y}）`);
  }

  private async waitFor(guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const selector = optionalString(args.selector);
    const text = optionalString(args.text);
    if (!selector && !text) throw new ToolError('selector か text を渡してください');
    const state = optionalString(args.state) ?? 'visible';
    const timeout = Math.min(Math.max(numberOr(args.timeoutMs, 10_000), 0), 30_000);
    const check = `(() => {
      const state = ${JSON.stringify(state)};
      let el = null;
      ${selector ? `el = document.querySelector(${JSON.stringify(selector)});` : ''}
      ${
        text
          ? `if (!${selector ? 'el' : 'false'}) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const want = ${JSON.stringify(text)};
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(want)) { el = n.parentElement; break; }
      }`
          : ''
      }
      const visible = !!el && (() => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; })();
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
    if (!(width in VIEWPORTS)) throw new ToolError(`表示幅は full・mobile・tablet のどれかです: ${width}`);
    this.deps.send(this.deps.channels.viewport, { sessionId, width: VIEWPORTS[width] });
    // 画面が webview の幅を変えて、ページが描き直すのを待つ
    await sleep(400);
    const viewport = await this.viewport(guest);
    return textResult(`表示幅を ${width} にしました（ページの幅 ${viewport.width}px・高さ ${viewport.height}px）`);
  }

  private async evaluate(guest: Guest, expression: string): Promise<ToolResult> {
    let value: unknown;
    const logged = guest.console.length;
    try {
      value = await guest.contents.executeJavaScript(expression);
    } catch (error) {
      // 投げられたエラーの中身は、例外には入らずコンソールに出る（届くのを少し待つ）
      await sleep(100);
      const thrown = guest.console.slice(logged).filter((l) => l.level === 'error').map((l) => l.text);
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

  // 開いているページ。開いていない・許していない先なら、理由を添えて断る
  private current(sessionId: string): Guest {
    const guest = this.guests.get(sessionId);
    if (!guest || guest.contents.isDestroyed()) throw new ToolError('このセッションのアプリ内ブラウザで、まだページを開いていません。navigate で開いてください');
    this.checkUrl(guest.contents.getURL(), '今のページ');
    return guest;
  }

  private allowed(url: string): boolean {
    return isClaudeAllowedUrl(url, this.deps.extraHosts());
  }

  private checkUrl(url: string, what: string): void {
    if (this.allowed(url)) return;
    throw new ToolError(
      `${what}（${url}）は、Claude に許していない先です。Claude が開けるのは localhost・127.0.0.1・*.local と、ユーザーが tanacode のメニュー（tanacode → アプリ内ブラウザで Claude に許す先…）で足した先だけです。必要なら、ユーザーに足してもらってください`,
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

  private async cdp(guest: Guest, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const dbg = guest.contents.debugger;
    if (!guest.cdp || !dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch (error) {
        if (!dbg.isAttached()) throw new ToolError(`ページを操作する準備ができませんでした（${error instanceof Error ? error.message : String(error)}）`);
      }
      guest.cdp = true;
    }
    return dbg.sendCommand(method, params);
  }

  private async viewport(guest: Guest): Promise<{ width: number; height: number; dpr: number }> {
    return (await this.world(guest, '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })')) as { width: number; height: number; dpr: number };
  }

  // セレクタに当たる要素のうち、見えている最初のものを、見える位置まで動かして、その位置を返す
  private async locate(guest: Guest, selector: string): Promise<{ rect: BrowserRect; viewport: { width: number; height: number }; description: string; covered: string | null }> {
    const found = (await this.world(
      guest,
      `(() => {
        let all;
        try { all = [...document.querySelectorAll(${JSON.stringify(selector)})]; } catch (e) { return { error: 'セレクタの書き方が違います: ' + e.message }; }
        if (all.length === 0) return { error: 'none' };
        const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
        const el = all.find(shown);
        if (!el) return { error: 'hidden', count: all.length };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
        return {
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          viewport: { width: innerWidth, height: innerHeight },
          description: name(el) + (text ? '「' + text + '」' : ''),
          covered: top && top !== el && !el.contains(top) && !top.contains(el) ? name(top) : null,
        };
      })()`,
    )) as { error?: string; count?: number; rect: BrowserRect; viewport: { width: number; height: number }; description: string; covered: string | null };
    if (found.error === 'none') throw new ToolError(`「${selector}」に当たる要素がありません`);
    if (found.error === 'hidden') throw new ToolError(`「${selector}」に当たる要素（${found.count} 個）は、どれも見えていません`);
    if (found.error) throw new ToolError(found.error);
    return found;
  }

  // 押す要素に枠を出す（ブラウザを見ているユーザーに、どこを押すかを見せる）
  private async highlight(sessionId: string, rect: BrowserRect): Promise<void> {
    this.emit({ sessionId, active: true, label: null, box: rect });
    await sleep(HIGHLIGHT_MS);
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

  private guestByContents(id: number): Guest | undefined {
    for (const guest of this.guests.values()) if (!guest.contents.isDestroyed() && guest.contents.id === id) return guest;
    return undefined;
  }

  private trimFailed(contentsId: number): void {
    const guest = this.guestByContents(contentsId);
    if (guest && guest.failed.length > MAX_FAILED) guest.failed.splice(0, guest.failed.length - MAX_FAILED);
  }
}

// ---- 小さな部品 ----

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
