import { useState } from 'react';
import { t } from '@shared/i18n';

// スマホの画面のログアウト（セッションの一覧の下。Issue #464）。遠隔サーバーがセッションを消し、Cookie とキャッシュを消させる。
// スマホに残す鍵（束縛の鍵）は消さないので、次は Face ID でログインし直すだけ（登録し直さなくてよい）
// done: 終わったあと（既定は、ログインの画面へ戻す）
export function LogoutButton({ done = () => location.replace('/') }: { done?: () => void }) {
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    if (!window.confirm(t('mobile.logoutConfirm'))) return;
    setBusy(true);
    // 届かなくても、ログインの画面へ戻す（Cookie が残っていれば、そのままつながる）
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    done();
  };
  return (
    <button type="button" className="ghost-button remote-logout" disabled={busy} onClick={() => void logout()}>
      {t('mobile.logout')}
    </button>
  );
}
