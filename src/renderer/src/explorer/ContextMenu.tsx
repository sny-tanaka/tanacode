import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// 右クリックのメニューの項目。'separator' は区切りの線
export type ContextMenuItem = { label: string; onSelect: () => void; danger?: boolean } | 'separator';

// 右クリックした位置に出すメニュー。画面からはみ出すときは内側に寄せる。外を押す・Esc・ウインドウを離れると閉じる。
// 親のスクロールやはみ出しの切り取りを受けないよう、body に出す
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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
  }, [onClose]);

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
