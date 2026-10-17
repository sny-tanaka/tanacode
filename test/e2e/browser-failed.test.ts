import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude がアプリ内ブラウザの失敗した通信を読む（get_failed_requests）。アプリの browser-control.ts を通って、本物の webview と
// webRequest まで（通信を出したオリジンとフレームが、本物の Electron で入るか）。
// - 許したページ（127.0.0.1）が出した通信は、URL ごと返す
// - 許していない先（[::1]）の iframe が出した通信と、許していない先の iframe の読み込みは返さず、除いた数だけを伝える

const READ = '失敗した通信を読んでください';
const DONE = '失敗した通信を読みました';
const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name: browserToolId(name), input }];

describe('アプリ内ブラウザの失敗した通信のうち、許していない先のもの', () => {
  let app: E2EApp;
  let server: Server;
  let outsideServer: Server;
  let origin: string;
  let outside: string;

  beforeAll(async () => {
    // 許す先の外（[::1]。許す先の既定 localhost・127.0.0.1・*.local に当たらない）。iframe の中で 404 の通信を出し、終わったら親に知らせる
    outsideServer = createServer((req, res) => {
      if ((req.url ?? '/').startsWith('/frame')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><script>fetch('/secret?token=frame-xhr').finally(() => parent.postMessage('frame-done', '*'));</script>`);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    await new Promise<void>((resolve) => outsideServer.listen(0, '::1', resolve));
    outside = `http://[::1]:${(outsideServer.address() as AddressInfo).port}`;
    // 許す先のページ。自分の 404 の通信・外の iframe（中で 404 の通信）・読み込みが 404 になる外の iframe。全部終わったら「済み」と書く
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>通信</title><p id="status">まだ</p>
<script>
  const own = fetch('/missing?token=top-xhr');
  const frame = new Promise((resolve) => addEventListener('message', (e) => e.data === 'frame-done' && resolve()));
  const loaded = new Promise((resolve) => addEventListener('load', resolve));
  Promise.allSettled([own, frame, loaded]).then(() => (document.getElementById('status').textContent = '済み'));
</script>
<iframe src="${outside}/frame?token=frame-doc"></iframe>
<iframe src="${outside}/missing-frame?token=frame-404"></iframe>`);
        return;
      }
      // ページの題のアイコン（ブラウザが自分で取りに行く）は、失敗にしない
      res.writeHead(path === '/favicon.ico' ? 204 : 404, { 'content-type': 'text/plain' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = await E2EApp.launch({
      trusted: true,
      claudeSettings: { permissions: { allow: [browserToolId('navigate'), browserToolId('wait_for'), browserToolId('get_failed_requests')] } },
      conversations: () => [
        {
          match: READ,
          steps: [
            tool('toolu_open', 'navigate', { url: `${origin}/` }),
            tool('toolu_wait', 'wait_for', { text: '済み', timeoutMs: 15_000 }),
            tool('toolu_failed', 'get_failed_requests', {}),
            [{ type: 'text', text: DONE }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-failed-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
    await new Promise((resolve) => outsideServer?.close(resolve));
  });

  it('許したページの通信は返し、許していない先の iframe の通信と読み込みは返さずに数だけを伝える', async () => {
    await app.startSession(READ, { mode: 'manual' });
    await app.byText('.chat-list', DONE).waitFor();
    const failed = app.api.toolResults.find((r) => r.includes('failed request') || r.includes(`${origin}/missing`));
    expect(failed).toBe(
      [`404 GET ${origin}/missing?token=top-xhr (xhr)`, '(2 more failed requests from pages or frames not allowed for Claude are not shown.)'].join('\n'),
    );
    expect(app.api.toolResults.join('\n')).not.toContain('token=frame');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
