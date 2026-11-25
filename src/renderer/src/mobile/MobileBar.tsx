import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import { onRemoteConnected, remoteConnected } from '../remote/mode';

// スマホの配置の上の帯（Issue #464）。左にセッションの引き出しを開け閉めするボタン（ほかのセッションの答え待ちの数を出す）、
// 真ん中に選んでいるセッションの名前、右に Mac とつながっているか
export function MobileBar({
  session,
  waiting,
  drawerOpen,
  onToggleSessions,
}: {
  session: SessionSummary | null;
  waiting: number;
  drawerOpen: boolean;
  onToggleSessions: () => void;
}) {
  const [connected, setConnected] = useState(remoteConnected);
  useEffect(() => onRemoteConnected(setConnected), []);
  const label = connected ? t('mobile.connected') : t('mobile.reconnecting');
  return (
    <header className="mobile-bar">
      <button className="mobile-bar-menu" aria-label={t('mobile.sessions')} aria-expanded={drawerOpen} onClick={onToggleSessions}>
        <span className="mobile-bar-burger" aria-hidden="true" />
        {waiting > 0 && <span className="mobile-bar-badge">{waiting}</span>}
      </button>
      <div className="mobile-bar-title">{session ? session.title || t('mobile.untitled') : t('mobile.noSession')}</div>
      <span className={`mobile-bar-connection${connected ? ' on' : ''}`} role="status" aria-label={label} title={label} />
    </header>
  );
}
