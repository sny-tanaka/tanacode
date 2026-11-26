import { createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';

// Web Push（Issue #464。スマホの画面を閉じている間の通知）。外の部品は使わず、Node の暗号の機能だけで書く（決めたこと）。
// - 本文の暗号化: RFC 8291（aes128gcm。RFC 8188 の形）。受け取る側（スマホのブラウザ）の公開鍵と auth で暗号化するので、
//   通知の中継（Apple）には中身が読めない
// - 送り主の署名: RFC 8292（VAPID。ES256 の JWT）。鍵は Mac ごとに作り、safeStorage に置く（呼ぶ側）

const b64url = (data: Buffer | Uint8Array): string => Buffer.from(data).toString('base64url');
const fromB64url = (text: string): Buffer => Buffer.from(text, 'base64url');

// スマホのブラウザが渡す購読（PushSubscription.toJSON() の形）
export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } };

// VAPID の鍵（P-256）。publicKey: 非圧縮の点（65 バイト）の base64url（スマホの applicationServerKey に渡す）/ privateKey: 秘密の値（32 バイト）の base64url
export type VapidKeys = { publicKey: string; privateKey: string };

export function createVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

// 秘密の値と公開鍵から、署名に使う鍵を作る
function signingKey(keys: VapidKeys): KeyObject {
  const point = fromB64url(keys.publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
    format: 'jwk',
  });
}

// 送り先として受ける URL か。https で、ホストが push.apple.com の下のものだけ（Mac から任意の URL へ送らせない。SSRF を防ぐ）
export function isAllowedEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === 'push.apple.com' || url.hostname.endsWith('.push.apple.com'));
  } catch {
    return false;
  }
}

// 購読の形を確かめる（スマホから届いたもの）。送り先・鍵の形が違えば null
export function parseSubscription(value: unknown): PushSubscriptionJson | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!isAllowedEndpoint(v.endpoint)) return null;
  const p256dh = v.keys?.p256dh;
  const auth = v.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (!isValidP256Point(p256dh) || fromB64url(auth).length !== 16) return null;
  return { endpoint: v.endpoint, keys: { p256dh, auth } };
}

// VAPID の Authorization（vapid t=<JWT>, k=<公開鍵>）。aud は送り先の origin、sub は連絡先（このアプリの URL。使う人の個人の情報は入れない）
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now: number, subject = VAPID_SUBJECT): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject })));
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64url(signature)}, k=${keys.publicKey}`;
}

export const VAPID_SUBJECT = 'https://github.com/sny-tanaka/tanacode';

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

// 本文を暗号化する（RFC 8291）。senderPrivate・salt は、テストで規格の例の値を渡すときだけ（ふだんは毎回作る）
export function encryptPayload(
  subscription: PushSubscriptionJson,
  plaintext: Buffer,
  fixed: { senderPrivate?: Buffer; salt?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const ecdh = createECDH('prime256v1');
  if (fixed.senderPrivate) ecdh.setPrivateKey(fixed.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  // 1 つのレコードに収める（最後のレコードの区切りは 0x02）
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// 公開鍵が P-256 の点として正しいか（壊れた鍵で送らない）
export function isValidP256Point(publicKey: string): boolean {
  try {
    const point = fromB64url(publicKey);
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) }, format: 'jwk' });
    return point.length === 65 && point[0] === 4;
  } catch {
    return false;
  }
}

// 送った結果。gone: 購読が無くなった（404・410。登録から消す）/ failed: そのほかの失敗（次の通知でまた試す）
export type PushResult = 'ok' | 'gone' | 'failed';

// 通知を 1 つ送る。送り先は、購読を受けたときにも確かめたが、送る前にも確かめる。リダイレクトは追わない（SSRF を防ぐ）
export async function sendPush(
  subscription: PushSubscriptionJson,
  payload: unknown,
  keys: VapidKeys,
  deps: { fetch: typeof fetch; now: () => number },
): Promise<PushResult> {
  if (!isAllowedEndpoint(subscription.endpoint)) return 'gone';
  try {
    const body = encryptPayload(subscription, Buffer.from(JSON.stringify(payload)));
    const res = await deps.fetch(subscription.endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: vapidAuthorization(subscription.endpoint, keys, deps.now()),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        // 届けられなければ 1 日で捨てる。質問・許可の確認は急ぐ
        ttl: '86400',
        urgency: 'high',
      },
      body: new Uint8Array(body),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.status >= 200 && res.status < 300 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
