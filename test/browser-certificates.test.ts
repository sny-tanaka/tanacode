import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { certificateErrorHint, isLocalHost, trustLocalCertificates } from '../src/main/browser-certificates';
import { FakeContents } from './helpers/fake-electron';
import { setup, textOf } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザの証明書の扱い（src/main/browser-certificates.ts）。この Mac の中の先だけ、証明書の誤りを通す

type Proc = (request: { hostname: string; verificationResult: string; errorCode: number }, callback: (result: number) => void) => void;

// プレビューのセッションに付けた確かめ方で、hostname の証明書を確かめた答え
function verify(hostname: string, verificationResult = 'net::ERR_CERT_AUTHORITY_INVALID'): number {
  let proc: Proc | null = null;
  trustLocalCertificates({ setCertificateVerifyProc: (p: Proc) => (proc = p) } as unknown as Session);
  let answer = NaN;
  proc!({ hostname, verificationResult, errorCode: verificationResult === 'net::OK' ? 0 : -202 }, (result) => (answer = result));
  return answer;
}

describe('証明書の誤り', () => {
  it('この Mac の中の先（localhost・*.localhost・127.0.0.1・[::1]）は、誤りがあっても通す', () => {
    for (const host of ['localhost', 'app.localhost', 'a.b.localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) expect(verify(host), host).toBe(0);
  });

  it('ほかの先（*.local・外のサイト・似た名前・ループバックの別のアドレス）は、Chromium の確かめたとおりにする', () => {
    for (const host of ['myapp.local', 'example.com', 'localhost.example.com', 'evil-localhost', '127.0.0.2', '192.168.0.10', '::2', ''])
      expect(verify(host), host).toBe(-3);
  });

  it('誤りの無い証明書は、この Mac の中の先でも Chromium の確かめたとおりにする', () => {
    expect(verify('localhost', 'net::OK')).toBe(-3);
  });

  it('ホスト名に使わない文字を含むものは、この Mac の中の先と見なさない', () => {
    for (const host of ['evil.com/.localhost', 'evil.com#.localhost', 'user@localhost', 'evil.com?.localhost', 'local host']) expect(isLocalHost(host), host).toBe(false);
  });
});

describe('Claude への説明', () => {
  it('証明書の誤りで開けなかったときだけ、この Mac の中の先しか通さないことを添える', () => {
    expect(certificateErrorHint('ERR_CERT_AUTHORITY_INVALID (-202) loading https://stg.example.com/')).toContain('never for other hosts');
    expect(certificateErrorHint('ERR_CONNECTION_REFUSED (-102)')).toBe('');
    expect(certificateErrorHint('ERR_SSL_PROTOCOL_ERROR (-107)')).toBe('');
  });

  it('navigate で開けなかった理由が証明書の誤りなら、Claude に説明を返す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { open, call, state } = setup();
      state.hosts = ['stg.example.com'];
      const page: FakeContents = open('http://localhost:3000/');
      page.load = async () => {
        throw new Error("ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://stg.example.com/'");
      };
      const result = await call('navigate', { url: 'https://stg.example.com/' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Could not open https://stg.example.com/ (ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://stg.example.com/'). The certificate of this site could not be verified.");
    } finally {
      vi.useRealTimers();
    }
  });
});
