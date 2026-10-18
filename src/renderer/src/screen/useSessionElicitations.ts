import { useCallback, useEffect } from 'react';
import type { PendingElicitation } from '@shared/elicitation';
import { useSessionValues } from '../sessionValues';

// セッションごとの、MCP サーバーから人への質問（フォーム・URL のカード。完了を待っている URL の形の質問も）。
// 描き直すのは選択中のセッションが変わったときだけ
export function useSessionElicitations(selectedId: string | null): {
  elicitationOf: (sessionId: string | null) => PendingElicitation | null;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<PendingElicitation | null, null>(selectedId, null);

  useEffect(() => window.tanacode.elicitation.onChanged(({ sessionId, elicitation }) => update(sessionId, () => elicitation)), [update]);

  const load = useCallback(
    (sessionId: string) => {
      // 読み込みの返事より先に届いた知らせ（もっと新しい質問・答えたあとの null）を、古い返事で上書きしない
      void window.tanacode.elicitation.get(sessionId).then((elicitation) => update(sessionId, (prev) => (prev === undefined ? elicitation : prev)));
    },
    [update],
  );

  return { elicitationOf: valueOf, load };
}
