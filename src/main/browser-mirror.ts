import type { WebContents } from 'electron';
import type { BrowserMirrorFrame, BrowserMirrorInput, BrowserMirrorOptions } from '../shared/ipc';

// スマホの画面に、Mac のアプリ内ブラウザのタブを映す（ミラーリング。Issue #464）。決めたこと:
// - スマホが「ミラーリング」を押したときだけ映す。Mac も、頼まれている間だけ送る（止めた・切れた・裏に回った・タブが消えたら止める）
// - 絵は、変わったときだけ JPEG で送る（CDP の Page.startScreencast。止まったページは送らない）。次の絵は、スマホが描き終えたと知らせ、
//   決めた間隔がたつまで受け取らない（ack を遅らせる）。節約モードは、間隔をあけて画質を下げる。動画（WebRTC）に置き換えられる形にしておく
// - 映すのは、頼んだ接続にだけ。1 つの接続が映すのは 1 つのタブ。1 つのタブの screencast は 1 本なので、別の接続が同じタブを映し始めたら、前の接続は止める
// - 絵は記録に残さない

// 絵の間隔（ms）と JPEG の画質。ふつう: 毎秒 5 枚まで / 節約: 毎秒 1 枚まで
export const MIRROR_MODES = {
  normal: { intervalMs: 200, quality: 70 },
  saver: { intervalMs: 1000, quality: 40 },
} as const;
// スマホが描き終えたと知らせてこないときに、次の絵を受け取るまでの長さ
export const MIRROR_DONE_TIMEOUT_MS = 3000;
// 送る絵の大きさの上限（画素）。スマホの値が壊れていても、大きすぎる絵を作らないように
const MAX_SIZE = 2400;

// main の BrowserControl から借りるもの。guest: セッションのタブの webContents（無ければ null）/
// connect: CDP をつなぐ（ほかの使い手と同じ debugger を共有する）/ keepDrawing: Mac の画面に、そのタブを描かせ続けさせる（見ていなくても）
export type MirrorHost = {
  guest(sessionId: string, tabId: string): WebContents | null;
  connect(sessionId: string, tabId: string): Promise<void>;
  keepDrawing(sessionId: string, tabId: string, on: boolean): void;
};

type Mirror = {
  clientId: string;
  sessionId: string;
  tabId: string;
  contents: WebContents;
  mode: (typeof MIRROR_MODES)[keyof typeof MIRROR_MODES];
  send: (frame: BrowserMirrorFrame) => void;
  // 受け取って、まだ ack していない絵（CDP の screencast のセッションの番号）と、スマホに送った時刻
  waiting: { ackId: number; sentAt: number } | null;
  // スマホが描き終えた（次を受け取ってよい）か、ack を待たせている時計
  timer: ReturnType<typeof setTimeout> | null;
  // 最後に送った絵の CSS の大きさ（スマホの押した位置をページの位置に直すのに使う）
  page: { width: number; height: number } | null;
  onMessage: (event: unknown, method: string, params: Record<string, unknown>) => void;
  onDetach: () => void;
};

export class BrowserMirror {
  private readonly mirrors = new Map<string, Mirror>();
  // 接続ごとの通し番号。start が CDP をつなぐのを待つ間に、止められた・次の start が来たら、待ったあとで分かるように
  private readonly turns = new Map<string, number>();

  constructor(
    private readonly host: MirrorHost,
    private readonly now: () => number = Date.now,
  ) {}

  // 映し始める。前に同じ接続が映していたものは止める。同じタブを別の接続が映していたら、そちらは止める。始められなければ false
  async start(clientId: string, sessionId: string, tabId: string, options: BrowserMirrorOptions, send: (frame: BrowserMirrorFrame) => void): Promise<boolean> {
    this.stop(clientId);
    const turn = this.turns.get(clientId) ?? 0;
    const contents = this.host.guest(sessionId, tabId);
    if (!contents) return false;
    await this.host.connect(sessionId, tabId);
    // 待っている間に止められた・次を頼まれた・タブが消えたら、何も付けずにやめる
    if (this.turns.get(clientId) !== turn || contents.isDestroyed()) return false;
    for (const other of [...this.mirrors.values()]) {
      if (other.sessionId === sessionId && other.tabId === tabId) this.stop(other.clientId, true, true);
    }
    const mode = MIRROR_MODES[options.saver ? 'saver' : 'normal'];
    const mirror: Mirror = {
      clientId,
      sessionId,
      tabId,
      contents,
      mode,
      send,
      waiting: null,
      timer: null,
      page: null,
      onMessage: (_event, method, params) => {
        if (method === 'Page.screencastFrame') this.frame(mirror, params);
      },
      onDetach: () => this.stop(clientId, true),
    };
    this.mirrors.set(clientId, mirror);
    contents.debugger.on('message', mirror.onMessage);
    contents.debugger.on('detach', mirror.onDetach);
    contents.once('destroyed', mirror.onDetach);
    this.host.keepDrawing(sessionId, tabId, true);
    const size = (value: number) => Math.max(1, Math.min(MAX_SIZE, Math.round(value)));
    try {
      await contents.debugger.sendCommand('Page.startScreencast', {
        format: 'jpeg',
        quality: mode.quality,
        maxWidth: size(options.width),
        maxHeight: size(options.height),
        everyNthFrame: 1,
      });
    } catch {
      this.stop(clientId, true);
      return false;
    }
    return true;
  }

  // 映すのをやめる。notify: スマホに、止まったことを知らせる（Mac の側の都合で止めたとき）/
  // handover: 同じタブを別の接続が引き継ぐ（描かせ続けるのを、切らずにそのまま渡す）
  stop(clientId: string, notify = false, handover = false): void {
    this.turns.set(clientId, (this.turns.get(clientId) ?? 0) + 1);
    const mirror = this.mirrors.get(clientId);
    if (!mirror) return;
    this.mirrors.delete(clientId);
    if (mirror.timer) clearTimeout(mirror.timer);
    if (!mirror.contents.isDestroyed()) {
      mirror.contents.debugger.removeListener('message', mirror.onMessage);
      mirror.contents.debugger.removeListener('detach', mirror.onDetach);
      mirror.contents.removeListener('destroyed', mirror.onDetach);
      if (mirror.contents.debugger.isAttached()) void mirror.contents.debugger.sendCommand('Page.stopScreencast').catch(() => undefined);
    }
    const stillWatched = [...this.mirrors.values()].some((m) => m.sessionId === mirror.sessionId && m.tabId === mirror.tabId);
    if (!handover && !stillWatched) this.host.keepDrawing(mirror.sessionId, mirror.tabId, false);
    if (notify) mirror.send({ stopped: true });
  }

  // 切れた接続のものを止める（live: つながっている接続の id）
  keep(live: ReadonlySet<string>): void {
    for (const clientId of [...this.mirrors.keys()]) if (!live.has(clientId)) this.stop(clientId);
    for (const clientId of [...this.turns.keys()]) if (!live.has(clientId) && !this.mirrors.has(clientId)) this.turns.delete(clientId);
  }

  // スマホが絵を描き終えた。決めた間隔がたったら、次を受け取る
  done(clientId: string): void {
    const mirror = this.mirrors.get(clientId);
    if (!mirror?.waiting) return;
    this.ackAfterInterval(mirror);
  }

  // 映しているタブ（その接続の。無ければ null）
  watching(clientId: string): { sessionId: string; tabId: string } | null {
    const mirror = this.mirrors.get(clientId);
    return mirror ? { sessionId: mirror.sessionId, tabId: mirror.tabId } : null;
  }

  // 映している接続の数
  count(): number {
    return this.mirrors.size;
  }

  // スマホの操作を、映しているタブに送る。x・y は、絵の中の位置（0〜1）
  async input(clientId: string, input: BrowserMirrorInput): Promise<void> {
    const mirror = this.mirrors.get(clientId);
    if (!mirror || mirror.contents.isDestroyed()) return;
    const send = (method: string, params: Record<string, unknown>) => mirror.contents.debugger.sendCommand(method, params).catch(() => undefined);
    const point = (x: number, y: number) => ({ x: x * (mirror.page?.width ?? 0), y: y * (mirror.page?.height ?? 0) });
    switch (input.type) {
      case 'tap': {
        if (!mirror.page) return;
        const { x, y } = point(input.x, input.y);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        return;
      }
      case 'scroll': {
        if (!mirror.page) return;
        const { x, y } = point(input.x, input.y);
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: input.deltaX * mirror.page.width, deltaY: input.deltaY * mirror.page.height });
        return;
      }
      case 'text':
        await send('Input.insertText', { text: input.text });
        return;
      case 'key': {
        const key = KEYS[input.key];
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: input.key, code: key.code, windowsVirtualKeyCode: key.keyCode, ...(key.text ? { text: key.text } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: input.key, code: key.code, windowsVirtualKeyCode: key.keyCode });
        return;
      }
    }
  }

  private frame(mirror: Mirror, params: Record<string, unknown>): void {
    if (this.mirrors.get(mirror.clientId) !== mirror) return;
    const ackId = typeof params.sessionId === 'number' ? params.sessionId : null;
    const data = typeof params.data === 'string' ? params.data : null;
    const metadata = (params.metadata ?? {}) as { deviceWidth?: unknown; deviceHeight?: unknown };
    if (ackId === null || data === null) return;
    const width = typeof metadata.deviceWidth === 'number' ? metadata.deviceWidth : 0;
    const height = typeof metadata.deviceHeight === 'number' ? metadata.deviceHeight : 0;
    mirror.page = width > 0 && height > 0 ? { width, height } : mirror.page;
    mirror.waiting = { ackId, sentAt: this.now() };
    mirror.send({ data, width, height });
    // スマホが知らせてこなくても、止まらないように
    if (mirror.timer) clearTimeout(mirror.timer);
    mirror.timer = setTimeout(() => this.ack(mirror), MIRROR_DONE_TIMEOUT_MS);
    mirror.timer.unref?.();
  }

  private ackAfterInterval(mirror: Mirror): void {
    if (!mirror.waiting) return;
    if (mirror.timer) clearTimeout(mirror.timer);
    const wait = Math.max(0, mirror.waiting.sentAt + mirror.mode.intervalMs - this.now());
    mirror.timer = setTimeout(() => this.ack(mirror), wait);
    mirror.timer.unref?.();
  }

  private ack(mirror: Mirror): void {
    mirror.timer = null;
    const waiting = mirror.waiting;
    mirror.waiting = null;
    if (!waiting || this.mirrors.get(mirror.clientId) !== mirror || mirror.contents.isDestroyed()) return;
    void mirror.contents.debugger.sendCommand('Page.screencastFrameAck', { sessionId: waiting.ackId }).catch(() => undefined);
  }
}

// スマホの補助のキー（文字のキーは text で送る）
const KEYS: Record<Extract<BrowserMirrorInput, { type: 'key' }>['key'], { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};

// スマホから届いた操作の形を確かめる（壊れた・知らない形は null）
export function sanitizeMirrorInput(raw: unknown): BrowserMirrorInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const delta = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10;
  switch (v.type) {
    case 'tap':
      return unit(v.x) && unit(v.y) ? { type: 'tap', x: v.x as number, y: v.y as number } : null;
    case 'scroll':
      return unit(v.x) && unit(v.y) && delta(v.deltaX) && delta(v.deltaY)
        ? { type: 'scroll', x: v.x as number, y: v.y as number, deltaX: v.deltaX as number, deltaY: v.deltaY as number }
        : null;
    case 'text':
      return typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 10000 ? { type: 'text', text: v.text } : null;
    case 'key':
      return typeof v.key === 'string' && Object.hasOwn(KEYS, v.key) ? { type: 'key', key: v.key as keyof typeof KEYS } : null;
    default:
      return null;
  }
}
