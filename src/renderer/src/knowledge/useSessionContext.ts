import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CompactMark, SessionContext } from '@shared/context';

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

// 圧縮で残す・捨てるの印（セッションごと）。セッションを切り替えても残す（アプリを終了すると消える）。
// 印は、付けたときの圧縮の区切り（epoch。今の要約の行の id）と一緒に覚え、圧縮が進んだら（ヘッダーの「圧縮」・自動の圧縮も）使わない
type SavedMarks = { epoch: string; marks: ReadonlyMap<string, CompactMark> };
const savedMarks = new Map<string, SavedMarks>();
const NO_MARKS: ReadonlyMap<string, CompactMark> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function saveMarks(sessionId: string, epoch: string, marks: ReadonlyMap<string, CompactMark>): void {
  if (marks.size === 0) savedMarks.delete(sessionId);
  else savedMarks.set(sessionId, { epoch, marks });
  for (const listener of listeners) listener();
}

export function useCompactMarks(
  sessionId: string,
  epoch: string,
): {
  marks: ReadonlyMap<string, CompactMark>;
  // 同じ印をもう一度押すと外す（Claude に任せる）
  toggle: (itemId: string, mark: CompactMark) => void;
  clear: () => void;
} {
  const current = useCallback(() => {
    const saved = savedMarks.get(sessionId);
    return saved && saved.epoch === epoch ? saved.marks : NO_MARKS;
  }, [sessionId, epoch]);
  const marks = useSyncExternalStore(subscribe, current);
  const toggle = useCallback(
    (itemId: string, mark: CompactMark) => {
      const next = new Map(current());
      if (next.get(itemId) === mark) next.delete(itemId);
      else next.set(itemId, mark);
      saveMarks(sessionId, epoch, next);
    },
    [sessionId, epoch, current],
  );
  const clear = useCallback(() => saveMarks(sessionId, epoch, NO_MARKS), [sessionId, epoch]);
  return { marks, toggle, clear };
}
