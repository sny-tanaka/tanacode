import { useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import type { RemoteSettingsState, RemoteStatus } from '@shared/remote-settings';
import { errorMessage } from '../errorMessage';
import { RemoteDevices } from './RemoteDevices';

// 待ち受けの様子の文（メニューバーと同じ）
export function remoteStatusText(status: RemoteStatus, connections: number): string {
  switch (status.state) {
    case 'off':
      return t('main.menu.remoteStatus.off');
    case 'starting':
      return t('main.menu.remoteStatus.starting');
    case 'listening':
      return t('main.menu.remoteStatus.listening', { port: status.port, count: connections });
    case 'in-use':
      return t('main.menu.remoteStatus.inUse', { port: status.port });
    case 'failed':
      return t('main.menu.remoteStatus.failed');
  }
}

// 遠隔操作（スマホから。Issue #464）の設定。メニューバーの「遠隔操作の設定…」から開く（Mac の設定なので、スマホには出さない）。
// 決めるのは、公開する URL（スマホが開く https の URL。Host と Origin の確かめに使う）と、127.0.0.1 で待ち受けるポート。
// 入り・切りは、メニューバーの「遠隔操作を使う」で行う（公開する URL を決めるまでは入れられない）
export function RemoteSettingsDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<RemoteSettingsState | null>(null);
  const [publicUrl, setPublicUrl] = useState('');
  const [port, setPort] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void window.tanacode.remote.settings().then(
      (loaded) => {
        if (!alive) return;
        setState(loaded);
        setPublicUrl(loaded.settings.publicUrl);
        setPort(String(loaded.settings.port));
      },
      (e: unknown) => {
        if (alive) setError(t('remote.loadFailed', { error: errorMessage(e) }));
      },
    );
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      alive = false;
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  const dirty = state !== null && (publicUrl.trim() !== state.settings.publicUrl || port.trim() !== String(state.settings.port));

  const close = () => {
    if (!saving) onClose();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setState(await window.tanacode.remote.setSettings({ port: Number(port.trim()), publicUrl: publicUrl.trim() }));
      onClose();
    } catch (e) {
      setError(t('remote.saveFailed', { error: errorMessage(e) }));
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="quick-open remote-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('remote.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="settings-files-head">
          <h2>{t('remote.title')}</h2>
          <p>{t('remote.description')}</p>
          <p className="prompts-warning">{t('remote.warning')}</p>
        </div>
        {state !== null && (
          <div className="remote-dialog-body">
            <label className="remote-field">
              <span className="remote-field-label">{t('remote.publicUrl')}</span>
              <input value={publicUrl} spellCheck={false} placeholder="https://mac.example.ts.net" onChange={(e) => setPublicUrl(e.target.value)} />
              <span className="remote-field-hint">{t('remote.publicUrlHint')}</span>
            </label>
            <label className="remote-field">
              <span className="remote-field-label">{t('remote.port')}</span>
              <input value={port} inputMode="numeric" spellCheck={false} onChange={(e) => setPort(e.target.value)} />
              <span className="remote-field-hint">{t('remote.portHint')}</span>
            </label>
            <div className="remote-field">
              <span className="remote-field-label">{t('remote.status')}</span>
              <span>{remoteStatusText(state.status, state.connections)}</span>
            </div>
            <RemoteDevices />
          </div>
        )}
        {error && <div className="browser-hosts-error">{error}</div>}
        <div className="worktree-dialog-foot">
          <div className="spacer" />
          <button className="ghost-button" disabled={saving} onClick={close}>
            {t('common.cancel')}
          </button>
          <button className="send-button" disabled={saving || !dirty} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
