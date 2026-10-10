import { useCallback, useRef, useState, type RefObject } from 'react';
import { t } from '@shared/i18n';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';

// 幅を変えられるカラム。エディタ（残りの幅）は含めない
export type Column = 'sessions' | 'claude' | 'side';
export type ColumnWidths = Record<Column, number>;

const DEFAULTS: ColumnWidths = { sessions: 248, claude: 400, side: 284 };
const LIMITS: Record<Column, [number, number]> = { sessions: [180, 440], claude: [320, 960], side: [220, 600] };
// エディタに最低限残す幅
const MIN_CENTER = 360;
const STORAGE_KEY = 'tanacode.columns';

function load(): ColumnWidths {
  try {
    const saved = JSON.parse(readSharedPref(STORAGE_KEY) ?? '{}') as Partial<ColumnWidths>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

function clamp(widths: ColumnWidths, column: Column, width: number): number {
  const [min, max] = LIMITS[column];
  const others = Object.entries(widths).reduce((sum, [c, w]) => (c === column ? sum : sum + w), 0);
  const room = window.innerWidth - others - MIN_CENTER;
  return Math.round(Math.max(min, Math.min(max, room, width)));
}

// カラムの幅。ドラッグで変え、次回起動時も保つ。どのプロファイルの画面でも同じ幅にする（sharedPrefs）。
// ドラッグ中は、幅の CSS 変数（--w-sessions など）を持つ要素（mainRef）を直接書き換え、離したときに状態に入れる。
// ドラッグ中に状態を変えると、pointermove のたびに画面全体が描き直されるため
export function useColumnWidths(): {
  widths: ColumnWidths;
  mainRef: RefObject<HTMLDivElement | null>;
  resize: (column: Column, width: number) => void;
  reset: (column: Column) => void;
  save: () => void;
} {
  const [widths, setWidths] = useState<ColumnWidths>(load);
  const latest = useRef(widths);
  latest.current = widths;
  const mainRef = useRef<HTMLDivElement>(null);
  // ドラッグ中の幅（まだ状態に入れていないもの）
  const draft = useRef<ColumnWidths | null>(null);

  const resize = useCallback((column: Column, width: number) => {
    const base = draft.current ?? latest.current;
    const next = clamp(base, column, width);
    if (base[column] === next) return;
    draft.current = { ...base, [column]: next };
    mainRef.current?.style.setProperty(`--w-${column}`, `${next}px`);
  }, []);
  const save = useCallback(() => {
    if (draft.current) {
      latest.current = draft.current;
      setWidths(draft.current);
      draft.current = null;
    }
    writeSharedPref(STORAGE_KEY, JSON.stringify(latest.current));
  }, []);
  useSharedPrefChange(STORAGE_KEY, () => setWidths(load()));
  const reset = useCallback(
    (column: Column) => {
      setWidths((prev) => ({ ...prev, [column]: DEFAULTS[column] }));
      requestAnimationFrame(save);
    },
    [save],
  );
  return { widths, mainRef, resize, reset, save };
}

// カラムの右端のつまみ。ドラッグで幅を変え、ダブルクリックで元の幅に戻す
export function Resizer({
  width,
  onResize,
  onReset,
  onEnd,
}: {
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
  onEnd: () => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      title={t('app.resizer.tip')}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (drag.current) onResize(drag.current.width + e.clientX - drag.current.x);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        drag.current = null;
        document.body.classList.remove('resizing');
        onEnd();
      }}
      onDoubleClick={onReset}
    />
  );
}
