import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';

// スマホの画面を閉じている間の通知（Web Push。Issue #464）を受け取るかのボタン（セッションの一覧の下）。
// iPhone では、ホーム画面に置いた PWA でだけ使える（Safari のタブでは PushManager が無い）。許可を聞くのは、押したときだけ
type State = 'unsupported' | 'off' | 'on' | 'denied' | 'busy';

// Service Worker の登録（無ければ null。ready は、登録が無いといつまでも返らないので使わない）
async function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration('/app/')) ?? null;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  return (await (await workerRegistration())?.pushManager.getSubscription()) ?? null;
}

// 送り主の公開鍵（base64url）を、バイト列にする（文字のまま渡すと受けないブラウザがある）
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const text = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

// 購読の鍵と、今の送り主の鍵が同じか
function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((byte, i) => byte === b[i]);
}

export function PushToggle() {
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [state, setState] = useState<State>(supported ? 'busy' : 'unsupported');
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void currentSubscription()
      .then(async (subscription) => {
        if (Notification.permission === 'denied') return alive && setState('denied');
        if (!subscription) return alive && setState('off');
        // 開いたときに、購読を Mac に送り直す（Mac が外した・送り主の鍵が新しくなったときに、「オン」のまま届かなくならないように）。
        // 鍵が違えば、今の鍵で作り直す
        const key = await window.tanacode.remote.pushKey();
        let current: PushSubscription | null = subscription;
        if (key && !sameKey(subscription.options?.applicationServerKey ?? null, keyBytes(key))) {
          await subscription.unsubscribe();
          const registration = await workerRegistration();
          if (!registration) return alive && setState('off');
          current = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
        }
        const kept = key ? await window.tanacode.remote.pushSubscribe(current.toJSON()) : false;
        if (alive) setState(kept ? 'on' : 'off');
      })
      .catch(() => alive && setState('off'));
    return () => {
      alive = false;
    };
  }, [supported]);
  if (state === 'unsupported') return null;

  const turnOn = async () => {
    setState('busy');
    try {
      if ((await Notification.requestPermission()) !== 'granted') return setState('denied');
      const key = await window.tanacode.remote.pushKey();
      if (!key) return setState('off');
      const registration = await workerRegistration();
      if (!registration) return setState('off');
      const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
      setState((await window.tanacode.remote.pushSubscribe(subscription.toJSON())) ? 'on' : 'off');
    } catch {
      setState('off');
    }
  };
  const turnOff = async () => {
    setState('busy');
    try {
      await window.tanacode.remote.pushUnsubscribe();
      await (await currentSubscription())?.unsubscribe();
    } finally {
      setState('off');
    }
  };

  return (
    <button
      type="button"
      className={`ghost-button remote-push${state === 'on' ? ' on' : ''}`}
      disabled={state === 'busy' || state === 'denied'}
      aria-pressed={state === 'on'}
      title={state === 'denied' ? t('mobile.push.deniedTip') : undefined}
      onClick={() => void (state === 'on' ? turnOff() : turnOn())}
    >
      {state === 'on' ? t('mobile.push.on') : state === 'denied' ? t('mobile.push.denied') : t('mobile.push.off')}
    </button>
  );
}
