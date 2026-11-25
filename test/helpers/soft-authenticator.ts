import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { encodeCBOR } from '@levischuck/tiny-cbor';

// テスト用の、ソフトウェアのパスキー（WebAuthn の認証器の作り物）と、束縛の鍵（P-256）。
// 遠隔サーバーの登録・ログインの口を、本物の WebAuthn の検証（@simplewebauthn/server）に通すために使う。
// 作るのは、attestation が none の登録と、UV（本人確認）を済ませた assertion

const b64url = (data: Buffer | Uint8Array) => Buffer.from(data).toString('base64url');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private counter = 0;

  constructor(
    private readonly origin: string,
    private readonly rpId = new URL(origin).hostname,
  ) {}

  private flags(withCredential: boolean): number {
    // UP（触れた）・UV（本人確認）・BE/BS（同期されるパスキー）・AT（登録のときだけ）
    return 0x01 | 0x04 | 0x08 | 0x10 | (withCredential ? 0x40 : 0);
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  // 登録（navigator.credentials.create の返事を、ページが送る形にしたもの）
  register(options: { challenge: string }, over: { origin?: string } = {}) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    const coseKey = Buffer.from(encodeCBOR(cose));
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([this.flags(true)]), counter, Buffer.alloc(16), idLength, this.credentialId, coseKey]);
    const attestationObject = Buffer.from(encodeCBOR(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never));
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, over.origin)), attestationObject: b64url(attestationObject), transports: ['internal'] },
    };
  }

  // ログイン（navigator.credentials.get の返事を、ページが送る形にしたもの）
  login(options: { challenge: string }, over: { origin?: string; id?: string } = {}) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([this.flags(false)]), counter]);
    const clientData = this.clientData('webauthn.get', options.challenge, over.origin);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.keys.privateKey);
    const id = over.id ?? b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature) },
    };
  }
}

// 束縛の鍵（ブラウザごとに作る、取り出せない P-256 の鍵の代わり）
export class SoftBindingKey {
  private readonly keys: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  get jwk(): { kty: 'EC'; crv: 'P-256'; x: string; y: string } {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
  }

  sign(text: string): string {
    return b64url(sign('sha256', Buffer.from(text), { key: this.keys.privateKey, dsaEncoding: 'ieee-p1363' }));
  }
}
