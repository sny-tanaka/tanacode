// 遠隔操作の「先に確かめること」（Issue #464）を、私用の Mac と iPhone で試すためのサーバー。
// tanacode 本体には入れない。127.0.0.1 だけで待ち受け、前に `tailscale serve` を置いて iPhone から開く。
// 届いた要求の接続元とヘッダーを data/requests.jsonl に、ページが送った結果を data/results.jsonl に書く。
import { createServer } from 'node:http';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as webpush from 'web-push';
import { WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
const publicDir = join(here, 'public');
const port = Number(process.env.PORT ?? 8787);
// Web Push の VAPID の連絡先（sub）。メールアドレスを入れずに済むかを確かめる（先に確かめること 9）
const vapidSubject = process.env.VAPID_SUBJECT ?? 'https://github.com/sny-tanaka/tanacode';

mkdirSync(dataDir, { recursive: true });

// 記録に残すヘッダー（転送が付けるものと、本人確認に関わるもの）
const LOGGED_HEADERS = [
  'host',
  'origin',
  'referer',
  'user-agent',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-funnel-request',
  'sec-fetch-site',
  'sec-websocket-extensions',
];

// Tailscale のユーザーのヘッダーは、メールアドレスや名前が入るので、あるかどうかだけを残す
const MASKED_HEADERS = new Set(['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic']);

function pickHeaders(headers) {
  const picked = {};
  for (const name of LOGGED_HEADERS) {
    if (headers[name] === undefined) continue;
    picked[name] = MASKED_HEADERS.has(name) ? '（あり。値は記録しない）' : headers[name];
  }
  return picked;
}

function record(file, entry) {
  appendFileSync(join(dataDir, file), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function loadJson(name, fallback) {
  const path = join(dataDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

function saveJson(name, value) {
  writeFileSync(join(dataDir, name), JSON.stringify(value, null, 2));
}

// VAPID の鍵は、初めて動かしたときに作って data/ に置く（この Mac だけのもの）
const vapid = loadJson('vapid.json', null) ?? webpush.generateVAPIDKeys();
saveJson('vapid.json', vapid);
webpush.setVapidDetails(vapidSubject, vapid.publicKey, vapid.privateKey);

// 束縛の鍵（取り出せない P-256 の公開鍵）・パスキー・Web Push の購読
const store = loadJson('store.json', { boundKeys: {}, passkeys: {}, subscriptions: [] });
const saveStore = () => saveJson('store.json', store);

// 1 回限りの乱数（5 分で切れる）
const challenges = new Map();
function newChallenge() {
  const value = randomBytes(32).toString('base64url');
  challenges.set(value, Date.now() + 5 * 60 * 1000);
  return value;
}
function takeChallenge(value) {
  const until = challenges.get(value);
  challenges.delete(value);
  return until !== undefined && until > Date.now();
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (text) => Buffer.from(text, 'base64url');

// authenticatorData のフラグと signCount（WebAuthn の仕様の 6.1）
function parseAuthData(authData) {
  const flags = authData[32];
  return {
    rpIdHash: b64url(authData.subarray(0, 32)),
    up: !!(flags & 0x01),
    uv: !!(flags & 0x04),
    be: !!(flags & 0x08),
    bs: !!(flags & 0x10),
    at: !!(flags & 0x40),
    signCount: authData.readUInt32BE(33),
  };
}

// clientDataJSON の type・challenge・origin を確かめる
function checkClientData(clientDataJSON, type, expectedOrigin) {
  const client = JSON.parse(fromB64url(clientDataJSON).toString('utf8'));
  return {
    client,
    typeOk: client.type === type,
    challengeOk: takeChallenge(client.challenge),
    originOk: client.origin === expectedOrigin,
  };
}

// ページから見た Origin。転送の後ろでは Host がそのまま渡る（tailscale serve）ので、https を前提にする
function expectedOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] ?? (req.headers.host?.startsWith('127.0.0.1') || req.headers.host?.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${req.headers.host}`;
}

function rpIdHashOf(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  return b64url(createHash('sha256').update(host).digest());
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

function cookieValue(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

const routes = {
  // 接続元とヘッダー（先に確かめること 6: serve の後ろで 127.0.0.1 に見えるか）
  'GET /api/info': (req) => ({ remoteAddress: req.socket.remoteAddress, headers: pickHeaders(req.headers), expectedOrigin: expectedOrigin(req) }),

  'GET /api/challenge': () => ({ challenge: newChallenge() }),

  // Cookie（先に確かめること 5: Safari で置いた Cookie が PWA に写るか）
  'POST /api/cookie/set': async (req, res, body) => {
    const value = randomBytes(9).toString('base64url');
    res.setHeader('set-cookie', `__Host-probe=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    return { set: value, where: body.where ?? null };
  },
  'GET /api/cookie/check': (req) => ({ cookie: cookieValue(req, '__Host-probe') }),

  // 束縛の鍵（先に確かめること 4: 取り出せない P-256 の鍵が残るか）
  'POST /api/bind/register': async (req, res, body) => {
    const keyId = randomBytes(9).toString('base64url');
    createPublicKey({ key: body.publicKeyJwk, format: 'jwk' });
    store.boundKeys[keyId] = { jwk: body.publicKeyJwk, where: body.where, createdAt: new Date().toISOString() };
    saveStore();
    return { keyId };
  },
  'POST /api/bind/verify': async (req, res, body) => {
    const entry = store.boundKeys[body.keyId];
    if (!entry) return { ok: false, reason: 'unknown keyId' };
    if (!takeChallenge(body.challenge)) return { ok: false, reason: 'bad challenge' };
    const key = createPublicKey({ key: entry.jwk, format: 'jwk' });
    const ok = verify('sha256', Buffer.from(body.challenge), { key, dsaEncoding: 'ieee-p1363' }, fromB64url(body.signature));
    return { ok, createdAt: entry.createdAt, where: entry.where };
  },

  // パスキー（先に確かめること 3・7）。署名の検証は、公開鍵を取れたときだけ（getPublicKey）
  'POST /api/passkey/register': async (req, res, body) => {
    const check = checkClientData(body.clientDataJSON, 'webauthn.create', expectedOrigin(req));
    const auth = body.authenticatorData ? parseAuthData(fromB64url(body.authenticatorData)) : null;
    store.passkeys[body.id] = { publicKey: body.publicKey ?? null, algorithm: body.algorithm ?? null, where: body.where, createdAt: new Date().toISOString(), lastSignCount: auth?.signCount ?? null };
    saveStore();
    return { ...check, client: undefined, origin: check.client.origin, auth, rpIdHashOk: auth ? auth.rpIdHash === rpIdHashOf(req) : null, publicKeyAvailable: !!body.publicKey };
  },
  'POST /api/passkey/login': async (req, res, body) => {
    const check = checkClientData(body.clientDataJSON, 'webauthn.get', expectedOrigin(req));
    const authData = fromB64url(body.authenticatorData);
    const auth = parseAuthData(authData);
    const entry = store.passkeys[body.id] ?? null;
    let signatureOk = null;
    if (entry?.publicKey) {
      const signed = Buffer.concat([authData, createHash('sha256').update(fromB64url(body.clientDataJSON)).digest()]);
      const key = createPublicKey({ key: fromB64url(entry.publicKey), format: 'der', type: 'spki' });
      signatureOk = verify('sha256', signed, key, fromB64url(body.signature));
    }
    const previousSignCount = entry?.lastSignCount ?? null;
    if (entry) {
      entry.lastSignCount = auth.signCount;
      saveStore();
    }
    return { ...check, client: undefined, origin: check.client.origin, auth, rpIdHashOk: auth.rpIdHash === rpIdHashOf(req), known: !!entry, registeredWhere: entry?.where ?? null, signatureOk, previousSignCount };
  },

  // Web Push（先に確かめること 4・9）
  'GET /api/push/key': () => ({ publicKey: vapid.publicKey, subject: vapidSubject }),
  'POST /api/push/subscribe': async (req, res, body) => {
    const endpoint = new URL(body.subscription.endpoint);
    // 送り先は push.apple.com の下の https だけ（設計の N7 と同じ規則）
    const allowed = endpoint.protocol === 'https:' && (endpoint.hostname === 'push.apple.com' || endpoint.hostname.endsWith('.push.apple.com'));
    if (allowed) {
      store.subscriptions = [body.subscription];
      saveStore();
    }
    return { endpointHost: endpoint.hostname, allowed };
  },
  'POST /api/push/send': async () => {
    const results = [];
    for (const subscription of store.subscriptions) {
      try {
        const sent = await webpush.sendNotification(subscription, JSON.stringify({ title: 'tanacode の確かめ', body: `送った時刻 ${new Date().toLocaleTimeString('ja-JP')}` }), { TTL: 60 });
        results.push({ ok: true, status: sent.statusCode });
      } catch (error) {
        results.push({ ok: false, status: error.statusCode ?? null, body: error.body ?? String(error) });
      }
    }
    return { subject: vapidSubject, results };
  },

  // ページがまとめた結果
  'POST /api/results': async (req, res, body) => {
    record('results.jsonl', { remoteAddress: req.socket.remoteAddress, headers: pickHeaders(req.headers), results: body });
    return { saved: true };
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://placeholder');
  record('requests.jsonl', { method: req.method, path: url.pathname, remoteAddress: req.socket.remoteAddress, headers: pickHeaders(req.headers) });
  try {
    const staticFile = req.method === 'GET' ? STATIC[url.pathname] : undefined;
    if (staticFile) {
      const [name, type] = staticFile;
      return send(res, 200, readFileSync(join(publicDir, name), 'utf8'), { 'content-type': type });
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, 'not found');
    const body = req.method === 'POST' ? await readBody(req) : {};
    return send(res, 200, await route(req, res, body));
  } catch (error) {
    return send(res, 500, { error: String(error?.message ?? error) });
  }
});

// WebSocket（先に確かめること 3: serve を通るか）。来た伝文をそのまま返す。圧縮は付けない
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://placeholder');
  record('requests.jsonl', { method: 'UPGRADE', path: url.pathname, remoteAddress: req.socket.remoteAddress, headers: pickHeaders(req.headers) });
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ hello: true, remoteAddress: req.socket.remoteAddress, headers: pickHeaders(req.headers) }));
    ws.on('message', (data) => ws.send(data.toString()));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`127.0.0.1:${port} で待ち受けています。`);
  console.log(`tailscale serve の例: tailscale serve --bg ${port}`);
  console.log(`記録: ${dataDir}`);
});
