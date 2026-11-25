import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deviceNameOf, parseAuthRequest } from '@shared/remote-auth';
import { CHALLENGE_MS, PAIRING_MS, RemoteAuth, verifyBinding } from '../src/main/remote-auth';
import type { Registration } from '../src/main/remote-registrations';
import { SoftBindingKey } from './helpers/soft-authenticator';

// 遠隔操作の本人確認のうち、main が持つもの（src/main/remote-auth.ts）の端の振る舞い。通しの流れは test/remote-auth-flow.test.ts

function setup() {
  const clock = { now: 1_000_000 };
  const list: Registration[] = [];
  const registrations = {
    add: (r: Registration) => list.push(r),
    get: (id: string) => list.find((r) => r.id === id) ?? null,
    touch: vi.fn(),
  };
  const sessions: unknown[] = [];
  const deps = { registrations: registrations as never, addSession: (s: unknown) => sessions.push(s), onPairingChange: vi.fn(), onRegistrationsChange: vi.fn(), notify: vi.fn(), now: () => clock.now, sessionRegistration: vi.fn((_id: string): string | null => null), grantTicket: vi.fn(() => 'granted') };
  return { auth: new RemoteAuth(deps), clock, list, sessions, deps };
}

const credential = { id: 'Y3JlZA', publicKey: 'cHVi', counter: 0 };

function begin(t: ReturnType<typeof setup>) {
  const { code } = t.auth.startPairing();
  return t.auth.handle({ op: 'pair-begin', code }) as { pairingId: string; bindingChallenge: string };
}

describe('RemoteAuth', () => {
  it('登録の受付は 10 分で切れる。やめると消える', () => {
    const t = setup();
    t.auth.startPairing();
    expect(t.auth.pairingState()).not.toBeNull();
    t.clock.now += PAIRING_MS;
    expect(t.auth.pairingState()).toBeNull();
    t.auth.startPairing();
    t.auth.cancelPairing();
    expect(t.auth.pairingState()).toBeNull();
    t.auth.cancelPairing();
  });

  it('受付が無ければ、コードも承認も受けない', () => {
    const t = setup();
    expect(() => t.auth.handle({ op: 'pair-begin', code: '12345678' })).toThrow();
    expect(t.auth.approve('x', '000000', [])).toBe(false);
    t.auth.reject('x');
    expect(() => t.auth.handle({ op: 'pair-status', requestId: 'x' })).toThrow();
  });

  it('承認を待つ頼みは 1 つだけ。断ったら rejected、もう承認できない', () => {
    const t = setup();
    const binding = new SoftBindingKey();
    const begun = begin(t);
    const finished = t.auth.handle({ op: 'pair-finish', pairingId: begun.pairingId, credential, bindingJwk: binding.jwk, bindingSignature: binding.sign(begun.bindingChallenge), name: ' iPhone\u0000 ' }) as {
      requestId: string;
      number: string;
    };
    expect(t.auth.pairingState()?.pending).toEqual([{ requestId: finished.requestId, name: 'iPhone' }]);
    // 同じ受付で、2 つ目は受けない（束縛の乱数も使い切っている）
    expect(() => t.auth.handle({ op: 'pair-finish', pairingId: begun.pairingId, credential, bindingJwk: binding.jwk, bindingSignature: binding.sign(begun.bindingChallenge), name: 'x' })).toThrow();
    t.auth.reject(finished.requestId);
    expect(t.auth.handle({ op: 'pair-status', requestId: finished.requestId })).toEqual({ state: 'rejected' });
    expect(t.auth.approve(finished.requestId, finished.number, ['default'])).toBe(false);
    expect(t.list).toEqual([]);
  });

  it('承認したら、そのあとは新しい登録を受けない', () => {
    const t = setup();
    const binding = new SoftBindingKey();
    const begun = begin(t);
    const finished = t.auth.handle({ op: 'pair-finish', pairingId: begun.pairingId, credential, bindingJwk: binding.jwk, bindingSignature: binding.sign(begun.bindingChallenge), name: '' }) as { requestId: string; number: string };
    expect(t.auth.approve(finished.requestId, ` ${finished.number} `, ['default'])).toBe(true);
    expect(t.list).toHaveLength(1);
    expect(t.deps.onRegistrationsChange).toHaveBeenCalled();
    expect(() => t.auth.handle({ op: 'pair-begin', code: t.auth.pairingState()!.code })).toThrow();
  });

  it('束縛の乱数は 60 秒で切れ、1 回しか使えない', () => {
    const t = setup();
    const binding = new SoftBindingKey();
    t.list.push({ id: 'r1', name: 'iPhone', createdAt: 0, lastUsedAt: null, profileIds: ['default'], passkey: { credentialId: 'c', publicKey: 'p', counter: 0 }, bindingJwk: binding.jwk });
    const first = t.auth.handle({ op: 'challenge', purpose: 'login' }) as { challengeId: string; challenge: string };
    const login = (c: { challengeId: string; challenge: string }) => t.auth.handle({ op: 'login', registrationId: 'r1', counter: 0, challengeId: c.challengeId, bindingSignature: binding.sign(c.challenge) });
    const result = login(first) as { token: string };
    expect(t.sessions).toEqual([expect.objectContaining({ registrationId: 'r1', profileIds: ['default'], tokenHash: createHash('sha256').update(result.token).digest('hex') })]);
    expect(() => login(first)).toThrow();
    const late = t.auth.handle({ op: 'challenge', purpose: 'login' }) as { challengeId: string; challenge: string };
    t.clock.now += CHALLENGE_MS;
    expect(() => login(late)).toThrow();
    // 知らない登録
    const another = t.auth.handle({ op: 'challenge', purpose: 'login' }) as { challengeId: string; challenge: string };
    expect(() => t.auth.handle({ op: 'login', registrationId: 'nope', counter: 0, challengeId: another.challengeId, bindingSignature: binding.sign(another.challenge) })).toThrow();
  });

  it('乱数は控えずに出す（いくつ出しても前のものは使える）。main が出していないもの・形の違うものは受けない', () => {
    const t = setup();
    const binding = new SoftBindingKey();
    t.list.push({ id: 'r1', name: '', createdAt: 0, lastUsedAt: null, profileIds: [], passkey: { credentialId: 'c', publicKey: 'p', counter: 0 }, bindingJwk: binding.jwk });
    const first = t.auth.handle({ op: 'challenge', purpose: 'login' }) as { challengeId: string; challenge: string };
    for (let i = 0; i < 200; i++) t.auth.handle({ op: 'challenge', purpose: 'login' });
    const login = (challengeId: string, signed = challengeId) => t.auth.handle({ op: 'login', registrationId: 'r1', counter: 0, challengeId, bindingSignature: binding.sign(signed) });
    const [until, nonce, mac] = first.challenge.split('.');
    expect(() => login(`${until}.${nonce}.${mac.slice(1)}A`)).toThrow('unknown challenge');
    expect(() => login(`${Number(until) + 1}.${nonce}.${mac}`)).toThrow('unknown challenge');
    expect(() => login('a.b')).toThrow('unknown challenge');
    expect(() => login(`x.${nonce}.${mac}`)).toThrow('unknown challenge');
    expect(login(first.challengeId)).toMatchObject({ token: expect.any(String) });
    // ログインしたら、Mac のダイアログと遠隔サーバーのパスキーの数えを新しくする
    expect(t.deps.onRegistrationsChange).toHaveBeenCalled();
    // 使い終えたものは、期限が過ぎて控えを捨てたあとも、期限切れで受けない
    t.clock.now += CHALLENGE_MS;
    t.auth.handle({ op: 'challenge', purpose: 'login' });
    expect(() => login(first.challengeId)).toThrow('unknown challenge');
  });

  it('断ったら、その受付は閉じる。書き込みに失敗したら、承認の印を付けない', () => {
    const t = setup();
    const binding = new SoftBindingKey();
    const finish = () => {
      const begun = begin(t);
      return t.auth.handle({ op: 'pair-finish', pairingId: begun.pairingId, credential, bindingJwk: binding.jwk, bindingSignature: binding.sign(begun.bindingChallenge), name: 'x' }) as { requestId: string; number: string };
    };
    const rejected = finish();
    const code = t.auth.pairingState()!.code;
    t.auth.reject(rejected.requestId);
    expect(t.auth.handle({ op: 'pair-status', requestId: rejected.requestId })).toEqual({ state: 'rejected' });
    expect(() => t.auth.handle({ op: 'pair-begin', code })).toThrow('pairing is not open');
    // 書き込みに失敗（ディスクがいっぱいなど）。スマホには承認と出さず、Mac で打ち直せる
    t.auth.startPairing();
    const failing = finish();
    const add = t.deps.registrations as unknown as { add: (r: Registration) => void };
    const original = add.add;
    add.add = () => {
      throw new Error('disk full');
    };
    expect(() => t.auth.approve(failing.requestId, failing.number, [])).toThrow('disk full');
    expect(t.auth.handle({ op: 'pair-status', requestId: failing.requestId })).toEqual({ state: 'pending' });
    add.add = original;
    expect(t.auth.approve(failing.requestId, failing.number, [])).toBe(true);
  });

  it('券: 生きているセッションの登録の束縛の鍵で、券用の乱数に署名してあれば出す。用途の違う乱数・知らないセッション・違う鍵・使い回しは断る', () => {
    const t = setup();
    const binding = new SoftBindingKey();
    t.list.push({ id: 'r1', name: '', createdAt: 0, lastUsedAt: null, profileIds: [], passkey: { credentialId: 'c', publicKey: 'p', counter: 0 }, bindingJwk: binding.jwk });
    t.deps.sessionRegistration.mockImplementation((id: string) => (id === 's1' ? 'r1' : null));
    const ticketOf = (purpose: 'login' | 'ticket', sessionId = 's1', key = binding) => {
      const c = t.auth.handle({ op: 'challenge', purpose }) as { challengeId: string; challenge: string };
      return () => t.auth.handle({ op: 'ticket', sessionId, challengeId: c.challengeId, bindingSignature: key.sign(c.challenge) });
    };
    expect(ticketOf('login')).toThrow('unknown challenge');
    expect(ticketOf('ticket', 's2')).toThrow('unknown session');
    expect(ticketOf('ticket', 's1', new SoftBindingKey())).toThrow('bad binding signature');
    const once = ticketOf('ticket');
    expect(once()).toEqual({ ticket: 'granted' });
    expect(t.deps.grantTicket).toHaveBeenCalledWith('s1');
    expect(once).toThrow('unknown challenge');
    // 券用の乱数は、ログインに使えない
    const c = t.auth.handle({ op: 'challenge', purpose: 'ticket' }) as { challengeId: string; challenge: string };
    expect(() => t.auth.handle({ op: 'login', registrationId: 'r1', counter: 0, challengeId: c.challengeId, bindingSignature: binding.sign(c.challenge) })).toThrow('unknown challenge');
    // 登録が消えていれば断る
    t.deps.sessionRegistration.mockImplementation(() => 'gone');
    expect(ticketOf('ticket')).toThrow('unknown session');
  });

  it('束縛の鍵の形・署名が壊れていれば false', () => {
    const binding = new SoftBindingKey();
    expect(verifyBinding(binding.jwk, 'x', binding.sign('x'))).toBe(true);
    expect(verifyBinding({ ...binding.jwk, x: 'AA' }, 'x', binding.sign('x'))).toBe(false);
    expect(verifyBinding(binding.jwk, 'x', 'not-a-signature')).toBe(false);
  });
});

describe('parseAuthRequest・deviceNameOf', () => {
  const jwk = { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' };
  it.each([
    [{ op: 'pair-begin', code: '12345678' }],
    [{ op: 'pair-finish', pairingId: 'p', credential: { id: 'aA', publicKey: 'cA', counter: 0 }, bindingJwk: jwk, bindingSignature: 'cw', name: 'iPhone' }],
    [{ op: 'pair-status', requestId: 'r' }],
    [{ op: 'challenge', purpose: 'login' }],
    [{ op: 'challenge', purpose: 'ticket' }],
    [{ op: 'login', registrationId: 'r', counter: 1, challengeId: 'c', bindingSignature: 'cw' }],
    [{ op: 'ticket', sessionId: 's', challengeId: 'c', bindingSignature: 'cw' }],
  ])('形の合う頼み: %j', (request) => {
    expect(parseAuthRequest(request)).toEqual(request);
  });

  it.each([
    [null],
    [[]],
    [{ op: 'nope' }],
    [{ op: 'pair-begin', code: '' }],
    [{ op: 'pair-finish', pairingId: 'p', credential: null, bindingJwk: jwk, bindingSignature: 'cw', name: '' }],
    [{ op: 'pair-finish', pairingId: 'p', credential: { id: 'a+b', publicKey: 'cA', counter: 0 }, bindingJwk: jwk, bindingSignature: 'cw', name: '' }],
    [{ op: 'pair-finish', pairingId: 'p', credential: { id: 'aA', publicKey: 'cA', counter: 0 }, bindingJwk: { ...jwk, crv: 'P-384' }, bindingSignature: 'cw', name: '' }],
    [{ op: 'pair-finish', pairingId: 'p', credential: { id: 'aA', publicKey: 'cA', counter: 0 }, bindingJwk: jwk, bindingSignature: 'cw', name: 'x'.repeat(65) }],
    [{ op: 'pair-status', requestId: 1 }],
    [{ op: 'login', registrationId: 'r', counter: -1, challengeId: 'c', bindingSignature: 'cw' }],
    [{ op: 'challenge' }],
    [{ op: 'challenge', purpose: 'other' }],
    [{ op: 'ticket', sessionId: '', challengeId: 'c', bindingSignature: 'cw' }],
    [{ op: 'ticket', sessionId: 's', challengeId: 'c', bindingSignature: 'c+w' }],
    [{ op: 'pair-finish', pairingId: 'p', credential: { id: 'aA', publicKey: 'cA', counter: 0 }, bindingJwk: null, bindingSignature: 'cw', name: '' }],
  ])('形の違う頼みは null: %j', (request) => {
    expect(parseAuthRequest(request)).toBeNull();
  });

  it('端末の名前は、制御文字と向きを変える文字を除いて 40 文字まで。空なら null', () => {
    expect(deviceNameOf(' a\u0000b‮c ')).toBe('abc');
    expect(deviceNameOf('x'.repeat(50))).toBe('x'.repeat(40));
    expect(deviceNameOf('\u0001 ')).toBeNull();
  });
});
