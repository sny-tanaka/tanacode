import { useCallback, useEffect } from 'react';
import type { PendingPermission } from '@shared/questions';
import { useSessionValues } from '../sessionValues';

// セッションごとの、Claude Code が答えを待っている質問でない要求（許可の確認・プランの承認のカード）。
// 描き直すのは選択中のセッションが変わったときだけ
export function useSessionPermissions(selectedId: string | null): {
  permissionOf: (sessionId: string | null) => PendingPermission | null;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<PendingPermission | null, null>(selectedId, null);

  useEffect(() => window.tanacode.permission.onChanged(({ sessionId, permission }) => update(sessionId, () => permission)), [update]);

  const load = useCallback(
    (sessionId: string) => {
      // 読み込みの返事より先に届いた知らせ（もっと新しい要求・答えたあとの null）を、古い返事で上書きしない
      void window.tanacode.permission.get(sessionId).then((permission) => update(sessionId, (prev) => (prev === undefined ? permission : prev)));
    },
    [update],
  );

  return { permissionOf: valueOf, load };
}
