import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserToolId } from '@shared/browser-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude がアプリ内ブラウザのスクリーンショットを撮れるか。アプリの browser-control.ts から、本物の webview の capturePage・CDP まで。
// 表示中の範囲・ページ全体・要素の 3 通りを、ブラウザが見えているときと、閉じて見ていないとき（透明にして描かせたままのタブ）に撮る。
// 画面のロックなどでウインドウが描かれなくなったときのことは、ここでは確かめられない（test/browser-control-page.test.ts が、
// 撮る間だけ描かせ続けることと、返ってこないときの断り方を確かめる）

const OPEN = 'ページを開いて撮ってください';
const AGAIN = 'もう一度撮ってください';
const DONE = '撮り終えました';
const DONE_AGAIN = 'もう一度撮り終えました';
const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name, input }];
const shots = (prefix: string): Block[][] => [
  tool(`${prefix}_view`, browserToolId('screenshot'), {}),
  tool(`${prefix}_full`, browserToolId('screenshot'), { fullPage: true }),
  tool(`${prefix}_el`, browserToolId('screenshot'), { selector: 'h1' }),
];

describe('Claude がアプリ内ブラウザを撮る', () => {
  let app: E2EApp;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>E2E</title><h1>撮るページ</h1><div style="height:3000px">長いページ</div>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    app = await E2EApp.launch({
      trusted: true,
      // 2 つめの発言の応答も、同じ会話の続きとして返す
      conversations: () => [{ match: OPEN, steps: [tool('toolu_open', browserToolId('navigate'), { url }), ...shots('toolu_a'), [{ type: 'text', text: DONE }], ...shots('toolu_b'), [{ type: 'text', text: DONE_AGAIN }]] }],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`browser-shot-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  // スクリーンショットの結果（撮れたものは、画像に添える文。撮れなかったものは、断った理由）
  const results = () => app.api.toolResults.filter((r) => /image \d+×\d+|screenshot|Did not finish/.test(r));
  const expectShots = (list: string[]) => {
    expect(list).toHaveLength(3);
    expect(list[0]).toMatch(new RegExp(`Visible area, ${url}, image \\d+×\\d+`));
    // 幅の 2.5 倍より長いページなので、上から切って撮る
    expect(list[1]).toMatch(/Top \d+px of the page \(full height \d+px; .*image \d+×\d+/);
    expect(list[2]).toMatch(new RegExp(`h1 \\(h1 "撮るページ"\\), ${url}, image \\d+×\\d+`));
  };

  it('ブラウザが見えているとき、表示中の範囲・ページ全体・要素を撮れる', async () => {
    await app.startSession(OPEN, { mode: 'manual' });
    const card = await app.menuCard('permission');
    await app.choose(card, /^Yes/);
    await app.byText('.chat-list', DONE).waitFor();
    expectShots(results());
  });

  it('ブラウザを閉じて見ていないときも、同じように撮れる', async () => {
    await app.page.click('.preview-pane [aria-label="ブラウザを閉じる"]');
    await app.page.locator('.preview-pane.offstage').waitFor({ state: 'attached' });
    await app.send(AGAIN);
    await app.byText('.chat-list', DONE_AGAIN).waitFor();
    expectShots(results().slice(3));
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
