import { useCallback, useEffect } from 'react';
import type { ScreenInfo } from '@shared/screen';
import { useSessionValues } from '../sessionValues';

// セッションごとの、pty の画面から読み取った状態（選択メニューなど）。描き直すのは選択中のセッションが変わったときだけ
export function useSessionScreens(selectedId: string | null): {
  screenOf: (sessionId: string | null) => ScreenInfo | null;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<ScreenInfo, null>(selectedId, null);

  useEffect(() => window.tanacode.screen.onChanged(({ sessionId, info }) => update(sessionId, () => info)), [update]);

  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.screen.get(sessionId).then((info) => {
        if (info) update(sessionId, (prev) => prev ?? info);
      });
    },
    [update],
  );

  return { screenOf: valueOf, load };
}
