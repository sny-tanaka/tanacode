import { useCallback, useEffect } from 'react';
import type { StatusLineInfo } from '@shared/statusline';
import { useSessionValues } from '../sessionValues';

// セッションごとの statusLine（モデル・コンテキスト・利用枠）。応答のたびに更新される。描き直すのは選択中のセッションが変わったときだけ
export function useSessionStatusLine(selectedId: string | null): {
  statusLineOf: (sessionId: string | null) => StatusLineInfo | null;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<StatusLineInfo, null>(selectedId, null);
  useEffect(
    () => window.tanacode.statusLine.onChanged(({ sessionId, info }) => update(sessionId, (prev) => (prev && sameShown(prev, info) ? prev : info))),
    [update],
  );
  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.statusLine.get(sessionId).then((info) => info && update(sessionId, (prev) => prev ?? info));
    },
    [update],
  );
  return { statusLineOf: valueOf, load };
}

// 画面が使うもの（モデル・エフォート・コンテキスト）が同じか。応答のたびに時刻と料金だけが変わって届くので、同じなら前のものを使い回す
// （App を描き直さない）。画面でほかの値を使うときは、ここに足す
function sameShown(a: StatusLineInfo, b: StatusLineInfo): boolean {
  return a.model?.id === b.model?.id && a.model?.name === b.model?.name && a.effort === b.effort && JSON.stringify(a.context) === JSON.stringify(b.context);
}
