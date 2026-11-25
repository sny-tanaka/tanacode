// 遠隔操作の本人確認（Issue #464 の段階 1 の 3 つ目）。遠隔サーバーと main の分け方:
// - パスキー（WebAuthn）の検証は、遠隔サーバーが行う（@simplewebauthn/server）。遠隔サーバーが知るのは、登録したパスキーの公開の部分だけ
// - 登録のコード・確認の数字・束縛の鍵（ブラウザごとに作る、取り出せない P-256 の鍵）の署名・セッションは、main が持つ。
//   遠隔サーバーの論理の誤りだけでは、登録したスマホが署名しない限り、誰も本人になれない（main が束縛の鍵の署名を確かめる）

// 遠隔サーバーに渡す、登録したパスキーの公開の部分（credentialId・publicKey は base64url）
export type RemoteCredential = { registrationId: string; credentialId: string; publicKey: string; counter: number };

// 束縛の鍵の公開鍵（JWK の P-256）
export type BindingJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

// 遠隔サーバー → main の、本人確認の頼み
// pair-begin: スマホが打った登録のコードを確かめる / pair-finish: 検証したパスキーと束縛の鍵を、承認待ちにする（確認の数字を作る）/
// pair-status: 承認されたか / challenge: 束縛の鍵に署名させる乱数（purpose: ログイン用か券用か。取り違えて使えない）/
// login: パスキーを検証した登録の、束縛の鍵の署名を確かめてセッションを作る /
// ticket: セッションの登録の束縛の鍵の署名を確かめて、WebSocket の券を出す（main も控え、接続のときに確かめる）
export type AuthRequest =
  | { op: 'pair-begin'; code: string }
  | { op: 'pair-finish'; pairingId: string; credential: { id: string; publicKey: string; counter: number }; bindingJwk: BindingJwk; bindingSignature: string; name: string }
  | { op: 'pair-status'; requestId: string }
  | { op: 'challenge'; purpose: ChallengePurpose }
  | { op: 'login'; registrationId: string; counter: number; challengeId: string; bindingSignature: string }
  | { op: 'ticket'; sessionId: string; challengeId: string; bindingSignature: string };

export type ChallengePurpose = 'login' | 'ticket';

// main → 遠隔サーバーの、本人確認の返事（op ごと）
export type AuthReplies = {
  'pair-begin': { pairingId: string; userId: string; bindingChallenge: string };
  'pair-finish': { requestId: string; number: string };
  'pair-status': { state: 'pending' | 'approved' | 'rejected' };
  challenge: { challengeId: string; challenge: string };
  login: { token: string; maxAgeSeconds: number };
  ticket: { ticket: string };
};

// 文字列の上限（ふつうはずっと短い）
const MAX_TEXT = 512;
const MAX_KEY = 2048;
const isText = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isB64url = (value: unknown, max = MAX_KEY): value is string => isText(value, max) && /^[A-Za-z0-9_-]+$/.test(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isBindingJwk(value: unknown): value is BindingJwk {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kty === 'EC' && v.crv === 'P-256' && isB64url(v.x, 64) && isB64url(v.y, 64);
}

// 遠隔サーバーから届いた本人確認の頼みの形を確かめる。違えば null。余分な値は捨てる
export function parseAuthRequest(value: unknown): AuthRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.op) {
    case 'pair-begin':
      return isText(v.code, 32) ? { op: 'pair-begin', code: v.code } : null;
    case 'pair-finish': {
      const c = v.credential as Record<string, unknown> | null;
      if (!isText(v.pairingId) || typeof c !== 'object' || c === null || !isB64url(c.id) || !isB64url(c.publicKey) || !isCount(c.counter)) return null;
      if (!isBindingJwk(v.bindingJwk) || !isB64url(v.bindingSignature, 256) || typeof v.name !== 'string' || v.name.length > 64) return null;
      const jwk = v.bindingJwk;
      return {
        op: 'pair-finish',
        pairingId: v.pairingId,
        credential: { id: c.id, publicKey: c.publicKey, counter: c.counter },
        bindingJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
        bindingSignature: v.bindingSignature,
        name: v.name,
      };
    }
    case 'pair-status':
      return isText(v.requestId) ? { op: 'pair-status', requestId: v.requestId } : null;
    case 'challenge':
      return v.purpose === 'login' || v.purpose === 'ticket' ? { op: 'challenge', purpose: v.purpose } : null;
    case 'login':
      return isText(v.registrationId) && isCount(v.counter) && isText(v.challengeId) && isB64url(v.bindingSignature, 256)
        ? { op: 'login', registrationId: v.registrationId, counter: v.counter, challengeId: v.challengeId, bindingSignature: v.bindingSignature }
        : null;
    case 'ticket':
      return isText(v.sessionId, 128) && isText(v.challengeId) && isB64url(v.bindingSignature, 256)
        ? { op: 'ticket', sessionId: v.sessionId, challengeId: v.challengeId, bindingSignature: v.bindingSignature }
        : null;
    default:
      return null;
  }
}

// 端末の名前を、記録・画面・通知に出せる形にする（制御文字を除き、40 文字まで。空なら「名前の無い端末」の代わりに null）
export function deviceNameOf(value: string): string | null {
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 40);
  return name === '' ? null : name;
}
