import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';
import type { RemoteConnection } from '@shared/remote-settings';

// 上の帯の「遠隔操作中（端末の名前）」と「切断」。スマホなどがつながっている間だけ出す（Issue #464 の気づき方）。
// 「切断」は、全部のセッションを捨てる（スマホがつなぎ直すには、Face ID でログインし直す）。Mac の画面だけのもので、スマホからは呼べない
export function RemoteBanner() {
  const [connections, setConnections] = useState<RemoteConnection[]>([]);

  useEffect(() => {
    let alive = true;
    void window.tanacode.remote.connections().then(
      (loaded) => alive && setConnections(loaded),
      () => {},
    );
    const off = window.tanacode.remote.onConnectionsChanged((next) => setConnections(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (connections.length === 0) return null;
  const names = connections.map((c) => c.name || t('main.notice.remoteUnnamed')).join('・');
  return (
    <div className="remote-banner" role="status">
      <span className="remote-banner-dot" />
      <span className="remote-banner-text">{t('remote.banner.active', { names })}</span>
      <button
        className="ghost-button"
        title={t('remote.banner.disconnectTip')}
        onClick={() => {
          void window.tanacode.remote.disconnectAll().then(setConnections, () => {});
        }}
      >
        {t('remote.banner.disconnect')}
      </button>
    </div>
  );
}
