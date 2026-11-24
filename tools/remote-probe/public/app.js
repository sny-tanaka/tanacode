// 確かめのページの動き。結果は results に貯め、各節の pre に出す
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const where = standalone ? 'pwa' : 'browser';
const results = { where, startedAt: new Date().toISOString() };

const $ = (id) => document.getElementById(id);
function show(id, value) {
  // 結果をまとめる節（results）は、自分を貯めない
  if (id !== 'results') results[id] = value;
  $(id).textContent = JSON.stringify(value, null, 2);
}
function fail(id, error) {
  show(id, { error: `${error?.name ?? 'Error'}: ${error?.message ?? error}` });
}

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.status);
  return json;
}
const challenge = async () => (await api('/api/challenge')).challenge;

// IndexedDB に、取り出せない鍵（CryptoKey）をそのまま置く
function db() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tanacode-probe', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function idb(mode, fn) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('keys', mode);
    const req = fn(tx.objectStore('keys'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

// 1. 開き方。Safari で開いたときに印を置き、PWA から見えるかを見る
function env() {
  const mark = localStorage.getItem('probe.browserSeen');
  if (!standalone) localStorage.setItem('probe.browserSeen', JSON.stringify({ at: new Date().toISOString(), hash: location.hash }));
  show('env', {
    where,
    href: location.href,
    hash: location.hash || null,
    origin: location.origin,
    secureContext: isSecureContext,
    markFromBrowser: mark ? JSON.parse(mark) : null,
    userAgent: navigator.userAgent,
  });
}

const actions = {
  async info() {
    show('info', await api('/api/info'));
  },

  async cookieSet() {
    show('cookie', { action: 'set', ...(await api('/api/cookie/set', { where })) });
  },
  async cookieCheck() {
    show('cookie', { action: 'check', where, ...(await api('/api/cookie/check')) });
  },

  async bindCreate() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const { keyId } = await api('/api/bind/register', { publicKeyJwk, where });
    await idb('readwrite', (s) => s.put({ privateKey: pair.privateKey, keyId, createdAt: new Date().toISOString() }, 'bound'));
    show('bind', { action: 'create', where, keyId, privateKeyExtractable: pair.privateKey.extractable });
  },
  async bindCheck() {
    const saved = await idb('readonly', (s) => s.get('bound'));
    if (!saved) return show('bind', { action: 'check', where, found: false });
    const value = await challenge();
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, saved.privateKey, enc.encode(value));
    const verified = await api('/api/bind/verify', { keyId: saved.keyId, challenge: value, signature: b64url(signature) });
    const days = (Date.now() - new Date(saved.createdAt).getTime()) / 86400000;
    show('bind', { action: 'check', where, found: true, createdAt: saved.createdAt, ageDays: Math.round(days * 100) / 100, privateKeyExtractable: saved.privateKey.extractable, ...verified });
  },

  async passkeyRegister() {
    let userId = localStorage.getItem('probe.userId');
    if (!userId) {
      userId = b64url(crypto.getRandomValues(new Uint8Array(16)));
      localStorage.setItem('probe.userId', userId);
    }
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: fromB64url(await challenge()),
        rp: { name: 'tanacode の確かめ', id: location.hostname },
        user: { id: fromB64url(userId), name: `probe-${where}`, displayName: `tanacode の確かめ（${where}）` },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
      },
    });
    const r = credential.response;
    const publicKey = r.getPublicKey?.();
    const authenticatorData = r.getAuthenticatorData?.();
    const verified = await api('/api/passkey/register', {
      id: credential.id,
      clientDataJSON: b64url(r.clientDataJSON),
      authenticatorData: authenticatorData ? b64url(authenticatorData) : null,
      publicKey: publicKey ? b64url(publicKey) : null,
      algorithm: r.getPublicKeyAlgorithm?.() ?? null,
      where,
    });
    show('passkey', { action: 'register', where, id: credential.id, authenticatorAttachment: credential.authenticatorAttachment ?? null, transports: r.getTransports?.() ?? null, ...verified });
  },
  async passkeyLogin() {
    const credential = await navigator.credentials.get({
      publicKey: { challenge: fromB64url(await challenge()), rpId: location.hostname, userVerification: 'required' },
    });
    const r = credential.response;
    const verified = await api('/api/passkey/login', {
      id: credential.id,
      clientDataJSON: b64url(r.clientDataJSON),
      authenticatorData: b64url(r.authenticatorData),
      signature: b64url(r.signature),
      userHandle: r.userHandle ? b64url(r.userHandle) : null,
    });
    show('passkey', { action: 'login', where, id: credential.id, authenticatorAttachment: credential.authenticatorAttachment ?? null, ...verified });
  },

  async camera() {
    const video = $('video');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.hidden = false;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    stream.getTracks().forEach((t) => t.stop());
    video.hidden = true;
    show('camera', { where, ok: true, width: settings.width ?? null, height: settings.height ?? null, barcodeDetector: 'BarcodeDetector' in window });
  },

  async pushSubscribe() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return show('push', { where, supported: false });
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return show('push', { where, supported: true, permission });
    const { publicKey, subject } = await api('/api/push/key');
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(publicKey) });
    const saved = await api('/api/push/subscribe', { subscription: subscription.toJSON() });
    show('push', { action: 'subscribe', where, supported: true, permission, vapidSubject: subject, ...saved });
  },
  async pushSend() {
    show('push', { action: 'send', where, ...(await api('/api/push/send', {})) });
  },

  websocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      const rtts = [];
      let hello = null;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('10 秒たってもつながらない'));
      }, 10000);
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.hello) {
          hello = message;
        } else {
          rtts.push(Math.round(performance.now() - message.sentAt));
        }
        if (rtts.length < 5) {
          ws.send(JSON.stringify({ sentAt: performance.now() }));
        } else {
          clearTimeout(timer);
          ws.close();
          show('websocket', { where, ok: true, extensions: ws.extensions || null, rttMs: rtts, serverSaw: hello });
          resolve();
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WebSocket のエラー'));
      };
    });
  },

  async sendResults() {
    await api('/api/results', results);
    show('results', results);
  },
};

for (const button of document.querySelectorAll('button[data-run]')) {
  const name = button.dataset.run;
  const target = button.closest('section').querySelector('pre').id;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await actions[name]();
    } catch (error) {
      fail(target, error);
    } finally {
      button.disabled = false;
    }
  });
}

env();
