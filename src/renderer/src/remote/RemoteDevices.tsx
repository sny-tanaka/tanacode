import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { locale, t } from '@shared/i18n';
import type { RemoteDevicesState } from '@shared/remote-settings';
import { errorMessage } from '../errorMessage';
import { IconButton, TrashIcon } from '../icons';

// 遠隔操作で登録した端末と、端末の登録の受付（遠隔操作の設定のダイアログの中。Mac の設定なので、スマホには出さない）。
// 登録の流れ: 「端末を追加」で QR と登録のコードを出す → スマホで QR を読み、ホーム画面に置いた PWA で登録する →
// スマホに出た確認の数字を、ここで打って承認する（見ずに承認しないよう、数字は打たせる。既定は断る）
export function RemoteDevices() {
  const [state, setState] = useState<RemoteDevicesState | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  // 承認待ちの頼みごとに選んだ、許すプロファイル（選んでいなければ、今開いている全部）
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void window.tanacode.remote.devices().then(
      (loaded) => alive && setState(loaded),
      (e: unknown) => alive && setError(errorMessage(e)),
    );
    const off = window.tanacode.remote.onDevicesChanged((next) => setState(next));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, []);

  const url = state?.pairing?.url ?? null;
  useEffect(() => {
    if (!url) return setQr(null);
    let alive = true;
    void QRCode.toDataURL(url, { margin: 1, width: 200 }).then((data) => alive && setQr(data));
    return () => {
      alive = false;
    };
  }, [url]);

  const run = async (act: () => Promise<RemoteDevicesState>) => {
    setError(null);
    try {
      setState(await act());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const profilesOf = (requestId: string) => chosen[requestId] ?? (state?.profiles ?? []).map((p) => p.id);
  const toggleProfile = (requestId: string, profileId: string) =>
    setChosen((current) => {
      const list = current[requestId] ?? (state?.profiles ?? []).map((p) => p.id);
      return { ...current, [requestId]: list.includes(profileId) ? list.filter((id) => id !== profileId) : [...list, profileId] };
    });
  const profileNames = (ids: string[]) => ids.map((id) => state?.profiles.find((p) => p.id === id)?.name ?? id).join('・');

  const approve = async (requestId: string) => {
    setError(null);
    try {
      if (!(await window.tanacode.remote.approvePairing(requestId, numbers[requestId] ?? '', profilesOf(requestId)))) setError(t('remote.devices.wrongNumber'));
      setState(await window.tanacode.remote.devices());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (!state) return error ? <div className="browser-hosts-error">{error}</div> : null;
  const date = (at: number) => new Date(at).toLocaleString(locale());
  const pairing = state.pairing;
  // 遠隔操作の記録（新しいものから。記録はスマホからは消せない）
  const log = state.log ?? [];

  return (
    <section className="remote-devices" aria-label={t('remote.devices.title')}>
      <div className="remote-field-label">{t('remote.devices.title')}</div>
      {state.problem && state.problem !== 'unavailable' && (
        <>
          <p className="prompts-warning">{t(`remote.devices.problem.${state.problem}`)}</p>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              if (window.confirm(t('remote.devices.confirmReset'))) void run(() => window.tanacode.remote.resetDevices());
            }}
          >
            {t('remote.devices.reset')}
          </button>
        </>
      )}
      {state.devices.length === 0 ? (
        <p className="remote-field-hint">{t('remote.devices.empty')}</p>
      ) : (
        <ul className="remote-device-list">
          {state.devices.map((device) => (
            <li key={device.id} className="remote-device">
              <div className="remote-device-body">
                <span className="remote-device-name">{device.name || t('main.notice.remoteUnnamed')}</span>
                <span className="remote-field-hint">
                  {t('remote.devices.dates', { created: date(device.createdAt), used: device.lastUsedAt === null ? t('remote.devices.never') : date(device.lastUsedAt) })}
                </span>
                <span className="remote-field-hint">{t('remote.devices.profiles', { names: profileNames(device.profileIds) })}</span>
              </div>
              <IconButton
                size="sm"
                icon={TrashIcon}
                label={t('remote.devices.remove')}
                tip={t('remote.devices.removeTip')}
                onClick={() => {
                  if (window.confirm(t('remote.devices.confirmRemove', { name: device.name || t('main.notice.remoteUnnamed') }))) void run(() => window.tanacode.remote.removeDevice(device.id));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {pairing ? (
        <div className="remote-pairing">
          <div className="remote-pairing-code">
            {qr && <img src={qr} alt={t('remote.devices.qr')} width={160} height={160} />}
            <div>
              <div className="remote-field-hint">{t('remote.devices.codeLabel')}</div>
              <div className="remote-pairing-digits">{pairing.code}</div>
              <div className="remote-field-hint">{t('remote.devices.until', { seconds: Math.max(0, Math.round((pairing.until - now) / 1000)) })}</div>
            </div>
          </div>
          <p className="remote-field-hint">{t('remote.devices.pairingHint')}</p>
          {pairing.pending.map((request) => (
            <div key={request.requestId} className="remote-pairing-request">
              <span>{t('remote.devices.request', { name: request.name || t('main.notice.remoteUnnamed') })}</span>
              <input
                aria-label={t('remote.devices.number')}
                placeholder={t('remote.devices.number')}
                inputMode="numeric"
                maxLength={6}
                value={numbers[request.requestId] ?? ''}
                onChange={(e) => setNumbers((current) => ({ ...current, [request.requestId]: e.target.value }))}
              />
              <button className="ghost-button" onClick={() => void run(() => window.tanacode.remote.rejectPairing(request.requestId))}>
                {t('remote.devices.reject')}
              </button>
              <button
                className="send-button"
                disabled={(numbers[request.requestId] ?? '').trim().length !== 6 || profilesOf(request.requestId).length === 0}
                onClick={() => void approve(request.requestId)}
              >
                {t('remote.devices.approve')}
              </button>
              <fieldset className="remote-pairing-profiles">
                <legend>{t('remote.devices.allowProfiles')}</legend>
                {state.profiles.map((profile) => (
                  <label key={profile.id}>
                    <input type="checkbox" checked={profilesOf(request.requestId).includes(profile.id)} onChange={() => toggleProfile(request.requestId, profile.id)} />
                    {profile.name}
                  </label>
                ))}
                <span className="remote-field-hint">{t('remote.devices.allowProfilesHint')}</span>
              </fieldset>
            </div>
          ))}
          <button className="ghost-button" onClick={() => void run(() => window.tanacode.remote.cancelPairing())}>
            {t('remote.devices.cancel')}
          </button>
        </div>
      ) : (
        <button className="ghost-button" onClick={() => void run(() => window.tanacode.remote.startPairing())}>
          {t('remote.devices.add')}
        </button>
      )}
      {log.length > 0 && (
        <details className="remote-log">
          <summary className="remote-field-label">{t('remote.log.title', { count: log.length })}</summary>
          <ul className="remote-log-list">
            {log.map((entry, i) => (
              <li key={`${entry.at}-${i}`}>
                <span className="remote-field-hint">{date(entry.at)}</span>
                <span>{t(`remote.log.kind.${entry.kind}`, { name: entry.name || t('main.notice.remoteUnnamed') })}</span>
              </li>
            ))}
          </ul>
          <p className="remote-field-hint">{t('remote.log.hint')}</p>
        </details>
      )}
      {error && <div className="browser-hosts-error">{error}</div>}
    </section>
  );
}
