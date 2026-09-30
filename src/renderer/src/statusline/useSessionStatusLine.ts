import { useCallback, useEffect } from 'react';
import type { StatusLineInfo } from '@shared/statusline';
import { useSessionValues } from '../sessionValues';

// セッションごとの statusLine（モデル・コンテキスト・利用枠）。応答のたびに更新される。描き直すのは選択中のセッションが変わったときだけ
export function useSessionStatusLine(selectedId: string | null): {
  statusLineOf: (sessionId: string | null) => StatusLineInfo | null;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<StatusLineInfo, null>(selectedId, null);
  useEffect(() => window.tanacode.statusLine.onChanged(({ sessionId, info }) => update(sessionId, () => info)), [update]);
  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.statusLine.get(sessionId).then((info) => info && update(sessionId, (prev) => prev ?? info));
    },
    [update],
  );
  return { statusLineOf: valueOf, load };
}
