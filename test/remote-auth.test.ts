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
  const deps = { registrations: registrations as never, addSession: (s: unknown) => sessions.push(s), onPairingChange: vi.fn(), onRegistrationsChange: vi.fn(), notify: vi.fn(), now: () => clock.now };
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
    const first = t.auth.handle({ op: 'challenge' }) as { challengeId: string; challenge: string };
    const login = (c: { challengeId: string; challenge: string }) => t.auth.handle({ op: 'login', registrationId: 'r1', counter: 0, challengeId: c.challengeId, bindingSignature: binding.sign(c.challenge) });
    const result = login(first) as { token: string };
    expect(t.sessions).toEqual([expect.objectContaining({ registrationId: 'r1', profileIds: ['default'], tokenHash: createHash('sha256').update(result.token).digest('hex') })]);
    expect(() => login(first)).toThrow();
    const late = t.auth.handle({ op: 'challenge' }) as { challengeId: string; challenge: string };
    t.clock.now += CHALLENGE_MS;
    expect(() => login(late)).toThrow();
    // 知らない登録
    const another = t.auth.handle({ op: 'challenge' }) as { challengeId: string; challenge: string };
    expect(() => t.auth.handle({ op: 'login', registrationId: 'nope', counter: 0, challengeId: another.challengeId, bindingSignature: binding.sign(another.challenge) })).toThrow();
  });

  it('同時に出す乱数は 64 まで（古いものから捨てる）', () => {
    const t = setup();
    const first = t.auth.handle({ op: 'challenge' }) as { challengeId: string };
    for (let i = 0; i < 64; i++) t.auth.handle({ op: 'challenge' });
    expect(() => t.auth.handle({ op: 'login', registrationId: 'r1', counter: 0, challengeId: first.challengeId, bindingSignature: 'AA' })).toThrow('unknown challenge');
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
    [{ op: 'challenge' }],
    [{ op: 'login', registrationId: 'r', counter: 1, challengeId: 'c', bindingSignature: 'cw' }],
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
  ])('形の違う頼みは null: %j', (request) => {
    expect(parseAuthRequest(request)).toBeNull();
  });

  it('端末の名前は、制御文字と向きを変える文字を除いて 40 文字まで。空なら null', () => {
    expect(deviceNameOf(' a\u0000b‮c ')).toBe('abc');
    expect(deviceNameOf('x'.repeat(50))).toBe('x'.repeat(40));
    expect(deviceNameOf('\u0001 ')).toBeNull();
  });
});
