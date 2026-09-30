import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// アイコンだけのボタンに、ホバーで名前を出す。ボタンに data-tip="名前" を付けると出る（改行も使える）。
// 出す向きは data-tip-side（bottom・top・left・right。既定は bottom）で、画面からはみ出すときは反対側に出す。
// title（OS のツールチップ）は出るまでが遅く、アプリのウィンドウが前面にないと出ないので、アイコンのボタンではこちらを使う。
// アプリに 1 つだけ置き、document のホバーとフォーカスを見て出す

type Side = 'bottom' | 'top' | 'left' | 'right';
type Shown = { text: string; side: Side; rect: DOMRect };

// ホバーしてから出すまで。一度出したあとしばらくは、隣のボタンに移ったらすぐ出す
const SHOW_DELAY_MS = 350;
const WARM_MS = 600;
// ボタンとの間・画面の端との間
const GAP = 6;
const MARGIN = 8;

const OPPOSITE: Record<Side, Side> = { bottom: 'top', top: 'bottom', left: 'right', right: 'left' };

function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null;
}

function place(side: Side, rect: DOMRect, width: number, height: number): { left: number; top: number } {
  switch (side) {
    case 'bottom':
      return { left: rect.left + rect.width / 2 - width / 2, top: rect.bottom + GAP };
    case 'top':
      return { left: rect.left + rect.width / 2 - width / 2, top: rect.top - GAP - height };
    case 'left':
      return { left: rect.left - GAP - width, top: rect.top + rect.height / 2 - height / 2 };
    case 'right':
      return { left: rect.right + GAP, top: rect.top + rect.height / 2 - height / 2 };
  }
}

function fits(pos: { left: number; top: number }, width: number, height: number): boolean {
  return pos.left >= MARGIN && pos.top >= MARGIN && pos.left + width <= innerWidth - MARGIN && pos.top + height <= innerHeight - MARGIN;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text) return;
      setShown({ text, side: (el.dataset.tipSide as Side | undefined) ?? 'bottom', rect: el.getBoundingClientRect() });
    };
    const enter = (el: HTMLElement) => {
      if (el === current) return;
      clearTimeout(timer);
      current = el;
      if (Date.now() - hiddenAt < WARM_MS) show(el);
      else timer = setTimeout(() => current === el && show(el), SHOW_DELAY_MS);
    };
    const leave = () => {
      clearTimeout(timer);
      if (current) hiddenAt = Date.now();
      current = null;
      setShown(null);
    };
    const onOver = (e: Event) => {
      const el = tipTarget(e.target);
      if (el) enter(el);
      else if (current) leave();
    };
    // ボタンの外（ウィンドウの外も）に出たら消す
    const onOut = (e: PointerEvent) => {
      if (current && !current.contains(e.relatedTarget as Node | null)) leave();
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      // キーボードで選んだときだけ出す（クリックで選んだときは、ホバーで出ている）
      if (el && el.matches(':focus-visible')) enter(el);
    };
    // 押したら消す（押したあとの状態で名前が変わるボタンもある）
    const onDown = () => {
      clearTimeout(timer);
      setShown(null);
    };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', leave);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onDown, true);
    window.addEventListener('blur', leave);
    window.addEventListener('scroll', onDown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', leave);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onDown, true);
      window.removeEventListener('blur', leave);
      window.removeEventListener('scroll', onDown, true);
    };
  }, []);

  // 大きさを測ってから置く。はみ出すなら反対側に出し、それでもはみ出す分は画面の中に寄せる
  useLayoutEffect(() => {
    if (!shown || !bubble.current) return setPos(null);
    const { width, height } = bubble.current.getBoundingClientRect();
    let next = place(shown.side, shown.rect, width, height);
    if (!fits(next, width, height)) {
      const flipped = place(OPPOSITE[shown.side], shown.rect, width, height);
      if (fits(flipped, width, height)) next = flipped;
    }
    setPos({
      left: clamp(next.left, MARGIN, innerWidth - MARGIN - width),
      top: clamp(next.top, MARGIN, innerHeight - MARGIN - height),
    });
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={bubble}
      className="tooltip"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {shown.text}
    </div>,
    document.body,
  );
}
