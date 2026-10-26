import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// 右クリックのメニューの項目。'separator' は区切りの線。tip は、ホバーで出す補足（押せない項目なら、押せないわけ）
export type ContextMenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; tip?: string } | 'separator';

// 右クリックした位置に出すメニュー。画面からはみ出すときは内側に寄せる。外を押す・Esc・ウインドウを離れると閉じる。
// 親のスクロールやはみ出しの切り取りを受けないよう、body に出す。
// anchor は、メニューを開いたボタン。そこを押したときは外を押したことにせず、ボタンの側で閉じさせる（閉じてすぐ開き直さないように）
// focusFirst は、キーで開いたとき。最初の項目にフォーカスし、閉じたら開く前の場所（行など）にフォーカスを戻す。
// 中にフォーカスがあれば、↑↓ で項目を移り、Enter で実行する（項目はボタンなので、Enter はそのまま押したことになる）
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  anchor,
  focusFirst,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  anchor?: HTMLElement | null;
  focusFirst?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  useLayoutEffect(() => {
    if (!focusFirst) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current!.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => {
      // 項目を選んで、ほかの場所（名前を入れる欄など）にフォーカスが移ったときは、そちらに任せる
      const now = document.activeElement;
      if (back?.isConnected && (!now || now === document.body || ref.current?.contains(now))) back.focus();
    };
    // 開いたときだけ（位置が変わっても、フォーカスは動かさない）
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && ref.current?.contains(document.activeElement)) {
        e.preventDefault();
        const buttons = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
        const at = buttons.indexOf(document.activeElement as HTMLElement);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        buttons[(at + step + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, anchor]);

  // 区切りは、項目と項目の間にあるものだけを出す（出せる項目が場所によって変わるため）
  const shown: ContextMenuItem[] = [];
  for (const item of items) {
    if (item !== 'separator') shown.push(item);
    else if (shown.length > 0 && shown[shown.length - 1] !== 'separator') shown.push(item);
  }
  if (shown[shown.length - 1] === 'separator') shown.pop();

  return createPortal(
    <div ref={ref} className="context-menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {shown.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            data-tip={item.tip}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
