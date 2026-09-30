import { useCallback, useEffect, useState } from 'react';

// macOS の通知を出すか（タイトルバーのベル）。設定を読み込むまでは null。
// 切り替えはすぐ画面に反映し、保存できなかったら元に戻す
export function useNotifications(): [boolean | null, (on: boolean) => void] {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void window.tanacode.notifications.get().then((value) => alive && setOn(value !== false));
    return () => {
      alive = false;
    };
  }, []);
  const change = useCallback((next: boolean) => {
    setOn(next);
    void window.tanacode.notifications.set(next).catch(() => setOn(!next));
  }, []);
  return [on, change];
}
