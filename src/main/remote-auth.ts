import { createHash, createHmac, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify } from 'node:crypto';
import { deviceNameOf, type AuthReplies, type AuthRequest, type BindingJwk, type ChallengePurpose } from '@shared/remote-auth';
import type { RemoteSession } from '@shared/remote-protocol';
import type { Registration, RemoteRegistrations } from './remote-registrations';

// 遠隔操作の本人確認のうち、main が持つもの（Issue #464。分け方は shared/remote-auth.ts）。
// 登録: Mac の「端末を追加」で、登録のコード（8 桁）を作る（10 分。打ち間違いは 5 回まで。パスキーの登録が届いたあとに正しいコードがまた来たら、横取りの試みとして全部を捨てる）→
//   スマホの PWA がコードを打つ（pair-begin）→ 遠隔サーバーがパスキーの登録を検証し、束縛の鍵の署名と一緒に渡す（pair-finish）→
//   main が、自分の乱数と公開鍵から確認の数字（6 桁）を作り、スマホに出させる → 持ち主が Mac で数字を打って承認する（approve）→ 登録の一覧に書く
// ログイン: 遠隔サーバーがパスキーを検証した登録について、main が作った乱数（challenge）への束縛の鍵の署名を確かめ、セッションを作る
//   乱数は控えずに、期限と main の鍵の HMAC を付けて出す（認証の前の誰かが乱数をたくさん頼んでも、本人の分を押し出せないように）。
//   使い終えた乱数だけを、期限まで控える（ログインできた本人の分だけなので、増えすぎない）

export const PAIRING_MS = 10 * 60 * 1000;
export const PAIRING_ATTEMPTS = 5;
// 束縛の鍵に署名させる乱数の期限
export const CHALLENGE_MS = 60 * 1000;
// セッションの長い方の期限
export const SESSION_MS = 12 * 60 * 60 * 1000;

// 承認を待っている登録の頼み（Mac のダイアログに出す。確認の数字は出さない。スマホに出た数字を、人が打つ）
export type PendingPairing = { requestId: string; name: string };

// 登録の受付の様子（Mac のダイアログに出す）。code: 登録のコード / until: 期限 / pending: 承認を待っているもの
export type PairingState = { code: string; until: number; pending: PendingPairing[] } | null;

type Pending = PendingPairing & { number: string; credential: Registration['passkey']; bindingJwk: BindingJwk; state: 'pending' | 'approved' | 'rejected' };
type Pairing = { pairingId: string; code: string; until: number; attempts: number; secret: Buffer; userId: string; bindingChallenge: string | null; pending: Map<string, Pending> };

export type RemoteAuthDeps = {
  registrations: RemoteRegistrations;
  // 作ったセッションを、遠隔の持ち手（RemoteHost）に渡す
  addSession: (session: RemoteSession) => void;
  // 登録の受付・承認待ちが変わった（Mac のダイアログを作り直す）/ 登録の一覧が変わった（遠隔サーバーにパスキーを送り直す）
  onPairingChange: () => void;
  onRegistrationsChange: () => void;
  // Mac に知らせること（横取りの試み・新しいログイン）
  notify: (event: { kind: 'pairing-hijack' } | { kind: 'login'; name: string }) => void;
  // 生きているセッションの登録（無い・切れていれば null）/ そのセッションに WebSocket の券を出す（RemoteHost が控える）
  sessionRegistration: (sessionId: string) => string | null;
  grantTicket: (sessionId: string) => string;
  now?: () => number;
};

const b64url = (data: Buffer) => data.toString('base64url');

// 束縛の鍵の署名（ECDSA P-256・SHA-256・r||s）を確かめる。鍵や署名の形が違っても false
export function verifyBinding(jwk: BindingJwk, challenge: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: { ...jwk }, format: 'jwk' });
    return verify('sha256', Buffer.from(challenge), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

function sameText(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

export class RemoteAuth {
  private pairing: Pairing | null = null;
  // ログインの乱数に付ける HMAC の鍵 / 使い終えた乱数（期限まで）
  private readonly challengeKey = randomBytes(32);
  private readonly usedChallenges = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: RemoteAuthDeps) {
    this.now = deps.now ?? Date.now;
  }

  // Mac の「端末を追加」。前の受付は捨てる
  startPairing(): NonNullable<PairingState> {
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    this.pairing = {
      pairingId: b64url(randomBytes(16)),
      code,
      until: this.now() + PAIRING_MS,
      attempts: 0,
      secret: randomBytes(32),
      userId: b64url(randomBytes(16)),
      bindingChallenge: null,
      pending: new Map(),
    };
    this.deps.onPairingChange();
    return this.pairingState()!;
  }

  cancelPairing(): void {
    if (!this.pairing) return;
    this.pairing = null;
    this.deps.onPairingChange();
  }

  pairingState(): PairingState {
    const p = this.openPairing();
    if (!p) return null;
    return { code: p.code, until: p.until, pending: [...p.pending.values()].filter((x) => x.state === 'pending').map(({ requestId, name }) => ({ requestId, name })) };
  }

  // Mac で、スマホに出た確認の数字を打って承認する。数字が違えば false（その頼みは断る）。承認したら、受付を閉じる
  approve(requestId: string, number: string, profileIds: string[]): boolean {
    const p = this.openPairing();
    const pending = p?.pending.get(requestId);
    if (!p || !pending || pending.state !== 'pending') return false;
    if (!sameText(pending.number, number.trim())) {
      pending.state = 'rejected';
      this.closeAnswered(p);
      return false;
    }
    // 書けてから承認の印を付ける（書けなければ、スマホには承認と出さない）
    this.deps.registrations.add({
      id: b64url(randomBytes(16)),
      name: pending.name,
      createdAt: this.now(),
      lastUsedAt: null,
      profileIds: [...profileIds],
      passkey: { ...pending.credential },
      bindingJwk: { ...pending.bindingJwk },
    });
    pending.state = 'approved';
    this.deps.onRegistrationsChange();
    this.closeAnswered(p);
    return true;
  }

  reject(requestId: string): void {
    const p = this.openPairing();
    const pending = p?.pending.get(requestId);
    if (!p || !pending || pending.state !== 'pending') return;
    pending.state = 'rejected';
    this.closeAnswered(p);
  }

  // 承認・断ったあと。結果は、スマホが pair-status で読むまで残し、受付は、これ以上の登録を受けない（やり直すときは、Mac で受付を始め直す）
  private closeAnswered(p: Pairing): void {
    p.until = Math.min(p.until, this.now() + 60 * 1000);
    p.attempts = PAIRING_ATTEMPTS;
    this.deps.onPairingChange();
  }

  // 遠隔サーバーから届いた、本人確認の頼み。断るときは投げる（理由はスマホに出す）
  handle(request: AuthRequest): AuthReplies[keyof AuthReplies] {
    switch (request.op) {
      case 'pair-begin':
        return this.pairBegin(request.code);
      case 'pair-finish':
        return this.pairFinish(request);
      case 'pair-status':
        return this.pairStatus(request.requestId);
      case 'challenge':
        return this.challenge(request.purpose);
      case 'login':
        return this.login(request);
      case 'ticket':
        return this.ticket(request);
    }
  }

  private openPairing(): Pairing | null {
    if (this.pairing && this.pairing.until <= this.now()) {
      this.pairing = null;
      this.deps.onPairingChange();
    }
    return this.pairing;
  }

  private pairBegin(code: string): AuthReplies['pair-begin'] {
    const p = this.openPairing();
    if (!p || p.attempts >= PAIRING_ATTEMPTS) throw new Error('pairing is not open');
    if (!sameText(p.code, code.trim())) {
      // 間違ったコードは、試せる回数に数えるだけ（同じネットワークの誰でも、登録を潰せないように）
      p.attempts += 1;
      throw new Error('wrong code');
    }
    if (p.pending.size > 0) {
      // パスキーの登録が届いたあとに、正しいコードがまた来た（QR やコードを盗み見られた）。全部を捨てて、Mac に知らせる
      this.pairing = null;
      this.deps.onPairingChange();
      this.deps.notify({ kind: 'pairing-hijack' });
      throw new Error('pairing was cancelled');
    }
    // まだ登録が届いていなければ、前の頼みを捨てて入れ替える（Face ID を取りやめて押し直したときなど、本人のやり直し）
    p.pairingId = b64url(randomBytes(16));
    p.bindingChallenge = b64url(randomBytes(32));
    return { pairingId: p.pairingId, userId: p.userId, bindingChallenge: p.bindingChallenge };
  }

  private pairFinish(request: Extract<AuthRequest, { op: 'pair-finish' }>): AuthReplies['pair-finish'] {
    const p = this.openPairing();
    if (!p || p.pairingId !== request.pairingId || !p.bindingChallenge || p.pending.size > 0) throw new Error('pairing is not open');
    if (!verifyBinding(request.bindingJwk, p.bindingChallenge, request.bindingSignature)) throw new Error('bad binding signature');
    p.bindingChallenge = null;
    const requestId = b64url(randomBytes(16));
    // 確認の数字は、main の乱数と、作られたパスキーと束縛の公開鍵から決める（相手が鍵を選んで、望む数字にできないように）
    const mac = createHmac('sha256', p.secret).update(`${request.credential.id}.${request.bindingJwk.x}.${request.bindingJwk.y}`).digest();
    const number = String(mac.readUInt32BE(0) % 1_000_000).padStart(6, '0');
    p.pending.set(requestId, {
      requestId,
      name: deviceNameOf(request.name) ?? '',
      number,
      credential: { credentialId: request.credential.id, publicKey: request.credential.publicKey, counter: request.credential.counter },
      bindingJwk: { ...request.bindingJwk },
      state: 'pending',
    });
    this.deps.onPairingChange();
    return { requestId, number };
  }

  private pairStatus(requestId: string): AuthReplies['pair-status'] {
    const pending = this.openPairing()?.pending.get(requestId);
    if (!pending) throw new Error('unknown pairing request');
    return { state: pending.state };
  }

  // HMAC には用途も混ぜる（ログイン用の乱数を券に、券用の乱数をログインに使えないように）
  private challengeMac(purpose: ChallengePurpose, body: string): string {
    return b64url(createHmac('sha256', this.challengeKey).update(`${purpose}|${body}`).digest());
  }

  // 乱数は「期限.乱数.HMAC」。challengeId も同じ値（控えずに、届いたものを確かめる）
  private challenge(purpose: ChallengePurpose): AuthReplies['challenge'] {
    const body = `${this.now() + CHALLENGE_MS}.${b64url(randomBytes(32))}`;
    const challenge = `${body}.${this.challengeMac(purpose, body)}`;
    return { challengeId: challenge, challenge };
  }

  // main がその用途で出した、期限の内の、まだ使っていない乱数なら true
  private validChallenge(challenge: string, purpose: ChallengePurpose): boolean {
    const now = this.now();
    for (const [used, until] of this.usedChallenges) if (until <= now) this.usedChallenges.delete(used);
    const parts = challenge.split('.');
    if (parts.length !== 3 || this.usedChallenges.has(challenge)) return false;
    const until = Number(parts[0]);
    return Number.isFinite(until) && until > now && sameText(parts[2], this.challengeMac(purpose, `${parts[0]}.${parts[1]}`));
  }

  private login(request: Extract<AuthRequest, { op: 'login' }>): AuthReplies['login'] {
    const challenge = request.challengeId;
    if (!this.validChallenge(challenge, 'login')) throw new Error('unknown challenge');
    const registration = this.deps.registrations.get(request.registrationId);
    if (!registration) throw new Error('unknown registration');
    if (!verifyBinding(registration.bindingJwk, challenge, request.bindingSignature)) throw new Error('bad binding signature');
    const now = this.now();
    this.usedChallenges.set(challenge, Number(challenge.split('.')[0]));
    this.deps.registrations.touch(registration.id, request.counter, now);
    // 遠隔サーバーのパスキーの数え（counter）と、Mac のダイアログの最後に使った時刻を新しくする
    this.deps.onRegistrationsChange();
    const token = b64url(randomBytes(32));
    this.deps.addSession({
      sessionId: b64url(randomBytes(16)),
      tokenHash: createHash('sha256').update(token).digest('hex'),
      registrationId: registration.id,
      profileIds: [...registration.profileIds],
      expiresAt: now + SESSION_MS,
      lastActive: now,
    });
    this.deps.notify({ kind: 'login', name: registration.name });
    return { token, maxAgeSeconds: Math.floor(SESSION_MS / 1000) };
  }

  // WebSocket の券。そのセッションの登録の束縛の鍵で、券用の乱数に署名してあれば出す（Cookie だけを得た相手は、つなげない）
  private ticket(request: Extract<AuthRequest, { op: 'ticket' }>): AuthReplies['ticket'] {
    const challenge = request.challengeId;
    if (!this.validChallenge(challenge, 'ticket')) throw new Error('unknown challenge');
    const registrationId = this.deps.sessionRegistration(request.sessionId);
    const registration = registrationId ? this.deps.registrations.get(registrationId) : null;
    if (!registration) throw new Error('unknown session');
    if (!verifyBinding(registration.bindingJwk, challenge, request.bindingSignature)) throw new Error('bad binding signature');
    this.usedChallenges.set(challenge, Number(challenge.split('.')[0]));
    return { ticket: this.deps.grantTicket(request.sessionId) };
  }

}
