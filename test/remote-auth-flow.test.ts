import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { HostMessage } from '@shared/remote-protocol';
import { RemoteAuth } from '../src/main/remote-auth';
import { RemoteHost } from '../src/main/remote-host';
import { RemoteRegistrations } from '../src/main/remote-registrations';
import { LOGIN_FAILURES_BEFORE_WAIT, RemoteServerCore, SESSION_COOKIE } from '../src/main/remote-server-core';
import { SoftAuthenticator, SoftBindingKey } from './helpers/soft-authenticator';

// 遠隔操作の登録とログインを、通しで動かす。遠隔サーバーの中身（RemoteServerCore）・main の持ち手（RemoteHost）・
// 本人確認（RemoteAuth）・登録の一覧（RemoteRegistrations）を本物でつなぎ、本物の HTTP と、本物の WebAuthn の検証を通す
// （パスキーと束縛の鍵は、test/helpers/soft-authenticator.ts の作り物）

const ORIGIN = 'https://mac.example.ts.net';
const HOST = 'mac.example.ts.net';

type World = Awaited<ReturnType<typeof world>>;
let current: World | null = null;

afterEach(() => {
  current?.host.stop();
  if (current) rmSync(current.dir, { recursive: true, force: true });
  current = null;
});

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'tanacode-remote-'));
  let seq = 0;
  const registrations = new RemoteRegistrations(
    join(dir, 'remote-registrations.bin'),
    { available: () => true, encrypt: (text) => Buffer.from(text).reverse(), decrypt: (data) => Buffer.from(data).reverse().toString() },
    { get: () => seq, set: (next) => (seq = next) },
  );
  const notices: unknown[] = [];
  let auth: RemoteAuth;
  let core: RemoteServerCore;
  let toHost: (message: unknown) => void = () => {};
  const host = new RemoteHost({
    spawn: () => ({
      post: (message: HostMessage) => core.handle(message),
      onMessage: (listener) => (toHost = listener),
      onExit: () => {},
      kill: () => {},
    }),
    call: async () => 'ok',
    onStatus: () => {},
    onConnections: () => {},
    log: () => {},
    auth: (r) => auth.handle(r),
  });
  core = new RemoteServerCore((message) => toHost(message));
  auth = new RemoteAuth({
    registrations,
    addSession: (session) => host.addSession(session),
    onPairingChange: () => {},
    onRegistrationsChange: () => host.setCredentials(registrations.credentials()),
    notify: (event) => notices.push(event),
  });
  host.start({ port: 0, publicOrigin: ORIGIN, language: 'ja' });
  await vi.waitFor(() => expect(host.current().state).toBe('listening'));
  const status = host.current();
  const port = status.state === 'listening' ? status.port : 0;
  const w = { dir, registrations, auth, host, core, port, notices, seq: () => seq };
  current = w;
  return w;
}

function post(port: number, path: string, body: unknown, cookie?: string): Promise<{ status: number | null; body: Record<string, unknown>; cookie: string | null }> {
  return new Promise((resolve) => {
    const text = JSON.stringify(body);
    const headers: Record<string, string> = { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) };
    if (cookie) headers.cookie = cookie;
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const set = res.headers['set-cookie']?.[0] ?? null;
        resolve({ status: res.statusCode ?? null, body: data ? (JSON.parse(data) as Record<string, unknown>) : {}, cookie: set });
      });
    });
    req.on('error', () => resolve({ status: null, body: {}, cookie: null }));
    req.end(text);
  });
}

// 登録の流れを、承認の手前まで進める
async function pairUntilNumber(w: World, passkey: SoftAuthenticator, binding: SoftBindingKey, name = 'iPhone') {
  const { code } = w.auth.startPairing();
  const begun = await post(w.port, '/api/pair/begin', { code });
  expect(begun.status).toBe(200);
  const options = begun.body.options as { challenge: string; rp: { id: string }; authenticatorSelection: { userVerification: string } };
  const finished = await post(w.port, '/api/pair/finish', {
    pairingId: begun.body.pairingId,
    response: passkey.register(options),
    bindingJwk: binding.jwk,
    bindingSignature: binding.sign(String(begun.body.bindingChallenge)),
    name,
  });
  return { begun, finished, options };
}

async function login(w: World, passkey: SoftAuthenticator, binding: SoftBindingKey, over: { origin?: string } = {}) {
  const begun = await post(w.port, '/api/login/begin', {});
  return post(w.port, '/api/login/finish', {
    response: passkey.login(begun.body.options as { challenge: string }, over),
    challengeId: begun.body.challengeId,
    bindingSignature: binding.sign(String(begun.body.bindingChallenge)),
  });
}

describe('遠隔操作の登録とログイン（通し）', () => {
  it('コード → パスキーの登録 → Mac で数字を打って承認 → ログインで Cookie → 券 → WebSocket につながる', async () => {
    const w = await world();
    const passkey = new SoftAuthenticator(ORIGIN);
    const binding = new SoftBindingKey();
    const { finished, options } = await pairUntilNumber(w, passkey, binding);
    // RP ID はホスト名の全体。UV を求める
    expect(options.rp.id).toBe(HOST);
    expect(options.authenticatorSelection.userVerification).toBe('required');
    expect(finished.status).toBe(200);
    const number = String(finished.body.number);
    expect(number).toMatch(/^\d{6}$/);
    // Mac のダイアログには、承認を待っている頼みが出る（数字は出さない）
    expect(w.auth.pairingState()?.pending).toEqual([{ requestId: finished.body.requestId, name: 'iPhone' }]);
    expect((await post(w.port, '/api/pair/status', { requestId: finished.body.requestId })).body).toEqual({ state: 'pending' });

    expect(w.auth.approve(String(finished.body.requestId), number, ['default'])).toBe(true);
    expect(w.registrations.all()).toMatchObject([{ name: 'iPhone', profileIds: ['default'], bindingJwk: binding.jwk }]);
    expect(w.seq()).toBe(1);
    expect((await post(w.port, '/api/pair/status', { requestId: finished.body.requestId })).body).toEqual({ state: 'approved' });

    const loggedIn = await login(w, passkey, binding);
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]+; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$`));
    expect(w.notices).toEqual([{ kind: 'login', name: 'iPhone' }]);
    expect(w.registrations.all()[0].lastUsedAt).not.toBeNull();

    const cookie = loggedIn.cookie!.split(';')[0];
    const ticket = await post(w.port, '/api/ticket', {}, cookie);
    expect(ticket.status).toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${w.port}/ws`, { headers: { host: HOST, origin: ORIGIN, cookie } });
    const first = await new Promise<unknown>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ticket: ticket.body.ticket })));
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(first).toEqual({ type: 'ready' });
    expect(w.host.connectionCount()).toBe(1);
    ws.close();
  });

  it('確認の数字が違えば断り、登録しない（スマホには rejected）', async () => {
    const w = await world();
    const { finished } = await pairUntilNumber(w, new SoftAuthenticator(ORIGIN), new SoftBindingKey());
    const wrong = String((Number(finished.body.number) + 1) % 1_000_000).padStart(6, '0');
    expect(w.auth.approve(String(finished.body.requestId), wrong, ['default'])).toBe(false);
    expect(w.registrations.all()).toEqual([]);
    expect((await post(w.port, '/api/pair/status', { requestId: finished.body.requestId })).body).toEqual({ state: 'rejected' });
  });

  it('登録の束縛の鍵の署名が違えば、承認待ちにしない', async () => {
    const w = await world();
    const passkey = new SoftAuthenticator(ORIGIN);
    const { code } = w.auth.startPairing();
    const begun = await post(w.port, '/api/pair/begin', { code });
    const finished = await post(w.port, '/api/pair/finish', {
      pairingId: begun.body.pairingId,
      response: passkey.register(begun.body.options as { challenge: string }),
      bindingJwk: new SoftBindingKey().jwk,
      bindingSignature: new SoftBindingKey().sign(String(begun.body.bindingChallenge)),
      name: 'x',
    });
    expect(finished.status).toBe(400);
    expect(w.auth.pairingState()?.pending).toEqual([]);
  });

  it('パスキーの Origin が違う登録は断る', async () => {
    const w = await world();
    const passkey = new SoftAuthenticator('https://evil.example.ts.net', HOST);
    const { finished } = await pairUntilNumber(w, passkey, new SoftBindingKey());
    expect(finished.status).toBe(400);
  });

  it('間違ったコードは 5 回まで。そのあとは正しいコードでも受けない', async () => {
    const w = await world();
    const { code } = w.auth.startPairing();
    for (let i = 0; i < 5; i++) expect((await post(w.port, '/api/pair/begin', { code: '00000000' === code ? '11111111' : '00000000' })).status).toBe(400);
    expect((await post(w.port, '/api/pair/begin', { code })).status).toBe(400);
  });

  it('パスキーの登録が届いたあとに正しいコードがまた来たら、受付を捨てて Mac に知らせる（横取りの試み）', async () => {
    const w = await world();
    const { finished } = await pairUntilNumber(w, new SoftAuthenticator(ORIGIN), new SoftBindingKey());
    expect(finished.status).toBe(200);
    expect((await post(w.port, '/api/pair/begin', { code: w.auth.pairingState()?.code ?? 'gone' })).status).toBe(400);
    expect(w.auth.pairingState()).toBeNull();
    expect(w.notices).toEqual([{ kind: 'pairing-hijack' }]);
  });

  it('登録が届く前のやり直し（Face ID を取りやめて押し直す）は、前の頼みを捨てて入れ替える。知らせない', async () => {
    const w = await world();
    const passkey = new SoftAuthenticator(ORIGIN);
    const binding = new SoftBindingKey();
    const { code } = w.auth.startPairing();
    const first = await post(w.port, '/api/pair/begin', { code });
    const second = await post(w.port, '/api/pair/begin', { code });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.pairingId).not.toBe(first.body.pairingId);
    const finish = (begun: typeof first) =>
      post(w.port, '/api/pair/finish', {
        pairingId: begun.body.pairingId,
        response: passkey.register(begun.body.options as { challenge: string; rp: { id: string } }),
        bindingJwk: binding.jwk,
        bindingSignature: binding.sign(String(begun.body.bindingChallenge)),
        name: 'iPhone',
      });
    expect((await finish(first)).status).toBe(400);
    expect((await finish(second)).status).toBe(200);
    expect(w.notices).toEqual([]);
  });

  it('Mac で数字を打ち間違えたら、その受付は閉じる（同じコードでのやり直しは断り、知らせない）', async () => {
    const w = await world();
    const { finished } = await pairUntilNumber(w, new SoftAuthenticator(ORIGIN), new SoftBindingKey());
    const code = w.auth.pairingState()!.code;
    expect(w.auth.approve(String(finished.body.requestId), '000000' === finished.body.number ? '111111' : '000000', ['default'])).toBe(false);
    expect((await post(w.port, '/api/pair/status', { requestId: finished.body.requestId })).body).toEqual({ state: 'rejected' });
    expect((await post(w.port, '/api/pair/begin', { code })).status).toBe(400);
    expect(w.notices).toEqual([]);
  });

  it('ログイン: 束縛の鍵が違う（パスキーだけを持つ別のブラウザ）・Origin が違う・知らないパスキーなら、セッションを作らない', async () => {
    const w = await world();
    const passkey = new SoftAuthenticator(ORIGIN);
    const binding = new SoftBindingKey();
    const { finished } = await pairUntilNumber(w, passkey, binding);
    w.auth.approve(String(finished.body.requestId), String(finished.body.number), ['default']);
    expect((await login(w, passkey, new SoftBindingKey())).status).toBe(400);
    expect((await login(w, passkey, binding, { origin: 'https://evil.example.ts.net' })).status).toBe(400);
    expect((await login(w, new SoftAuthenticator(ORIGIN), binding)).status).toBe(400);
    expect(w.notices).toEqual([]);
  });

  it('登録を取り消したら、そのセッションの券は出ず、ログインもできない', async () => {
    const w = await world();
    const passkey = new SoftAuthenticator(ORIGIN);
    const binding = new SoftBindingKey();
    const { finished } = await pairUntilNumber(w, passkey, binding);
    w.auth.approve(String(finished.body.requestId), String(finished.body.number), ['default']);
    const cookie = (await login(w, passkey, binding)).cookie!.split(';')[0];
    const id = w.registrations.all()[0].id;
    w.registrations.remove(id);
    w.host.removeRegistration(id);
    w.host.setCredentials(w.registrations.credentials());
    expect((await post(w.port, '/api/ticket', {}, cookie)).status).toBe(401);
    expect((await login(w, passkey, binding)).status).toBe(400);
  });

  it('ログインに続けて失敗したパスキーは待たせる（429）。待ち受け全体では数えない', async () => {
    const w = await world();
    const passkey = new SoftAuthenticator(ORIGIN);
    const binding = new SoftBindingKey();
    const { finished } = await pairUntilNumber(w, passkey, binding);
    w.auth.approve(String(finished.body.requestId), String(finished.body.number), ['default']);
    // 認証の前の誰かが、始めるだけの頼み・知らないパスキーの頼みを重ねても、本人のログインは止まらない
    for (let i = 0; i < 100; i++) await post(w.port, '/api/login/begin', {});
    for (let i = 0; i < 10; i++) await post(w.port, '/api/login/finish', { response: { id: 'nope' } });
    expect((await post(w.port, '/api/pair/status', { requestId: 'x' })).status).toBe(400);
    expect((await login(w, passkey, binding)).status).toBe(200);
    // 束縛の鍵の違う失敗が続いたら、そのパスキーは待たせる
    for (let i = 0; i < LOGIN_FAILURES_BEFORE_WAIT; i++) expect((await login(w, passkey, new SoftBindingKey())).status).toBe(400);
    expect((await login(w, passkey, binding)).status).toBe(429);
  });

  it('欠けた本文の頼みは、どの口でも 400', async () => {
    const w = await world();
    w.auth.startPairing();
    for (const path of ['/api/pair/begin', '/api/pair/finish', '/api/pair/status', '/api/login/finish']) expect((await post(w.port, path, {})).status).toBe(400);
    // 開いている受付でも、欠けた本文の登録は断る
    const begun = await post(w.port, '/api/pair/begin', { code: w.auth.pairingState()!.code });
    expect((await post(w.port, '/api/pair/finish', { pairingId: begun.body.pairingId })).status).toBe(400);
  });

  it('ログインの challenge は 1 回だけ。同じ答えを送り直しても、改ざんしても通らない', async () => {
    const w = await world();
    const passkey = new SoftAuthenticator(ORIGIN);
    const binding = new SoftBindingKey();
    const { finished } = await pairUntilNumber(w, passkey, binding);
    w.auth.approve(String(finished.body.requestId), String(finished.body.number), ['default']);
    const begun = await post(w.port, '/api/login/begin', {});
    const body = {
      response: passkey.login(begun.body.options as { challenge: string }),
      challengeId: begun.body.challengeId,
      bindingSignature: binding.sign(String(begun.body.bindingChallenge)),
    };
    expect((await post(w.port, '/api/login/finish', body)).status).toBe(200);
    expect((await post(w.port, '/api/login/finish', body)).status).toBe(400);
    // 遠隔サーバーが出していない challenge（HMAC が合わない）
    const forged = Buffer.from(`${Date.now() + 60_000}.abc.def`).toString('base64url');
    expect((await post(w.port, '/api/login/finish', { ...body, response: passkey.login({ challenge: forged }) })).status).toBe(400);
  });
});
