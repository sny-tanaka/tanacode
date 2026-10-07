import { useEffect, useRef, useState } from 'react';
import type { Walkthrough } from '@shared/walkthrough';

// セッションごとの今のウォークスルー（main がメモリに持つ。画面を作り直したときは読み直す）。
// onClaudeMove: Claude が示す場所を変えた（start_walkthrough・show_code）。prev: 変わる前のもの（追従するかを決めるのに使う）
export function useWalkthroughs(onClaudeMove: (sessionId: string, walkthrough: Walkthrough, prev: Walkthrough | null) => void): Record<string, Walkthrough> {
  const [walks, setWalks] = useState<Record<string, Walkthrough>>({});
  const walksRef = useRef(walks);
  walksRef.current = walks;
  const onMoveRef = useRef(onClaudeMove);
  onMoveRef.current = onClaudeMove;
  useEffect(() => {
    let alive = true;
    void window.tanacode.walkthrough.list().then(
      (list) => {
        if (!alive) return;
        setWalks((prev) => {
          const next = { ...prev };
          for (const { sessionId, walkthrough } of list) if (walkthrough && !next[sessionId]) next[sessionId] = walkthrough;
          return next;
        });
      },
      () => {},
    );
    const off = window.tanacode.walkthrough.onChanged(({ sessionId, walkthrough }) => {
      const prev = walksRef.current[sessionId] ?? null;
      const next = { ...walksRef.current };
      if (walkthrough) next[sessionId] = walkthrough;
      else delete next[sessionId];
      walksRef.current = next;
      setWalks(next);
      if (walkthrough?.movedBy === 'claude' && walkthrough.seq !== prev?.seq) onMoveRef.current(sessionId, walkthrough, prev);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return walks;
}
