import { useSyncExternalStore } from 'react';

export type CursorPosition = { line: number; column: number } | null;

// エディタのカーソル位置。1 キーごとに変わるので App の状態には置かず、表示する部品（ステータスバー）だけが読む
let current: CursorPosition = null;
const listeners = new Set<() => void>();

export function setCursor(position: CursorPosition): void {
  if (current?.line === position?.line && current?.column === position?.column) return;
  current = position;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCursor(): CursorPosition {
  return useSyncExternalStore(subscribe, () => current);
}
