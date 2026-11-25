import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BindingJwk, RemoteCredential } from '@shared/remote-auth';

// 遠隔操作で登録した端末（ブラウザ）の一覧（Issue #464）。
// - safeStorage（Keychain の鍵）で暗号化して userData に置く。中身は、パスキーと束縛の鍵の公開の部分と、許したプロファイル
// - 通し番号（seq）を、書くたびに 1 つ上げ、同じ番号をアプリの設定にも控える。ファイルの通し番号が控えより小さければ、
//   古いファイルに戻された（取り消した登録を戻された）ものとして読まない（遠隔はオフにする）
// - 約束するのは「許可なしにファイルを書けない Claude には破れない」まで。任意のコードを動かせる同じユーザーのプロセスは対象外

export type Registration = {
  id: string;
  // 登録のときにスマホで付けた名前（deviceNameOf で整えたもの）
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  // 許したプロファイル
  profileIds: string[];
  passkey: { credentialId: string; publicKey: string; counter: number };
  bindingJwk: BindingJwk;
};

// 暗号化（Electron の safeStorage の、使う所だけ。テストでは作り物にする）
export type Encryptor = { available(): boolean; encrypt(text: string): Buffer; decrypt(data: Buffer): string };

// 通し番号の控え（アプリの設定）
export type SeqStore = { get(): number; set(seq: number): void };

// 読めなかった理由。unavailable: 暗号化が使えない / unreadable: 読めない・形が違う / rolled-back: 古いファイルに戻された
export type RegistrationsProblem = 'unavailable' | 'unreadable' | 'rolled-back';

type Stored = { seq: number; registrations: Registration[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function registrationOf(value: unknown): Registration | null {
  if (!isRecord(value) || !isRecord(value.passkey) || !isRecord(value.bindingJwk)) return null;
  const { id, name, createdAt, lastUsedAt, profileIds, passkey, bindingJwk } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof createdAt !== 'number') return null;
  if (lastUsedAt !== null && typeof lastUsedAt !== 'number') return null;
  if (!Array.isArray(profileIds) || !profileIds.every((p) => typeof p === 'string')) return null;
  if (typeof passkey.credentialId !== 'string' || typeof passkey.publicKey !== 'string' || typeof passkey.counter !== 'number') return null;
  if (bindingJwk.kty !== 'EC' || bindingJwk.crv !== 'P-256' || typeof bindingJwk.x !== 'string' || typeof bindingJwk.y !== 'string') return null;
  return {
    id,
    name,
    createdAt,
    lastUsedAt,
    profileIds: [...profileIds],
    passkey: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, counter: passkey.counter },
    bindingJwk: { kty: 'EC', crv: 'P-256', x: bindingJwk.x, y: bindingJwk.y },
  };
}

export class RemoteRegistrations {
  private list: Registration[] = [];
  private seq = 0;
  private trouble: RegistrationsProblem | null = null;

  constructor(
    private readonly file: string,
    private readonly encryptor: Encryptor,
    private readonly seqStore: SeqStore,
  ) {
    this.load();
  }

  // 読めなかった理由（読めたら null）。理由があるあいだは、遠隔の待ち受けを始めない
  problem(): RegistrationsProblem | null {
    return this.trouble;
  }

  all(): Registration[] {
    return this.list.map((r) => ({ ...r, profileIds: [...r.profileIds], passkey: { ...r.passkey }, bindingJwk: { ...r.bindingJwk } }));
  }

  get(id: string): Registration | null {
    return this.all().find((r) => r.id === id) ?? null;
  }

  // 遠隔サーバーに渡す、パスキーの公開の部分
  credentials(): RemoteCredential[] {
    return this.list.map((r) => ({ registrationId: r.id, credentialId: r.passkey.credentialId, publicKey: r.passkey.publicKey, counter: r.passkey.counter }));
  }

  add(registration: Registration): void {
    this.write([...this.list.filter((r) => r.id !== registration.id), registration]);
  }

  remove(id: string): boolean {
    if (!this.list.some((r) => r.id === id)) return false;
    this.write(this.list.filter((r) => r.id !== id));
    return true;
  }

  // ログインしたとき。パスキーの数え（counter）と、最後に使った時刻を控える
  touch(id: string, counter: number, at: number): void {
    this.write(this.list.map((r) => (r.id === id ? { ...r, lastUsedAt: at, passkey: { ...r.passkey, counter: Math.max(r.passkey.counter, counter) } } : r)));
  }

  private load(): void {
    if (!this.encryptor.available()) {
      this.trouble = 'unavailable';
      return;
    }
    const expected = this.seqStore.get();
    if (!existsSync(this.file)) {
      // ファイルが無いのに、控えでは書いたことがある（消された）。消されたなら、登録は無いものとして読み直せばよいので、巻き戻しには数えない
      this.seq = expected;
      return;
    }
    let stored: Stored;
    try {
      const data = JSON.parse(this.encryptor.decrypt(readFileSync(this.file))) as unknown;
      if (!isRecord(data) || typeof data.seq !== 'number' || !Array.isArray(data.registrations)) throw new Error('shape');
      const registrations = data.registrations.map(registrationOf);
      if (registrations.some((r) => r === null)) throw new Error('shape');
      stored = { seq: data.seq, registrations: registrations as Registration[] };
    } catch {
      this.trouble = 'unreadable';
      return;
    }
    if (stored.seq < expected) {
      this.trouble = 'rolled-back';
      return;
    }
    this.seq = stored.seq;
    this.list = stored.registrations;
  }

  // 一時ファイルに書いてから置き換える。通し番号はファイルに書けてから控える（控えだけが進んで、次の起動で読めなくならないように）
  private write(next: Registration[]): void {
    if (this.trouble) throw new Error(`the remote registrations cannot be written (${this.trouble})`);
    const seq = this.seq + 1;
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, this.encryptor.encrypt(JSON.stringify({ seq, registrations: next } satisfies Stored)), { mode: 0o600 });
    renameSync(temp, this.file);
    this.seq = seq;
    this.list = next;
    this.seqStore.set(seq);
  }
}
