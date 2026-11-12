import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserPopupFrame, BrowserPopupInput, BrowserPopupModifier } from '@shared/ipc';
import { t } from '@shared/i18n';

// ページが開いたポップアップの絵を映し、人の操作を送る（main の browser-popup-view.ts）。
// ポップアップの別ウインドウは人には出さずに動いていて、映している間だけ絵が届く。映す大きさは、この場所の大きさ（main が別ウインドウをこの大きさにする）。
// 映しきれないもの（select の選択肢など）のために、実物の別ウインドウを出すボタンを添える。
// キーと日本語の変換は、見えない入力欄で受ける（変換中の文字はこの入力欄に出し、確定した文字をページに入れる）
export function PopupCanvas({ sessionId, tabId, visible }: { sessionId: string; tabId: string; visible: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState('default');
  // 入力欄を置く位置（最後に押した位置。日本語の変換の候補が、押した近くに出るように）
  const [caret, setCaret] = useState({ x: 0, y: 0 });
  // 日本語の変換の途中か（変換中の文字を、入力欄に出す）
  const [composing, setComposing] = useState(false);
  const send = (input: BrowserPopupInput) => window.tanacode.browser.popupInput(sessionId, tabId, input);

  // 絵とカーソルの形を受ける
  useEffect(() => {
    const offs = [
      window.tanacode.browser.onPopupFrame((frame) => {
        if (frame.sessionId !== sessionId || frame.tabId !== tabId) return;
        const canvas = canvasRef.current;
        if (canvas) draw(canvas, frame);
        window.tanacode.browser.popupFrameDone(sessionId, tabId);
      }),
      window.tanacode.browser.onPopupCursor((change) => {
        if (change.sessionId === sessionId && change.tabId === tabId) setCursor(cssCursor(change.cursor));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [sessionId, tabId]);

  // 見えている間は、映す場所を main に知らせる（大きさが変わったら、そのたびに）。隠れたらやめる
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!visible || !box) return;
    let last = '';
    const place = () => {
      const rect = box.getBoundingClientRect();
      const next = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      const key = JSON.stringify(next);
      if (key === last || next.width <= 0 || next.height <= 0) return;
      last = key;
      window.tanacode.browser.viewPopup(sessionId, tabId, next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(box);
    // ペインの境目を動かしたときなど、大きさが変わらずに位置だけ変わることもある
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.tanacode.browser.viewPopup(sessionId, tabId, null);
    };
  }, [visible, sessionId, tabId]);

  // 絵の左上からの位置（CSS の px。絵は、ポップアップの中身と同じ大きさで描いている）
  const at = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top) };
  };

  return (
    <div className="preview-popup">
      <div className="preview-hint preview-popup-hint">
        <span>{t('preview.popup.hint')}</span>
        <button type="button" className="ghost-button" onClick={() => window.tanacode.browser.revealPopup(sessionId, tabId)}>
          {t('preview.popup.reveal')}
        </button>
      </div>
      <div className="preview-popup-box" ref={boxRef}>
        <canvas
          ref={canvasRef}
          className="preview-popup-canvas"
          style={{ cursor }}
          onMouseDown={(e) => {
            // 絵の選択や、アプリの画面のフォーカスの移り変わりを起こさず、入力欄にフォーカスを置く
            e.preventDefault();
            const point = at(e);
            setCaret(point);
            inputRef.current?.focus();
            send({ type: 'focus' });
            send({ type: 'mouseDown', ...point, button: buttonOf(e.button), clickCount: Math.max(1, e.detail), modifiers: modifiersOf(e) });
          }}
          onMouseUp={(e) => send({ type: 'mouseUp', ...at(e), button: buttonOf(e.button), clickCount: Math.max(1, e.detail), modifiers: modifiersOf(e) })}
          onMouseMove={(e) => send({ type: 'mouseMove', ...at(e), modifiers: modifiersOf(e) })}
          onMouseLeave={() => send({ type: 'mouseLeave' })}
          onWheel={(e) => send({ type: 'mouseWheel', ...at(e), deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) })}
          onContextMenu={(e) => e.preventDefault()}
        />
        <textarea
          ref={inputRef}
          className={`preview-popup-input${composing ? ' composing' : ''}`}
          style={{ left: caret.x, top: caret.y }}
          aria-label={t('preview.popup.badge')}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => {
            // 日本語の変換の間は、入力欄に任せる（確定した文字は compositionend で送る）
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            const command = editCommand(e);
            if (command) {
              e.preventDefault();
              send({ type: 'edit', command });
              return;
            }
            // ⌘・⌃ を使うほかの組み合わせは、アプリのショートカットに任せる（ページには送らない）
            if (e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            send({ type: 'keyDown', key: e.key, modifiers: modifiersOf(e) });
          }}
          onKeyUp={(e) => {
            if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey) return;
            send({ type: 'keyUp', key: e.key, modifiers: modifiersOf(e) });
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => {
            setComposing(false);
            if (e.data) send({ type: 'insertText', text: e.data });
            e.currentTarget.value = '';
          }}
          onInput={(e) => {
            if (!(e.nativeEvent as InputEvent).isComposing) e.currentTarget.value = '';
          }}
        />
      </div>
    </div>
  );
}

// 絵を描く。画素は BGRA の順なので、RGBA に並べ替える。CSS の大きさは、ポップアップの中身と同じ（画素の数 ÷ scale）
function draw(canvas: HTMLCanvasElement, frame: BrowserPopupFrame): void {
  const { width, height, scale, data } = frame;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${width / scale}px`;
  canvas.style.height = `${height / scale}px`;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = data[i + 2]!;
    rgba[i + 1] = data[i + 1]!;
    rgba[i + 2] = data[i]!;
    rgba[i + 3] = data[i + 3]!;
  }
  canvas.getContext('2d')?.putImageData(new ImageData(rgba, width, height), 0, 0);
}

function buttonOf(button: number): 'left' | 'middle' | 'right' {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
}

function modifiersOf(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): BrowserPopupModifier[] {
  return [...(e.shiftKey ? ['shift' as const] : []), ...(e.ctrlKey ? ['control' as const] : []), ...(e.altKey ? ['alt' as const] : []), ...(e.metaKey ? ['meta' as const] : [])];
}

// ⌘C などの編集のショートカット（ページにメニューが無いので、main が行う）
function editCommand(e: React.KeyboardEvent): Extract<BrowserPopupInput, { type: 'edit' }>['command'] | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key.toLowerCase()) {
    case 'c':
      return 'copy';
    case 'x':
      return 'cut';
    case 'v':
      return 'paste';
    case 'a':
      return 'selectAll';
    case 'z':
      return e.shiftKey ? 'redo' : 'undo';
    default:
      return null;
  }
}

// Electron の cursor-changed の type から、CSS の cursor。CSS に同じ名前が無いものは、ふつうの矢印
const CSS_CURSORS = new Set([
  'default', 'crosshair', 'pointer', 'move', 'text', 'wait', 'help', 'progress', 'cell', 'context-menu', 'alias', 'copy', 'none', 'not-allowed',
  'vertical-text', 'zoom-in', 'zoom-out', 'grab', 'grabbing', 'e-resize', 'n-resize', 'ne-resize', 'nw-resize', 's-resize', 'se-resize', 'sw-resize',
  'w-resize', 'ns-resize', 'ew-resize', 'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize', 'all-scroll',
]);
export function cssCursor(type: string): string {
  if (type === 'hand') return 'pointer';
  if (type === 'nodrop') return 'no-drop';
  return CSS_CURSORS.has(type) ? type : 'default';
}
