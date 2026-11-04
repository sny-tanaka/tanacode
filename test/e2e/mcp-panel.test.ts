import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// サイドパネルの「MCP」。本物の Claude Code に mcp_status を聞いて、セッションに登録されている MCP サーバーを並べる。
// tanacode が足すサーバー（--mcp-config）が、接続済みとツールの数つきで並び、行を開くとツールの名前が出るかを確かめる
const PROMPT = 'MCP の一覧を確かめます';
const ANSWER = '確かめました';

describe('サイドパネルの MCP', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({ conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: ANSWER }]] }] });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`mcp-panel-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('tanacode の MCP サーバーが接続済みで並び、行を開くとツールの一覧が出る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', ANSWER).waitFor();
    await app.page.click('.activity-bar [aria-label^="MCP"]');
    const row = app.page.locator('.mcp-panel-row[data-key-id="tanacode-checklist"]');
    await row.waitFor();
    // つないでいる途中なら、つながるまで聞き直す
    await row.locator('.mcp-panel-dot.ok').waitFor();
    expect(await row.locator('.mcp-panel-tools-count').textContent()).toMatch(/^ツール \d+$/);
    for (const name of ['tanacode-browser', 'tanacode-sessions', 'tanacode-walkthrough']) {
      expect(await app.page.locator(`.mcp-panel-row[data-key-id="${name}"]`).count(), name).toBe(1);
    }
    await row.click();
    const tools = await app.page.locator('.mcp-panel-tool-name').allTextContents();
    expect(tools).toContain('card_add');
    expect(tools).toContain('checklist_overview');
  });
});
