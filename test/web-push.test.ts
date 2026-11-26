import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createVapidKeys,
  encryptPayload,
  isAllowedEndpoint,
  isValidP256Point,
  parseSubscription,
  sendPush,
  vapidAuthorization,
  VAPID_SUBJECT,
} from '../src/main/web-push';

// Web Push（Issue #464）。暗号化は RFC 8291 の付録の例の値で、署名は公開鍵で確かめる

// RFC 8291 Appendix A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const subscription = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH9', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

// 受け取る側（スマホのブラウザ）と同じ手順で読む
function decrypt(body: Buffer, uaPrivate: string, auth: string): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(uaPrivate, 'base64url'));
  const hkdf = (s: Buffer, ikm: Buffer, info: Buffer, n: number) =>
    createHmac('sha256', createHmac('sha256', s).update(ikm).digest()).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, n);
  const ikm = hkdf(Buffer.from(auth, 'base64url'), ecdh.computeSecret(asPublic), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const data = body.subarray(21 + idLength);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString();
}

describe('encryptPayload', () => {
  it('RFC 8291 の付録の例と同じものを作る', () => {
    const body = encryptPayload(subscription, Buffer.from(RFC.plaintext), { senderPrivate: Buffer.from(RFC.asPrivate, 'base64url'), salt: Buffer.from(RFC.salt, 'base64url') });
    expect(body.toString('base64url')).toBe(RFC.body);
  });

  it('ふだんは送るたびに鍵と salt を作り、受け取る側の秘密鍵で読める', () => {
    const a = encryptPayload(subscription, Buffer.from('質問があります'));
    const b = encryptPayload(subscription, Buffer.from('質問があります'));
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, RFC.uaPrivate, RFC.auth)).toBe('質問があります');
  });
});

describe('VAPID', () => {
  it('ES256 の JWT に、送り先の origin・12 時間の期限・アプリの URL（個人の情報を入れない）を入れ、公開鍵で確かめられる', () => {
    const keys = createVapidKeys();
    expect(isValidP256Point(keys.publicKey)).toBe(true);
    const now = Date.UTC(2026, 10, 26);
    const header = vapidAuthorization(subscription.endpoint, keys, now);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(match[4]).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(match[1], 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(match[2], 'base64url').toString())).toEqual({ aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 60 * 60, sub: VAPID_SUBJECT });
    const point = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(match[3], 'base64url'))).toBe(true);
    expect(isValidP256Point('AAAA')).toBe(false);
  });
});

describe('送り先と購読の確かめ', () => {
  it('https で、ホストが push.apple.com の下のものだけを受ける（Mac から任意の URL へ送らせない）', () => {
    expect(isAllowedEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isAllowedEndpoint('https://push.apple.com/abc')).toBe(true);
    for (const bad of [
      'http://web.push.apple.com/abc',
      'https://push.apple.com.evil.example/abc',
      'https://evilpush.apple.com.example/',
      'https://notpush.apple.com/abc',
      'https://user:pass@web.push.apple.com/abc',
      'https://web.push.apple.com:8443/abc',
      'https://127.0.0.1/abc',
      'not a url',
      `https://web.push.apple.com/${'x'.repeat(2100)}`,
      42,
    ])
      expect(isAllowedEndpoint(bad)).toBe(false);
  });

  it('購読は、送り先と鍵の長さを確かめる', () => {
    expect(parseSubscription(subscription)).toEqual(subscription);
    expect(parseSubscription({ ...subscription, endpoint: 'https://fcm.googleapis.com/x' })).toBeNull();
    expect(parseSubscription({ ...subscription, keys: { p256dh: 'AAAA', auth: RFC.auth } })).toBeNull();
    expect(parseSubscription({ ...subscription, keys: { p256dh: RFC.uaPublic, auth: 'AAAA' } })).toBeNull();
    expect(parseSubscription({ endpoint: subscription.endpoint })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });
});

describe('sendPush', () => {
  const keys = createVapidKeys();
  const now = () => Date.UTC(2026, 10, 26);

  it('暗号化した本文を、署名と一緒に、リダイレクトを追わずに送る。404・410 は購読が無くなった、ほかの失敗は failed', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 201 }));
    await expect(sendPush(subscription, { title: 'tanacode', body: '質問があります' }, keys, { fetch: fetch as unknown as typeof globalThis.fetch, now })).resolves.toBe('ok');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(subscription.endpoint);
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '86400', urgency: 'high' });
    expect(JSON.parse(decrypt(Buffer.from(init.body as Uint8Array), RFC.uaPrivate, RFC.auth))).toEqual({ title: 'tanacode', body: '質問があります' });
    for (const [status, result] of [[410, 'gone'], [404, 'gone'], [302, 'failed'], [500, 'failed']] as const) {
      const answer = vi.fn(async () => new Response(null, { status }));
      await expect(sendPush(subscription, {}, keys, { fetch: answer as unknown as typeof globalThis.fetch, now })).resolves.toBe(result);
    }
    const broken = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(sendPush(subscription, {}, keys, { fetch: broken as unknown as typeof globalThis.fetch, now })).resolves.toBe('failed');
  });

  it('送り先が許したものでなければ、送らずに購読を捨てさせる', async () => {
    const fetch = vi.fn();
    await expect(sendPush({ ...subscription, endpoint: 'https://example.com/x' }, {}, keys, { fetch: fetch as unknown as typeof globalThis.fetch, now })).resolves.toBe('gone');
    expect(fetch).not.toHaveBeenCalled();
  });
});
