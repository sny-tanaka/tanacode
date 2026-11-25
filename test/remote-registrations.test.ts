import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteRegistrations, type Encryptor, type Registration } from '../src/main/remote-registrations';

// 遠隔操作で登録した端末の一覧（src/main/remote-registrations.ts）。暗号化と、古いファイルに戻されたことの見つけ方

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const reverse: Encryptor = { available: () => true, encrypt: (text) => Buffer.from(text).reverse(), decrypt: (data) => Buffer.from(data).reverse().toString() };

function setup(encryptor: Encryptor = reverse) {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-registrations-'));
  const file = join(dir, 'remote-registrations.bin');
  const control = { seq: 0 };
  const seqStore = { get: () => control.seq, set: (seq: number) => (control.seq = seq) };
  const open = (e: Encryptor = encryptor) => new RemoteRegistrations(file, e, seqStore);
  return { file, control, open };
}

const registration = (over: Partial<Registration> = {}): Registration => ({
  id: 'r1',
  name: 'iPhone',
  createdAt: 1,
  lastUsedAt: null,
  profileIds: ['default'],
  passkey: { credentialId: 'cred', publicKey: 'pub', counter: 0 },
  bindingJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  ...over,
});

describe('RemoteRegistrations', () => {
  it('足した登録を暗号化して書き、通し番号を控えにも書く。開き直すと読める', () => {
    const { file, control, open } = setup();
    const list = open();
    list.add(registration());
    expect(control.seq).toBe(1);
    expect(readFileSync(file).toString()).not.toContain('iPhone');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(open().all()).toEqual([registration()]);
    expect(open().credentials()).toEqual([{ registrationId: 'r1', credentialId: 'cred', publicKey: 'pub', counter: 0 }]);
  });

  it('使った時刻と数えを控え、数えは小さくしない。取り消せる', () => {
    const { open } = setup();
    const list = open();
    list.add(registration({ passkey: { credentialId: 'cred', publicKey: 'pub', counter: 5 } }));
    list.touch('r1', 3, 100);
    expect(list.get('r1')).toMatchObject({ lastUsedAt: 100, passkey: { counter: 5 } });
    expect(list.remove('nope')).toBe(false);
    expect(list.remove('r1')).toBe(true);
    expect(open().all()).toEqual([]);
  });

  it('古いファイルに戻されたら（通し番号が控えより小さい）、読まずに rolled-back にし、書けない', () => {
    const { file, open } = setup();
    const list = open();
    list.add(registration());
    copyFileSync(file, `${file}.old`);
    list.remove('r1');
    copyFileSync(`${file}.old`, file);
    const reopened = open();
    expect(reopened.problem()).toBe('rolled-back');
    expect(reopened.all()).toEqual([]);
    expect(() => reopened.add(registration())).toThrow();
  });

  it('読めない・形が違えば unreadable', () => {
    const { file, open } = setup();
    writeFileSync(file, 'garbage');
    expect(open().problem()).toBe('unreadable');
    writeFileSync(file, Buffer.from(JSON.stringify({ seq: 1, registrations: [{ id: 1 }] })).reverse());
    expect(open().problem()).toBe('unreadable');
  });

  it('登録の形が 1 つでも違えば unreadable', () => {
    const { file, open } = setup();
    const good = registration();
    const broken: unknown[] = [
      { ...good, id: 1 },
      { ...good, name: 1 },
      { ...good, createdAt: '1' },
      { ...good, lastUsedAt: '1' },
      { ...good, profileIds: 'default' },
      { ...good, profileIds: [1] },
      { ...good, passkey: { ...good.passkey, credentialId: 1 } },
      { ...good, passkey: { ...good.passkey, publicKey: 1 } },
      { ...good, passkey: { ...good.passkey, counter: '0' } },
      { ...good, passkey: null },
      { ...good, bindingJwk: { ...good.bindingJwk, kty: 'RSA' } },
      { ...good, bindingJwk: { ...good.bindingJwk, crv: 'P-384' } },
      { ...good, bindingJwk: { ...good.bindingJwk, x: 1 } },
      { ...good, bindingJwk: { ...good.bindingJwk, y: 1 } },
      { ...good, bindingJwk: [] },
      [],
    ];
    for (const r of broken) {
      writeFileSync(file, Buffer.from(JSON.stringify({ seq: 1, registrations: [r] })).reverse());
      expect(open().problem()).toBe('unreadable');
    }
    writeFileSync(file, Buffer.from(JSON.stringify({ seq: 1, registrations: [{ ...good, lastUsedAt: 5 }] })).reverse());
    expect(open().all()).toMatchObject([{ lastUsedAt: 5 }]);
  });

  it('知らない登録は null。使った時刻は、その登録にだけ控える', () => {
    const { open } = setup();
    const list = open();
    list.add(registration());
    list.add(registration({ id: 'r2' }));
    expect(list.get('nope')).toBeNull();
    list.touch('r2', 3, 9);
    expect(list.all().map((r) => r.lastUsedAt)).toEqual([null, 9]);
  });

  it('暗号化が使えなければ unavailable（読みも書きもしない）', () => {
    const { open } = setup({ ...reverse, available: () => false });
    expect(open().problem()).toBe('unavailable');
  });

  it('やり直すと、読めなかった一覧を捨てて空にし、通し番号を控えとファイルの大きいほうより上にする', () => {
    const { file, control, open } = setup();
    const list = open();
    list.add(registration());
    copyFileSync(file, `${file}.old`);
    list.remove('r1');
    copyFileSync(`${file}.old`, file);
    // 古いファイルに戻された（ファイル 1・控え 2）
    const rolled = open();
    rolled.reset();
    expect(rolled.problem()).toBeNull();
    expect(control.seq).toBe(3);
    expect(open().all()).toEqual([]);
    // 壊れたファイル・通し番号の無いファイルは、控えより上にする
    for (const broken of [Buffer.from('garbage'), Buffer.from(JSON.stringify({ registrations: [] })).reverse()]) {
      writeFileSync(file, broken);
      const unreadable = open();
      expect(unreadable.problem()).toBe('unreadable');
      const before = control.seq;
      unreadable.reset();
      expect(control.seq).toBe(before + 1);
      expect(open().problem()).toBeNull();
    }
    // ファイルの通し番号のほうが大きければ、それより上にする
    writeFileSync(file, Buffer.from(JSON.stringify({ seq: 50, registrations: 'x' })).reverse());
    const ahead = open();
    ahead.reset();
    expect(control.seq).toBe(51);
  });

  it('暗号化が使えなければ、やり直しても何もしない', () => {
    const { file, control, open } = setup({ ...reverse, available: () => false });
    const list = open();
    list.reset();
    expect(list.problem()).toBe('unavailable');
    expect(control.seq).toBe(0);
    expect(() => readFileSync(file)).toThrow();
  });

  it('ファイルが無ければ空。控えの通し番号から続ける', () => {
    const { control, open } = setup();
    control.seq = 7;
    const list = open();
    expect(list.problem()).toBeNull();
    list.add(registration());
    expect(control.seq).toBe(8);
  });

  it('渡す一覧は写し（中身を変えても、控えは変わらない）', () => {
    const { open } = setup();
    const list = open();
    list.add(registration());
    list.all()[0].profileIds.push('other');
    expect(list.get('r1')?.profileIds).toEqual(['default']);
  });
});
