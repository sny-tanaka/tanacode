// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { waitFor } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginPage } from '../src/main/remote-login-page';

// 認証の前の画面（src/main/remote-login-page.ts）のスクリプトを、jsdom で動かす。
// 束縛の鍵の置き場所（IndexedDB の pending と binding）の入れ替えと、Safari のままでは押せないことを確かめる。
// パスキー（navigator.credentials）と遠隔サーバー（fetch）は作り物にする

type Key = { privateKey: webcrypto.CryptoKey; jwk: { x: string; y: string } };

// IndexedDB の、スクリプトが使う所だけ（open・objectStore の put・get・delete・transaction の oncomplete）
function fakeIndexedDb() {
  const data = new Map<string, unknown>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  const db = {
    createObjectStore: () => undefined,
    transaction: () => {
      const tx: { oncomplete?: () => void; onerror?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({
          get: (key: string) => {
            const req = { result: data.get(key) };
            later(() => tx.oncomplete?.());
            return req;
          },
          put: (value: unknown, key: string) => {
            data.set(key, value);
            later(() => tx.oncomplete?.());
            return { result: key };
          },
          delete: (key: string) => {
            data.delete(key);
            later(() => tx.oncomplete?.());
            return { result: undefined };
          },
        }),
      };
      return tx;
    },
  };
  const api = {
    open: () => {
      const req: { result: typeof db; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = { result: db };
      later(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { api, data };
}

const buffer = (text: string) => new TextEncoder().encode(text).buffer;

// 遠隔サーバーの作り物。パスごとに返事を決める（関数が投げたら 400）
function fakeServer(routes: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (path: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ path, body });
    try {
      const value = await routes[path](body);
      return { ok: true, json: async () => value };
    } catch {
      return { ok: false, status: 400, json: async () => ({}) };
    }
  });
  return { fetch, calls };
}

const credential = (extra: Record<string, unknown>) => ({
  id: 'cred',
  rawId: buffer('cred'),
  type: 'public-key',
  authenticatorAttachment: 'platform',
  getClientExtensionResults: () => ({}),
  response: { clientDataJSON: buffer('{}'), getTransports: () => ['internal'], ...extra },
});

async function load(routes: Record<string, (body: Record<string, unknown>) => unknown>, over: { userAgent?: string; standalone?: boolean; keys?: Record<string, Key>; hash?: string } = {}) {
  const page = String(loginPage('/')!.body);
  document.documentElement.innerHTML = page.slice(page.indexOf('<html>') + '<html>'.length, page.lastIndexOf('</html>'));
  const idb = fakeIndexedDb();
  for (const [name, key] of Object.entries(over.keys ?? {})) idb.data.set(name, key);
  const server = fakeServer(routes);
  vi.stubGlobal('indexedDB', idb.api);
  vi.stubGlobal('fetch', server.fetch);
  vi.stubGlobal('matchMedia', () => ({ matches: over.standalone ?? true }));
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value: over.userAgent ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', configurable: true });
  Object.defineProperty(navigator, 'credentials', {
    value: {
      create: async () => credential({ attestationObject: buffer('att') }),
      get: async () => credential({ authenticatorData: buffer('auth'), signature: buffer('sig'), userHandle: buffer('user') }),
    },
    configurable: true,
  });
  if (over.hash !== undefined) window.location.hash = over.hash;
  new Function(String(loginPage('/login.js')!.body))();
  const $ = (id: string) => document.getElementById(id)!;
  return {
    idb,
    server,
    $,
    status: () => $('status').textContent,
    error: () => ($('error').hidden ? '' : $('error').textContent),
    notice: () => ($('notice').hidden ? '' : $('notice').textContent),
    // いま出している段（install・pair・number・login・done）
    step: () => (document.querySelector('[data-step]:not([hidden])') as HTMLElement | null)?.dataset.step ?? null,
  };
}

// 署名した鍵が、どの公開鍵のものか
async function signedBy(key: Key, text: string, signature: string): Promise<boolean> {
  const publicKey = await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.jwk.x, y: key.jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(text));
}

async function newKey(): Promise<Key> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { x: jwk.x!, y: jwk.y! } };
}

const pairRoutes = (states: string[]) => ({
  '/api/pair/begin': () => ({ pairingId: 'p', bindingChallenge: 'bc', options: { challenge: 'Y2g', user: { id: 'dXNlcg', name: 'tanacode' } } }),
  '/api/pair/finish': () => ({ requestId: 'r', number: '123456' }),
  '/api/pair/status': () => {
    const state = states.shift();
    if (!state) throw new Error('gone');
    return { state };
  },
});

const loginRoutes = (finish: (body: Record<string, unknown>) => unknown = () => ({ ok: true })) => ({
  '/api/login/begin': () => ({ options: { challenge: 'Y2g' }, challengeId: 'c', bindingChallenge: 'lc' }),
  '/api/login/finish': finish,
});

const M = () => JSON.parse(document.getElementById('messages')!.textContent!) as Record<string, string>;

afterEach(() => {
  window.location.hash = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('認証の前の画面のスクリプト', () => {
  it('最初の段: 鍵が無ければ登録、鍵があればログイン、QR から開いたら（#pair=）鍵があっても登録。登録し直す・ログインに戻るで切り替える', async () => {
    const none = await load({});
    await waitFor(() => expect(none.step()).toBe('pair'));
    expect(none.$('to-login').hidden).toBe(true);

    const current = await newKey();
    const registered = await load({}, { keys: { binding: current } });
    await waitFor(() => expect(registered.step()).toBe('login'));
    registered.$('to-pair').click();
    expect(registered.step()).toBe('pair');
    expect(registered.$('to-login').hidden).toBe(false);
    registered.$('to-login').click();
    expect(registered.step()).toBe('login');

    const scanned = await load({}, { keys: { pending: current }, hash: '#pair=12345678' });
    await waitFor(() => expect(scanned.step()).toBe('pair'));
    expect((scanned.$('code') as HTMLInputElement).value).toBe('12345678');
    expect((scanned.$('name') as HTMLInputElement).placeholder).toBe(M().namePlaceholder);
  });

  it('登録: 確認の数字を大きく出して承認を待つ。新しい束縛の鍵は承認されるまで pending に置き、承認されたら binding に移してログインの段に進む', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { idb, server, $, step, notice } = await load(pairRoutes(['pending', 'approved']));
    ($('code') as HTMLInputElement).value = ' 12345678 ';
    $('pair').click();
    await waitFor(() => expect(step()).toBe('number'));
    expect($('number').textContent).toBe('123456');
    expect(idb.data.has('pending')).toBe(true);
    expect(idb.data.has('binding')).toBe(false);
    expect(server.calls[0]).toEqual({ path: '/api/pair/begin', body: { code: '12345678' } });
    await vi.advanceTimersByTimeAsync(4000);
    await waitFor(() => expect(step()).toBe('login'));
    expect(idb.data.has('binding')).toBe(true);
    expect(idb.data.has('pending')).toBe(false);
    expect(notice()).toBe(M().approved);
    await waitFor(() => expect(($('pair') as HTMLButtonElement).disabled).toBe(false));
  });

  it('登録を断られたら、理由を出して登録の段に戻り、今の束縛の鍵（binding）を残す', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const current = await newKey();
    const { idb, $, step, error } = await load(pairRoutes(['rejected']), { keys: { binding: current } });
    $('pair').click();
    await waitFor(() => expect(step()).toBe('number'));
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(step()).toBe('pair'));
    expect(error()).toBe(M().rejected);
    expect(idb.data.get('binding')).toBe(current);
  });

  it('承認を読みそこねて pending に残った鍵は、ログインで先に試し、通ったら binding に移す', async () => {
    const pending = await newKey();
    const { idb, server, $, step } = await load(loginRoutes(), { keys: { pending } });
    await waitFor(() => expect(step()).toBe('login'));
    $('login').click();
    await waitFor(() => expect(step()).toBe('done'));
    expect(idb.data.get('binding')).toBe(pending);
    expect(idb.data.has('pending')).toBe(false);
    const finish = server.calls.find((c) => c.path === '/api/login/finish')!;
    expect(await signedBy(pending, 'lc', String(finish.body.bindingSignature))).toBe(true);
  });

  it('pending の鍵で通らなければ捨てて、binding で試す。どちらも無ければ、登録されていないと出す', async () => {
    const pending = await newKey();
    const current = await newKey();
    const tries: string[] = [];
    const { idb, server, $, step } = await load(
      loginRoutes((body) => {
        tries.push(String(body.bindingSignature));
        if (tries.length === 1) throw new Error('bad binding');
        return { ok: true };
      }),
      { keys: { pending, binding: current } },
    );
    $('login').click();
    await waitFor(() => expect(step()).toBe('done'));
    expect(tries).toHaveLength(2);
    expect(idb.data.has('pending')).toBe(false);
    expect(idb.data.get('binding')).toBe(current);
    expect(await signedBy(current, 'lc', tries[1])).toBe(true);
    expect(server.calls.filter((c) => c.path === '/api/login/begin')).toHaveLength(2);

    // pending しか無く、それで通らなければ失敗と出し、ボタンを押せるように戻す
    const only = await load(loginRoutes(() => { throw new Error('no'); }), { keys: { pending } });
    only.$('login').click();
    await waitFor(() => expect(only.error()).toBe(M().failed));
    expect(only.idb.data.has('pending')).toBe(false);
    expect((only.$('login') as HTMLButtonElement).disabled).toBe(false);
    expect(only.status()).toBe('');

    // Face ID を取りやめた・通信が切れた（遠隔サーバーが断ったのではない）ときは、pending を残す
    const cancelled = await load(loginRoutes(), { keys: { pending, binding: current } });
    Object.defineProperty(navigator, 'credentials', { value: { get: async () => { throw new Error('NotAllowedError'); } }, configurable: true });
    cancelled.$('login').click();
    await waitFor(() => expect(cancelled.error()).toBe(M().failed));
    expect(cancelled.idb.data.get('pending')).toBe(pending);
    expect(cancelled.idb.data.get('binding')).toBe(current);

    const none = await load(loginRoutes());
    none.$('login').click();
    await waitFor(() => expect(none.error()).toBe(M().noKey));
    expect(none.server.calls).toEqual([]);
  });

  it('iPhone の Safari のままでは、ホーム画面に追加する手順だけを出し、登録もログインも押せない。ホーム画面から開けば押せる。iPhone でなければ押せる', async () => {
    const safari = await load({}, { standalone: false });
    expect(safari.step()).toBe('install');
    expect(safari.$('install-3').textContent).toBe(M().installStep3);
    expect((safari.$('login') as HTMLButtonElement).disabled).toBe(true);
    expect((safari.$('pair') as HTMLButtonElement).disabled).toBe(true);
    const home = await load({}, { standalone: true });
    expect((home.$('login') as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(home.step()).toBe('pair'));
    const android = await load({}, { standalone: false, userAgent: 'Mozilla/5.0 (Linux; Android 15)' });
    expect((android.$('pair') as HTMLButtonElement).disabled).toBe(false);
  });

  it('鍵を読めなければ、登録の段を出す', async () => {
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('blocked'); } });
    const page = String(loginPage('/')!.body);
    document.documentElement.innerHTML = page.slice(page.indexOf('<html>') + '<html>'.length, page.lastIndexOf('</html>'));
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    new Function(String(loginPage('/login.js')!.body))();
    await waitFor(() => expect((document.querySelector('[data-step]:not([hidden])') as HTMLElement).dataset.step).toBe('pair'));
  });
});
