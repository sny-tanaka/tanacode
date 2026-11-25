import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 遠隔サーバーの入り口（src/main/remote-server.ts）。utilityProcess の process.parentPort の伝文を、中身（RemoteServerCore）につなぐ

afterEach(() => {
  delete (process as { parentPort?: unknown }).parentPort;
  vi.resetModules();
});

describe('remote-server.ts', () => {
  it('main から届いた伝文を中身に渡し、中身の伝文を main に送る', async () => {
    const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
    (process as { parentPort?: unknown }).parentPort = parent;
    vi.resetModules();
    await import('../src/main/remote-server');
    parent.emit('message', { data: { type: 'listen', config: { port: 0, publicOrigin: 'https://mac.example.ts.net', language: 'ja' } } });
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'listening' })));
    parent.emit('message', { data: { type: 'close' } });
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith({ type: 'closed' }));
  });
});
