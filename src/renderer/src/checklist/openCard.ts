import { useEffect, useRef } from 'react';

// チャットの知らせやツールの行から、チェックリストのカードを開く。部品の奥から App まで props を通さずに済むよう、ここで受け渡す。
// id で指すか（知らせ）、リストの名前と番号で指す（ツールの入力）
export type CardTarget = { listId: string; cardId: string } | { list: string; number: number };

const listeners = new Set<(target: CardTarget) => void>();

export function openChecklistCard(target: CardTarget): void {
  for (const listener of listeners) listener(target);
}

// 開く側（App）。handler は描き直しのたびに変わってよい
export function useOpenChecklistCard(handler: (target: CardTarget) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (target: CardTarget) => ref.current(target);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
