import type { BrowserWindow, NativeImage, Rectangle } from 'electron';
import type { BrowserPopupInput, BrowserPopupModifier, BrowserPopupPlace } from '../shared/ipc';

// ページが開いたポップアップの別ウインドウを、人には出さずに動かし、絵をアプリ内ブラウザのタブに映す（PreviewPane の PopupCanvas）。決めたこと:
// - 別ウインドウは作るが出さない（tanacode の上に別ウインドウが出て、チャットの邪魔にならないように）。開いたページとのつながり（window.opener）は、
//   ふつうの別ウインドウと同じに残る（OAuth のログインの窓のため）。WebContentsView でアプリの画面に重ねる作りは使わない（アプリの画面の部品が隠れる）。
//   オフスクリーン描画（offscreen: true）は、window.open で開いた中身では、絵が届かず、操作も効かなかった（Electron 45.2.1 で確かめた）
// - 絵は beginFrameSubscription で受け取る（見えない別ウインドウでも描かれる。capturePage は、見えない別ウインドウで返ってこないことがあった）。
//   macOS では、変わったところだけを頼んでも全体が届くので、いつも全体を送る。画面が描き終えたと知らせる（done）まで、次の絵は送らず、最新の 1 枚だけを持つ
// - 映している間は、別ウインドウを、画面の上で映している場所と同じ位置・大きさに置く（select の選択肢など、OS が別ウインドウの位置に出す部品が、
//   映している場所に出るように）
// - 映しきれないもの（select の選択肢・日付の入力など）は、人が「実物を開く」で別ウインドウを出して操作する（reveal）。出したあとは、人が動かせるよう、
//   映す場所に合わせて動かさない
// - 操作は sendInputEvent で送る。日本語の変換は画面の入力欄で受け、確定した文字を insertText で入れる。⌘C などの編集は、ページにメニューが無いので、ここで行う

// 映した絵。width・height: 画素の数 / scale: 1 CSS px あたりの画素の数 / data: 画素（BGRA）
export type PopupFrame = { width: number; height: number; scale: number; data: Buffer };

// 画面が描き終えたと知らせてこないときに、次の絵を送るまでの長さ（画面を作り直したなど）
const FRAME_DONE_TIMEOUT_MS = 1000;
// 映す大きさの上限（CSS の px）。画面の値が壊れていても、大きすぎるウインドウを作らないように
const MAX_PLACE = 10000;

export class PopupView {
  private listener: ((frame: PopupFrame) => void) | null = null;
  private cursor: ((cursor: string) => void) | null = null;
  // 画面に送って、描き終えたと知らせてくるのを待っている絵の送った時刻（待っていなければ null）と、その間に届いた最新の絵
  private sentAt: number | null = null;
  private pending: NativeImage | null = null;
  // 人が「実物を開く」で別ウインドウを出したか
  private shown = false;

  // host: tanacode のウインドウの中身の位置と大きさ（画面の上。分からなければ null）
  constructor(
    private readonly win: BrowserWindow,
    private readonly host: () => Rectangle | null,
  ) {
    win.webContents.on('cursor-changed', (_event, type: string) => this.cursor?.(type));
    win.once('closed', () => {
      this.listener = null;
      this.cursor = null;
      this.pending = null;
    });
  }

  // 人が別ウインドウを出したか（出したものは、ページが大きさや位置を変えるのも、ふつうの別ウインドウと同じに扱う）
  get revealed(): boolean {
    return this.shown;
  }

  // 映し始める・やめる（listener が null）。place: 映す場所（アプリの画面の中。CSS の px）
  watch(place: BrowserPopupPlace | null, listener: ((frame: PopupFrame) => void) | null, cursor: ((cursor: string) => void) | null): void {
    if (this.win.isDestroyed()) return;
    if (place) this.place(place);
    const contents = this.win.webContents;
    if (!listener) {
      if (this.listener) contents.endFrameSubscription();
      this.listener = null;
      this.cursor = null;
      this.pending = null;
      this.sentAt = null;
      return;
    }
    const started = this.listener !== null;
    this.listener = listener;
    this.cursor = cursor;
    if (started) return;
    this.sentAt = null;
    contents.beginFrameSubscription(false, (image) => this.deliver(image));
    // 変わらないページでも、最初の絵を描かせる
    contents.invalidate();
  }

  // 画面が絵を描き終えた。待っていた間に届いた絵があれば送る
  done(): void {
    this.sentAt = null;
    const next = this.pending;
    this.pending = null;
    if (next) this.send(next);
  }

  // 別ウインドウを出して前に出す（人がボタンを押したときだけ）
  reveal(): void {
    if (this.win.isDestroyed()) return;
    this.shown = true;
    this.win.show();
    this.win.focus();
  }

  // 人の操作を送る（sanitizePopupInput を通したもの）
  input(input: BrowserPopupInput): void {
    if (this.win.isDestroyed()) return;
    const contents = this.win.webContents;
    switch (input.type) {
      case 'mouseDown':
      case 'mouseUp':
        contents.sendInputEvent({ type: input.type, x: input.x, y: input.y, button: input.button, clickCount: input.clickCount, modifiers: input.modifiers });
        return;
      case 'mouseMove':
        contents.sendInputEvent({ type: 'mouseMove', x: input.x, y: input.y, modifiers: input.modifiers });
        return;
      case 'mouseLeave':
        contents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 });
        return;
      case 'mouseWheel':
        // DOM の wheel と Chromium の向きは逆（DOM は下へ送るのが正、Chromium は上へ送るのが正）
        contents.sendInputEvent({ type: 'mouseWheel', x: input.x, y: input.y, deltaX: -input.deltaX, deltaY: -input.deltaY, canScroll: true, modifiers: input.modifiers });
        return;
      case 'keyDown':
      case 'keyUp': {
        const keyCode = toKeyCode(input.key);
        if (!keyCode) return;
        contents.sendInputEvent({ type: input.type, keyCode, modifiers: input.modifiers });
        // 文字を打つキーは、文字も送る（keyDown だけでは入力欄に入らない）。⌃・⌘ との組み合わせは、文字を打たない
        if (input.type === 'keyDown' && printable(input.key) && !input.modifiers.includes('control') && !input.modifiers.includes('meta')) {
          contents.sendInputEvent({ type: 'char', keyCode: input.key, modifiers: input.modifiers });
        }
        return;
      }
      case 'insertText':
        void contents.insertText(input.text);
        return;
      case 'edit':
        contents[input.command]();
        return;
      case 'focus':
        // 出さずに、ページにフォーカスを渡す（document.hasFocus が true になり、入力欄に打てる）
        contents.focus();
        return;
    }
  }

  // 別ウインドウを、映している場所と同じ位置・大きさにする。人が出したものは動かさない
  private place(place: BrowserPopupPlace): void {
    if (this.shown) return;
    const width = Math.round(clamp(place.width, 1, MAX_PLACE));
    const height = Math.round(clamp(place.height, 1, MAX_PLACE));
    const host = this.host();
    const bounds = { x: Math.round((host?.x ?? 0) + place.x), y: Math.round((host?.y ?? 0) + place.y), width, height };
    const now = this.win.getContentBounds();
    if (now.x !== bounds.x || now.y !== bounds.y || now.width !== width || now.height !== height) this.win.setContentBounds(bounds);
  }

  private deliver(image: NativeImage): void {
    if (!this.listener) return;
    if (this.sentAt !== null && Date.now() - this.sentAt < FRAME_DONE_TIMEOUT_MS) {
      this.pending = image;
      return;
    }
    this.send(image);
  }

  private send(image: NativeImage): void {
    const listener = this.listener;
    if (!listener || this.win.isDestroyed() || image.isEmpty()) return;
    const { width, height } = image.getSize();
    const [contentWidth = 0] = this.win.getContentSize();
    this.sentAt = Date.now();
    listener({ width, height, scale: contentWidth > 0 ? width / contentWidth : 1, data: image.toBitmap() });
  }
}

// DOM の KeyboardEvent.key から、sendInputEvent の keyCode（Electron のアクセラレータのキーの名前）。送らないキーは null
const NAMED_KEYS: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
};
export function toKeyCode(key: string): string | null {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  return printable(key) ? key : null;
}

// 1 文字を打つキーか（「a」「あ」「@」。Shift などの名前の付いたキーは違う）
function printable(key: string): boolean {
  return [...key].length === 1;
}

const MODIFIERS: readonly BrowserPopupModifier[] = ['shift', 'control', 'alt', 'meta'];
const BUTTONS = ['left', 'middle', 'right'] as const;
const EDITS = ['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo'] as const;
// 一度に入れる文字の長さの上限（変換で確定した文字）
const MAX_TEXT = 10000;

// 画面から届いた操作を確かめる。形が違うものは null（送らない）
export function sanitizePopupInput(raw: unknown): BrowserPopupInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const modifiers = Array.isArray(input.modifiers) ? MODIFIERS.filter((m) => (input.modifiers as unknown[]).includes(m)) : [];
  const at = () => {
    const x = num(input.x);
    const y = num(input.y);
    return x === null || y === null ? null : { x: Math.round(clamp(x, -MAX_PLACE, MAX_PLACE)), y: Math.round(clamp(y, -MAX_PLACE, MAX_PLACE)) };
  };
  switch (input.type) {
    case 'mouseDown':
    case 'mouseUp': {
      const point = at();
      const button = BUTTONS.find((b) => b === input.button);
      const clickCount = num(input.clickCount);
      if (!point || !button) return null;
      return { type: input.type, ...point, button, clickCount: Math.round(clamp(clickCount ?? 1, 1, 3)), modifiers };
    }
    case 'mouseMove': {
      const point = at();
      return point ? { type: 'mouseMove', ...point, modifiers } : null;
    }
    case 'mouseLeave':
      return { type: 'mouseLeave' };
    case 'mouseWheel': {
      const point = at();
      const deltaX = num(input.deltaX);
      const deltaY = num(input.deltaY);
      if (!point || deltaX === null || deltaY === null) return null;
      return { type: 'mouseWheel', ...point, deltaX: clamp(deltaX, -MAX_PLACE, MAX_PLACE), deltaY: clamp(deltaY, -MAX_PLACE, MAX_PLACE), modifiers };
    }
    case 'keyDown':
    case 'keyUp':
      return typeof input.key === 'string' && toKeyCode(input.key) ? { type: input.type, key: input.key, modifiers } : null;
    case 'insertText':
      return typeof input.text === 'string' && input.text.length > 0 && input.text.length <= MAX_TEXT ? { type: 'insertText', text: input.text } : null;
    case 'edit': {
      const command = EDITS.find((c) => c === input.command);
      return command ? { type: 'edit', command } : null;
    }
    case 'focus':
      return { type: 'focus' };
    default:
      return null;
  }
}

// 映す場所を確かめる。形が違えば null（映すのをやめる扱い）
export function sanitizePopupPlace(raw: unknown): BrowserPopupPlace | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  const values = [x, y, width, height];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
