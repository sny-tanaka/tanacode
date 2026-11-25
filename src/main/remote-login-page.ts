import { t } from '@shared/i18n';
import { REMOTE_ICON_PNG } from './remote-login-icon';

// 認証の前に遠隔サーバーが配る画面（Issue #464）。端末の登録とログインだけを行う、小さなページ。
// - スクリプト・スタイル・アイコンは別のファイルで配る（CSP の script-src 'self'。インラインのスクリプトは動かさない）
// - 画面の文言は、Mac の tanacode の画面の言語で、データの要素（type="application/json"。動かない）に入れて渡す
// - 束縛の鍵（取り出せない P-256 の鍵）は、ホーム画面に置いた PWA の IndexedDB に置く（Safari と PWA は保存先が別。登録は PWA で行う）
// - 登録のコードは、URL のフラグメント（#pair=<コード>）で受けるか、打ってもらう。クエリには入れない（履歴・記録に残さない）

export type Page = { type: string; body: string | Buffer };

const MESSAGE_KEYS = [
  'title',
  'installTitle',
  'installLead',
  'installStep1',
  'installStep2',
  'installStep3',
  'pairTitle',
  'pairLead',
  'code',
  'name',
  'namePlaceholder',
  'pair',
  'pairing',
  'numberTitle',
  'numberLead',
  'waiting',
  'approved',
  'rejected',
  'loginTitle',
  'loginLead',
  'login',
  'loggingIn',
  'loggedIn',
  'loggedInLead',
  'repair',
  'backToLogin',
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
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#111111">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon.png">
<link rel="stylesheet" href="/login.css">
<title>tanacode</title>
</head>
<body>
<main>
  <header class="brand">
    <img src="/icon.png" alt="" width="44" height="44">
    <div><div class="brand-name">tanacode</div><div class="brand-sub" id="title"></div></div>
  </header>
  <section class="card" data-step="install" hidden>
    <h2 id="install-title"></h2>
    <p class="lead" id="install-lead"></p>
    <ol class="steps"><li id="install-1"></li><li id="install-2"></li><li id="install-3"></li></ol>
  </section>
  <section class="card" data-step="login" hidden>
    <h2 id="login-title"></h2>
    <p class="lead" id="login-lead"></p>
    <button class="primary" id="login"></button>
  </section>
  <section class="card" data-step="pair" hidden>
    <h2 id="pair-title"></h2>
    <p class="lead" id="pair-lead"></p>
    <label><span id="code-label"></span><input id="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></label>
    <label><span id="name-label"></span><input id="name" maxlength="40"></label>
    <button class="primary" id="pair"></button>
  </section>
  <section class="card" data-step="number" hidden>
    <h2 id="number-title"></h2>
    <div class="number" id="number"></div>
    <p class="lead" id="number-lead"></p>
    <p class="waiting"><span class="dot"></span><span id="waiting"></span></p>
  </section>
  <section class="card" data-step="done" hidden>
    <h2 class="done-title" id="logged-in"></h2>
    <p class="lead" id="logged-in-lead"></p>
  </section>
  <p class="notice" id="notice" hidden></p>
  <p class="error" id="error" role="alert" hidden></p>
  <p class="status" id="status" role="status"></p>
  <div class="links"><button class="link" id="to-pair" hidden></button><button class="link" id="to-login" hidden></button></div>
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
  // 知らせ（うまくいったこと）と誤り。どちらも、次の操作で消す
  const notice = (text) => { $('notice').textContent = text; $('notice').hidden = !text; };
  const error = (text) => { $('error').textContent = text; $('error').hidden = !text; };
  let hasKey = false;
  // 出す段を 1 つだけにする（install: ホーム画面に追加 / pair: 登録 / number: 確認の数字 / login: ログイン / done: ログインした）
  function show(step) {
    for (const section of document.querySelectorAll('[data-step]')) section.hidden = section.dataset.step !== step;
    $('to-pair').hidden = step !== 'login';
    $('to-login').hidden = !(step === 'pair' && hasKey);
    status('');
  }

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
    $('pair').disabled = true;
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
    $('number').textContent = finished.number;
    show('number');
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { state } = await post('/api/pair/status', { requestId: finished.requestId });
      if (state === 'approved') {
        await adoptBindingKey(key);
        hasKey = true;
        notice(M.approved);
        return show('login');
      }
      if (state === 'rejected') {
        error(M.rejected);
        return show('pair');
      }
    }
  }

  // 承認の結果を読みそこねた（画面を消した・通信が切れた）ときは、鍵が pending に残る。先にそれで試し、通ったら binding に移す。
  // 遠隔サーバーが断った（400）ときだけ pending を捨てて、binding で試す（Face ID の取りやめ・通信の切れ・待たされているときは残す）
  async function login() {
    const pending = await store('readonly', (s) => s.get('pending'));
    const key = await bindingKey();
    if (!pending && !key) return error(M.noKey);
    status(M.loggingIn);
    $('login').disabled = true;
    if (pending) {
      try {
        await loginWith(pending);
        await adoptBindingKey(pending);
        return show('done');
      } catch (failure) {
        if (failure.message !== '400') throw failure;
        await store('readwrite', (s) => s.delete('pending'));
        if (!key) throw failure;
      }
    }
    await loginWith(key);
    show('done');
  }

  async function loginWith(key) {
    const begun = await post('/api/login/begin', {});
    const o = begun.options;
    const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: fromB64u(o.challenge), allowCredentials: [] } });
    const r = cred.response;
    const response = {
      id: cred.id, rawId: b64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: { clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature), userHandle: r.userHandle ? b64u(r.userHandle) : undefined },
    };
    await post('/api/login/finish', { response, challengeId: begun.challengeId, bindingSignature: await sign(key, begun.bindingChallenge) });
  }

  // 失敗したら誤りを出し、ボタンを押せるように戻す
  const run = (fn) => () => {
    notice('');
    error('');
    return fn().catch(() => {
      status('');
      error(M.failed);
    }).finally(() => {
      $('login').disabled = $('pair').disabled = blocked;
    });
  };
  const text = { title: 'title', 'install-title': 'installTitle', 'install-lead': 'installLead', 'install-1': 'installStep1', 'install-2': 'installStep2', 'install-3': 'installStep3',
    'login-title': 'loginTitle', 'login-lead': 'loginLead', login: 'login', 'pair-title': 'pairTitle', 'pair-lead': 'pairLead', 'code-label': 'code', 'name-label': 'name', pair: 'pair',
    'number-title': 'numberTitle', 'number-lead': 'numberLead', waiting: 'waiting', 'logged-in': 'loggedIn', 'logged-in-lead': 'loggedInLead', 'to-pair': 'repair', 'to-login': 'backToLogin' };
  for (const [id, key] of Object.entries(text)) $(id).textContent = M[key];
  $('name').placeholder = M.namePlaceholder;
  // iPhone・iPad の Safari のままでは、登録もログインもさせない（束縛の鍵が Safari の側にでき、ホーム画面の PWA から使えないため）
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const blocked = ios && !standalone;
  $('login').disabled = $('pair').disabled = blocked;
  const fragment = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (fragment) $('code').value = fragment;
  $('login').addEventListener('click', run(login));
  $('pair').addEventListener('click', run(pair));
  $('to-pair').addEventListener('click', () => { notice(''); error(''); show('pair'); });
  $('to-login').addEventListener('click', () => { notice(''); error(''); show('login'); });
  // 最初の段: Safari ならホーム画面に追加 / QR から開いたら登録 / 鍵があればログイン / 無ければ登録
  if (blocked) show('install');
  else
    Promise.all([bindingKey(), store('readonly', (s) => s.get('pending'))])
      .then(([key, pending]) => {
        hasKey = Boolean(key || pending);
        show(hasKey && !fragment ? 'login' : 'pair');
      })
      .catch(() => show('pair'));
})();
`;

// 色と部品は、アプリの画面（src/renderer/src/global.css）の決まりに揃える（暗いテーマだけ）
const STYLE = `:root {
  color-scheme: dark;
  --bg-chrome: #111111; --bg-panel: #151515; --bg-surface: #262625; --bg-input: #20201f;
  --border-subtle: #232323; --border-strong: #333332; --border-focus: #4c445e;
  --text-heading: #f0efec; --text-primary: #c7c6c3; --text-secondary: #898781; --text-tertiary: #6e6c66;
  --blue: #6d9ccf; --ok: #5fb98a; --ok-tint: #1f2a23; --danger: #d98a82; --danger-tint: #2a2222;
  --send-bg: #2c2830; --send-bg-hover: #342f3a; --send-fg: #c5b9e6; --send-border: #4c445e;
  --grad: linear-gradient(90deg, #d4835c, #9083cf 55%, #6d9ccf);
  --font-ui: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', sans-serif;
  --font-mono: ui-monospace, Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { background: var(--bg-chrome); }
body { margin: 0; color: var(--text-primary); font: 15px/1.6 var(--font-ui); -webkit-text-size-adjust: 100%;
  padding: max(24px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) max(32px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); }
main { max-width: 440px; margin: 0 auto; }
[hidden] { display: none !important; }
.brand { display: flex; align-items: center; gap: 12px; margin: 8px 2px 22px; }
.brand img { border-radius: 10px; }
.brand-name { color: var(--text-heading); font-size: 19px; font-weight: 600; letter-spacing: 0.01em; }
.brand-sub { color: var(--text-secondary); font-size: 13px; }
.card { position: relative; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 14px; padding: 20px 18px 18px; overflow: hidden; }
.card::before { content: ''; position: absolute; inset: 0 0 auto; height: 2px; background: var(--grad); opacity: 0.8; }
h2 { margin: 0 0 6px; color: var(--text-heading); font-size: 17px; font-weight: 600; }
.lead { margin: 0 0 16px; color: var(--text-secondary); font-size: 14px; }
label { display: block; margin: 0 0 14px; }
label span { display: block; margin-bottom: 6px; color: var(--text-secondary); font-size: 13px; }
input { width: 100%; padding: 11px 12px; font: inherit; color: var(--text-heading); background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 10px; outline: none; }
input:focus { border-color: var(--border-focus); }
input::placeholder { color: var(--text-tertiary); }
.code-input { font: 22px/1.3 var(--font-mono); letter-spacing: 0.3em; text-align: center; }
button { font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.primary { display: block; width: 100%; min-height: 48px; margin-top: 4px; padding: 12px 16px; color: var(--send-fg); background: var(--send-bg); border: 1px solid var(--send-border); border-radius: 12px; font-size: 16px; font-weight: 600; }
.primary:active:not(:disabled) { background: var(--send-bg-hover); }
.primary:disabled { color: var(--text-tertiary); background: var(--bg-surface); border-color: var(--border-strong); cursor: default; }
.steps { margin: 0; padding: 0; list-style: none; counter-reset: step; }
.steps li { position: relative; min-height: 28px; margin: 0 0 12px; padding-left: 40px; color: var(--text-primary); counter-increment: step; }
.steps li::before { content: counter(step); position: absolute; left: 0; top: -1px; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
  color: var(--send-fg); background: var(--send-bg); border: 1px solid var(--send-border); font-size: 13px; font-weight: 600; }
.number { margin: 14px 0 16px; padding: 16px 8px; color: var(--text-heading); background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 12px;
  font: 600 40px/1.2 var(--font-mono); letter-spacing: 0.22em; text-align: center; }
.waiting { display: flex; align-items: center; gap: 10px; margin: 0; color: var(--text-secondary); font-size: 14px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--blue); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.done-title::before { content: '✓'; margin-right: 8px; color: var(--ok); }
.notice, .error { margin: 14px 0 0; padding: 11px 13px; border-radius: 10px; font-size: 14px; }
.notice { color: var(--ok); background: var(--ok-tint); }
.error { color: var(--danger); background: var(--danger-tint); }
.status { min-height: 1.6em; margin: 12px 2px 0; color: var(--text-secondary); font-size: 14px; }
.status:empty { display: none; }
.links { margin-top: 18px; text-align: center; }
.link { padding: 8px; color: var(--text-secondary); background: none; border: none; font-size: 14px; text-decoration: underline; text-underline-offset: 3px; }
`;

const MANIFEST = JSON.stringify({
  name: 'tanacode',
  short_name: 'tanacode',
  display: 'standalone',
  background_color: '#111111',
  theme_color: '#111111',
  icons: [{ src: '/icon.png', sizes: '180x180', type: 'image/png' }],
});

const ICON = Buffer.from(REMOTE_ICON_PNG, 'base64');

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
    case '/icon.png':
      return { type: 'image/png', body: ICON };
    default:
      return null;
  }
}
