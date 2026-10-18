import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// 使う人が足した MCP サーバーの人への質問（MCP の elicitation）に、チャットのカードで答える。本物の画面から、IPC・main・本物の
// Claude Code を通って MCP サーバー（test/cli/elicit-mcp-server.mjs）まで届くか。URL の形は、「ページを開く」でふだんのブラウザを開き
// （ここでは shell.openExternal を差し替えて、開いた URL を控える）、MCP サーバーの完了の知らせでカードが閉じるか

const SERVER = fileURLToPath(new URL('../cli/elicit-mcp-server.mjs', import.meta.url));
const FORM = 'MCP サーバーの質問にフォームで答えてください';
const FORM_DONE = 'フォームの答えを受け取りました';
const PAGE = 'MCP サーバーの質問でページを開いてください';
const PAGE_DONE = 'ログインが終わりました';
const LOGIN_URL = 'https://login.example.com/authorize?state=tanacode-test';
const tool = (id: string, name: string): Block[] => [{ type: 'tool_use', id, name: `mcp__elicit__${name}`, input: {} }];

describe('MCP サーバーの質問（elicitation）のカード', () => {
  let app: E2EApp;
  // MCP サーバーの控えと、人がページで終えたことにする印（アプリの一時フォルダは起動するまで決まらないので、別に作る）
  const scratch = mkdtempSync(join(tmpdir(), 'tanacode-e2e-elicit-'));
  const done = join(scratch, 'done');

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      // プロジェクトの MCP サーバーとして足し（使う人が .mcp.json に書いたのと同じ）、ツールは確認なしで使わせる
      files: { '.mcp.json': JSON.stringify({ mcpServers: { elicit: { command: process.execPath, args: [SERVER], env: { ELICIT_LOG: join(scratch, 'log'), ELICIT_DONE: done } } } }) },
      claudeSettings: { enableAllProjectMcpServers: true, permissions: { allow: ['mcp__elicit'] } },
      conversations: () => [
        { match: FORM, steps: [tool('toolu_form', 'ask_form'), [{ type: 'text', text: FORM_DONE }]] },
        { match: PAGE, steps: [tool('toolu_url', 'ask_url'), [{ type: 'text', text: PAGE_DONE }]] },
      ],
    });
    // CI の Mac と同じ大きさにする（カードがチャットの一覧に収まらず、一覧がスクロールして最下部に張り付く。手元の Mac の大きさでは収まる）
    await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 677));
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`elicitation-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('フォームの形: どのサーバーからかと項目がカードに出る。必須を空のまま送ると誤りを出し、埋めて送ると MCP サーバーに届く', async () => {
    await app.startSession(FORM, { mode: 'manual' });
    const card = app.page.locator('.chat-list .menu-card.elicitation');
    await card.waitFor();
    expect(await card.locator('.menu-elicitation-server').textContent()).toBe('MCP サーバー: elicit');
    expect(await card.locator('.menu-title').textContent()).toBe('どこに出しますか？');
    // カードが出ている間は、入力欄から送れない（答えはカードで）。入力欄には打たない（打つと入力欄の高さが変わって一覧が動き、
    // 直後にカードを押したクリックが、CI で届かなかった）
    expect(await app.page.locator('.chat-input-row [aria-label="送信"]').isDisabled()).toBe(true);
    await app.press(card.locator('button.menu-option.submit'));
    await card.locator('.menu-field-error', { hasText: '選んでください' }).waitFor();
    await card.locator('select').selectOption('prod');
    await card.locator('.menu-field', { hasText: 'メモ' }).locator('input').fill('E2E のメモ');
    await card.locator('label', { hasText: 'us' }).locator('input').check();
    // 直した項目の誤りが消えるとカードが縮み、一覧が最下部へ追いかけて「送る」が動く。消えて描き終えてから押す
    await card.locator('.menu-field-error').first().waitFor({ state: 'detached' });
    await app.rendered();
    await app.choose(card, '送る');
    await app.byText('.chat-list', FORM_DONE).waitFor();
    expect(app.api.toolResults.some((r) => r.includes(JSON.stringify({ action: 'accept', content: { target: 'prod', replicas: 2, note: 'E2E のメモ', notify: false, regions: ['us'] } })))).toBe(true);
  });

  it('URL の形: 「ページを開く」でふだんのブラウザに URL を渡し、完了待ちのカードになる。MCP サーバーの完了の知らせで閉じる', async () => {
    // ふだんのブラウザを開かないよう、main の shell.openExternal を差し替えて、渡された URL を控える。差し替わったのを確かめてから押す
    const stubbed = await app.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { e2eOpened?: string[] }).e2eOpened = opened;
      shell.openExternal = async (url: string) => void opened.push(url);
      return shell.openExternal.toString().includes('opened.push');
    });
    expect(stubbed).toBe(true);
    // モックの API は、会話のはじめの発言で台本を選ぶので、新しいセッションで始める
    await app.startSession(PAGE, { mode: 'manual' });
    const card = app.page.locator('.chat-list .menu-card.elicitation');
    await card.waitFor();
    expect(await card.locator('.menu-elicitation-url').textContent()).toBe(LOGIN_URL);
    expect(await card.locator('.menu-elicitation-url strong').textContent()).toBe('login.example.com');
    // 開くと、カードは完了待ちのものに替わる
    await app.choose(card, 'ページを開く');
    const opened = app.page.locator('.chat-list .menu-card.elicitation.opened');
    await opened.waitFor();
    expect(await app.app.evaluate(() => (globalThis as { e2eOpened?: string[] }).e2eOpened)).toEqual([LOGIN_URL]);
    // 完了を待っている間は、入力欄から送れる
    await app.page.fill('.chat-input textarea', '待っている間に打つ');
    expect(await app.page.locator('.chat-input-row [aria-label="送信"]').isDisabled()).toBe(false);
    await app.page.fill('.chat-input textarea', '');
    // 人がページで終えた（MCP サーバーが完了を知らせる）
    writeFileSync(done, '');
    await opened.waitFor({ state: 'detached' });
    await app.byText('.chat-list', PAGE_DONE).waitFor();
    expect(app.api.toolResults.some((r) => r.includes(JSON.stringify({ action: 'accept' })))).toBe(true);
  });
});
