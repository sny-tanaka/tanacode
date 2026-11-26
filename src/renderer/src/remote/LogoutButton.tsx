import { useState } from 'react';
import { t } from '@shared/i18n';

// スマホの画面のログアウト（セッションの一覧の下。Issue #464）。遠隔サーバーがセッションを消し、Cookie とキャッシュを消させる。
// スマホに残す鍵（束縛の鍵）は消さないので、次は Face ID でログインし直すだけ（登録し直さなくてよい）。
// 自分でログアウトしたら、この端末への通知も止める（決めたこと。使わない時間で切れたときは届き続ける）
// done: 終わったあと（既定は、ログインの画面へ戻す）
// このブラウザの通知の購読を外す（通知の口が無いブラウザでは何もしない）
async function stopPushHere(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const registration = await navigator.serviceWorker.ready;
  await (await registration.pushManager.getSubscription())?.unsubscribe();
}

export function LogoutButton({ done = () => location.replace('/') }: { done?: () => void }) {
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    if (!window.confirm(t('mobile.logoutConfirm'))) return;
    setBusy(true);
    // 通知を止める（Mac の購読を外し、ブラウザの購読も外す）。止められなくても、ログアウトは続ける
    await window.tanacode.remote.pushUnsubscribe().catch(() => {});
    await stopPushHere().catch(() => {});
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
