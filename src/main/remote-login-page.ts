import { t } from '@shared/i18n';

// 認証の前に遠隔サーバーが配る画面（Issue #464）。端末の登録とログインだけを行う、小さなページ。
// - スクリプト・スタイル・アイコンは別のファイルで配る（CSP の script-src 'self'。インラインのスクリプトは動かさない）
// - 画面の文言は、Mac の tanacode の画面の言語で、データの要素（type="application/json"。動かない）に入れて渡す
// - 束縛の鍵（取り出せない P-256 の鍵）は、ホーム画面に置いた PWA の IndexedDB に置く（Safari と PWA は保存先が別。登録は PWA で行う）
// - 登録のコードは、URL のフラグメント（#pair=<コード>）で受けるか、打ってもらう。クエリには入れない（履歴・記録に残さない）

export type Page = { type: string; body: string };

const MESSAGE_KEYS = [
  'title',
  'addToHome',
  'pairTitle',
  'code',
  'name',
  'pair',
  'pairing',
  'number',
  'approved',
  'rejected',
  'loginTitle',
  'login',
  'loggedIn',
  'noKey',
  'failed',
] as const;

const escapeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function html(): string {
  const messages = Object.fromEntries(MESSAGE_KEYS.map((key) => [key, t(`remoteLogin.${key}`)]));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="stylesheet" href="/login.css">
<title>tanacode</title>
</head>
<body>
<main>
  <h1 id="title"></h1>
  <p id="add-to-home" hidden></p>
  <section>
    <h2 id="login-title"></h2>
    <button id="login"></button>
  </section>
  <section>
    <h2 id="pair-title"></h2>
    <label><span id="code-label"></span><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></label>
    <label><span id="name-label"></span><input id="name" maxlength="40"></label>
    <button id="pair"></button>
  </section>
  <p id="status" role="status"></p>
</main>
<script type="application/json" id="messages">${escapeJson(messages)}</script>
<script src="/login.js"></script>
</body>
</html>`;
}

const SCRIPT = String.raw`(() => {
  const M = JSON.parse(document.getElementById('messages').textContent);
  const $ = (id) => document.getElementById(id);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const status = (text) => { $('status').textContent = text; };

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  function store(mode, act) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('tanacode-remote', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('keys');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('keys', mode);
        const req = act(tx.objectStore('keys'));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  // 束縛の鍵（取り出せない P-256 の鍵）。登録のたびに作り直す。
  // 承認されるまでは別の名前（pending）に置き、承認されてから binding に移す（やり直しが断られても、今の登録でログインできるように）
  async function newBindingKey() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const key = { privateKey: pair.privateKey, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
    await store('readwrite', (s) => s.put(key, 'pending'));
    return key;
  }
  const adoptBindingKey = (key) => store('readwrite', (s) => { s.put(key, 'binding'); return s.delete('pending'); });
  const bindingKey = () => store('readonly', (s) => s.get('binding'));
  const sign = async (key, text) => b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(text)));

  async function pair() {
    status(M.pairing);
    const begun = await post('/api/pair/begin', { code: $('code').value.trim() });
    const o = begun.options;
    const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: fromB64u(o.challenge), user: { ...o.user, id: fromB64u(o.user.id) }, excludeCredentials: [] } });
    const key = await newBindingKey();
    const r = cred.response;
    const response = {
      id: cred.id, rawId: b64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: { clientDataJSON: b64u(r.clientDataJSON), attestationObject: b64u(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] },
    };
    const finished = await post('/api/pair/finish', { pairingId: begun.pairingId, response, bindingJwk: key.jwk, bindingSignature: await sign(key, begun.bindingChallenge), name: $('name').value.trim() });
    status(M.number.replace('{number}', finished.number));
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { state } = await post('/api/pair/status', { requestId: finished.requestId });
      if (state === 'approved') {
        await adoptBindingKey(key);
        return status(M.approved);
      }
      if (state === 'rejected') return status(M.rejected);
    }
  }

  async function login() {
    const key = await bindingKey();
    if (!key) return status(M.noKey);
    const begun = await post('/api/login/begin', {});
    const o = begun.options;
    const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: fromB64u(o.challenge), allowCredentials: [] } });
    const r = cred.response;
    const response = {
      id: cred.id, rawId: b64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: { clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature), userHandle: r.userHandle ? b64u(r.userHandle) : undefined },
    };
    await post('/api/login/finish', { response, challengeId: begun.challengeId, bindingSignature: await sign(key, begun.bindingChallenge) });
    status(M.loggedIn);
  }

  const run = (fn) => () => fn().catch(() => status(M.failed));
  $('title').textContent = M.title;
  $('add-to-home').textContent = M.addToHome;
  $('add-to-home').hidden = standalone;
  // iPhone・iPad の Safari のままでは、登録もログインもさせない（束縛の鍵が Safari の側にでき、ホーム画面の PWA から使えないため）
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('login').disabled = $('pair').disabled = ios && !standalone;
  $('login-title').textContent = M.loginTitle;
  $('login').textContent = M.login;
  $('pair-title').textContent = M.pairTitle;
  $('code-label').textContent = M.code;
  $('name-label').textContent = M.name;
  $('pair').textContent = M.pair;
  const fragment = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (fragment) $('code').value = fragment;
  $('login').addEventListener('click', run(login));
  $('pair').addEventListener('click', run(pair));
})();
`;

const STYLE = `:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.6 -apple-system, "Hiragino Sans", sans-serif; padding: max(20px, env(safe-area-inset-top)) 20px 40px; }
main { max-width: 480px; margin: 0 auto; }
h1 { font-size: 22px; }
h2 { font-size: 17px; margin: 24px 0 8px; }
label { display: block; margin: 8px 0; }
label span { display: block; font-size: 13px; opacity: 0.7; }
input { font: inherit; width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #8886; border-radius: 8px; background: transparent; color: inherit; }
button { font: inherit; padding: 10px 16px; border-radius: 10px; border: 1px solid #8886; background: #8881; color: inherit; }
#add-to-home { padding: 10px 12px; border-radius: 10px; background: #f2b70522; }
#status { margin-top: 20px; white-space: pre-wrap; }
`;

const MANIFEST = JSON.stringify({ name: 'tanacode', short_name: 'tanacode', display: 'standalone', background_color: '#121211', theme_color: '#121211', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] });

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#121211"/><path d="M20 22l12 10-12 10M34 44h12" fill="none" stroke="#e8e6e1" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// パスに当たる画面のファイル（無ければ null）
export function loginPage(path: string): Page | null {
  switch (path) {
    case '/':
      return { type: 'text/html; charset=utf-8', body: html() };
    case '/login.js':
      return { type: 'text/javascript; charset=utf-8', body: SCRIPT };
    case '/login.css':
      return { type: 'text/css; charset=utf-8', body: STYLE };
    case '/manifest.webmanifest':
      return { type: 'application/manifest+json', body: MANIFEST };
    case '/icon.svg':
      return { type: 'image/svg+xml', body: ICON };
    default:
      return null;
  }
}
