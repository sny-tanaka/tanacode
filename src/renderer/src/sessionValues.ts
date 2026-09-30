import { useCallback, useRef, useState } from 'react';

// セッションごとの値（チャット・画面・タスクなど）。全セッションの分を持つが、描き直すのは
// 選択中のセッションの値が変わったときと、notable が真を返したとき（一覧の状態の表示に関わる変化など）だけにする。
// 裏で動いている別のセッションの出力が届くたびに、画面全体を描き直さないため
export function useSessionValues<T, E = T>(
  selectedId: string | null,
  empty: E,
  notable?: (prev: T | undefined, next: T) => boolean,
): {
  valueOf: (sessionId: string | null) => T | E;
  // 今の値を読む（描き直しを待たない。IPC の受け取りなどで使う）
  peek: (sessionId: string) => T | undefined;
  // 値を入れ替える。同じ値を返したら何もしない
  update: (sessionId: string, change: (prev: T | undefined) => T) => void;
} {
  const values = useRef<Record<string, T>>({});
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const notableRef = useRef(notable);
  notableRef.current = notable;
  const [version, setVersion] = useState(0);

  const update = useCallback((sessionId: string, change: (prev: T | undefined) => T) => {
    const prev = values.current[sessionId];
    const next = change(prev);
    if (next === prev) return;
    values.current = { ...values.current, [sessionId]: next };
    if (sessionId === selected.current || notableRef.current?.(prev, next)) setVersion((v) => v + 1);
  }, []);
  const peek = useCallback((sessionId: string) => values.current[sessionId], []);
  // version が変わったら（描き直すべき変化があったら）作り直す。依存に使っている部品や effect が動くように
  const valueOf = useCallback(
    (sessionId: string | null): T | E => (sessionId !== null && sessionId in values.current ? values.current[sessionId] : empty),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, empty],
  );
  return { valueOf, peek, update };
}
