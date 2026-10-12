import { useEffect, useRef, useState } from 'react';
import type { SessionContext } from '@shared/context';

// 取り直すまで待つ時間（応答やツールの結果が続くときに、何度も取り直さない）
const RELOAD_DELAY_MS = 300;

// コンテキストの中身。見えている間だけ取りに行き、使用量が変わったら（応答のたび・圧縮のあと）と、
// チャットが変わったら（revision。発言・ツールの結果・巻き戻し）取り直す
export function useSessionContext(sessionId: string, visible: boolean, revision: number): SessionContext | null {
  const [context, setContext] = useState<SessionContext | null>(null);
  const [changes, setChanges] = useState(0);
  const loaded = useRef(false);
  useEffect(
    () =>
      window.tanacode.knowledge.onChanged((payload) => {
        if (payload.sessionId === sessionId) setChanges((n) => n + 1);
      }),
    [sessionId],
  );
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const timer = setTimeout(
      () =>
        void window.tanacode.context.get(sessionId).then((value) => {
          if (!alive || !value) return;
          loaded.current = true;
          setContext(value);
        }),
      loaded.current ? RELOAD_DELAY_MS : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [sessionId, visible, revision, changes]);
  return context;
}
