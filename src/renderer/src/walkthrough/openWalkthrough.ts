import { useEffect, useRef } from 'react';
import type { WalkthroughToolTarget } from '@shared/walkthrough-tools';

// チャットのウォークスルーのツールの行から、今のウォークスルーや示した場所を開く。部品の奥から App まで props を通さずに済むよう、ここで受け渡す
const listeners = new Set<(target: WalkthroughToolTarget) => void>();

export function openWalkthroughTarget(target: WalkthroughToolTarget): void {
  for (const listener of listeners) listener(target);
}

// 開く側（App）。handler は描き直しのたびに変わってよい
export function useOpenWalkthroughTarget(handler: (target: WalkthroughToolTarget) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (target: WalkthroughToolTarget) => ref.current(target);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
