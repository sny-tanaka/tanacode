import { describe, expect, it } from 'vitest';
import { parseServerMessage, publicOriginOf } from '@shared/remote-protocol';
import { DEFAULT_REMOTE_SETTINGS, remoteSettingsOf } from '@shared/remote-settings';

describe('parseServerMessage（遠隔サーバーから届いた伝文の形）', () => {
  it.each([
    [{ type: 'listening', port: 47413 }],
    [{ type: 'listen-failed', reason: 'in-use', message: 'x' }],
    [{ type: 'closed' }],
    [{ type: 'connected', clientId: 'c', sessionId: 's' }],
    [{ type: 'disconnected', clientId: 'c' }],
    [{ type: 'call', id: 1, clientId: 'c', profileId: 'default', kind: 'invoke', channel: 'sessions:list', args: [] }],
    [{ type: 'subscribe', clientId: 'c', channels: ['pty:data'] }],
  ])('形の合う伝文は、そのまま使う: %j', (message) => {
    expect(parseServerMessage(message)).toEqual(message);
  });

  it.each([
    [null],
    [[]],
    [{ type: 'nope' }],
    [{ type: 'listening', port: -1 }],
    [{ type: 'listen-failed', reason: 'maybe', message: 'x' }],
    [{ type: 'connected', clientId: '', sessionId: 's' }],
    [{ type: 'connected', clientId: 'x'.repeat(129), sessionId: 's' }],
    [{ type: 'call', id: 1, clientId: 'c', kind: 'invoke', channel: 'a', args: [] }],
    [{ type: 'call', id: 1.5, clientId: 'c', profileId: 'p', kind: 'invoke', channel: 'a', args: [] }],
    [{ type: 'call', id: 1, clientId: 'c', profileId: 'p', kind: 'other', channel: 'a', args: [] }],
    [{ type: 'call', id: 1, clientId: 'c', profileId: 'p', kind: 'invoke', channel: 'a', args: {} }],
    [{ type: 'subscribe', clientId: 'c', channels: [1] }],
  ])('形の違う伝文は null: %j', (message) => {
    expect(parseServerMessage(message)).toBeNull();
  });

  it('余分な値は捨てる', () => {
    expect(parseServerMessage({ type: 'disconnected', clientId: 'c', extra: 1 })).toEqual({ type: 'disconnected', clientId: 'c' });
  });
});

describe('publicOriginOf（公開する URL）', () => {
  it.each([
    ['https://mac.example.ts.net', 'https://mac.example.ts.net'],
    ['https://mac.example.ts.net/', 'https://mac.example.ts.net'],
    [' https://mac.example.ts.net:8443 ', 'https://mac.example.ts.net:8443'],
  ])('%s → %s', (url, origin) => {
    expect(publicOriginOf(url)).toBe(origin);
  });

  it.each(['http://mac.example.ts.net', 'https://mac.example.ts.net/app', 'https://u:p@mac.example.ts.net', 'https://mac.example.ts.net/?a=1', 'https://mac.example.ts.net/#x', 'mac.example.ts.net', ''])(
    '使えない形: %s',
    (url) => {
      expect(publicOriginOf(url)).toBeNull();
    },
  );
});

describe('remoteSettingsOf（保存した遠隔操作の設定）', () => {
  it('形の合う設定は、そのまま読む', () => {
    expect(remoteSettingsOf({ enabled: true, port: 50000, publicUrl: 'https://mac.example.ts.net' })).toEqual({ enabled: true, port: 50000, publicUrl: 'https://mac.example.ts.net' });
  });

  it('無い・形が違うときは既定（オフ）', () => {
    expect(remoteSettingsOf(undefined)).toEqual(DEFAULT_REMOTE_SETTINGS);
    expect(remoteSettingsOf({ enabled: 'yes', port: 80, publicUrl: 1 })).toEqual(DEFAULT_REMOTE_SETTINGS);
  });

  it('公開する URL が使えない形なら、オンでも待ち受けない', () => {
    expect(remoteSettingsOf({ enabled: true, port: 50000, publicUrl: 'http://mac.example.ts.net' }).enabled).toBe(false);
  });
});
