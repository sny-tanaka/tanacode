import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// TANACODE.md と「親にする」を、アプリ本体で通して確かめる。作業フォルダに 2 つのファイルを置いて始める。
// - TANACODE.md: 起動した Claude Code の SessionStart のフック（ビルドした instructions-hook.js を、アプリの Helper が Node として動かす）が、
//   新しい会話の始まりと /clear のあとに Claude に渡す。チャットのフックの一覧には出ない
// - TANACODE_PARENT.md: 新規セッションの画面の「親として始める」で、最初の指示と一緒に渡る。チャットのヘッダーの「親にする」で、もう一度渡る。
//   親の状態は覚えないので、会話を消したあとは渡らない

const RULES = '# プロジェクトの決まり\n- 答えは日本語で書く\n';
const PARENT_RULES = '# 親として動くときの決まり\n- 作業は子のセッションに任せる\n';
const FIRST = 'ログイン画面を作ってください';
const AFTER_CLEAR = '消したあとの指示です';
const NOTICE = 'TANACODE_PARENT.md を読ませて、親のセッションにしました';

describe('TANACODE.md と「親にする」', () => {
  let app: E2EApp;
  const said = (text: string) => app.byText('.chat-list .chat-response', `はい: ${text}`);
  // その発言を送ったリクエストの、発言の文章（user と system）
  const contextOf = (text: string) => [...app.api.contexts].reverse().find((c) => c.includes(text)) ?? '';
  const parentPrompts = () => app.api.lastPrompts.filter((p) => p.includes(PARENT_RULES.trim())).length;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      files: { 'TANACODE.md': RULES, 'TANACODE_PARENT.md': PARENT_RULES },
      // どの会話にも当たる台本（リクエストの中身を控えさせる）。応答は intercept が決める
      conversations: () => [{ match: '', steps: [] }],
    });
    app.api.intercept = (prompt) => (prompt ? [{ type: 'text', text: `はい: ${prompt.trim().split('\n').at(-1)}` }] : null);
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`project-instructions-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('「親として始める」で始めると、最初の指示と一緒に TANACODE_PARENT.md が、会話の始まりに TANACODE.md が Claude に渡る', async () => {
    await app.startSession(FIRST, { asParent: true });
    await said(FIRST).waitFor();
    const context = contextOf(FIRST);
    expect(context).toContain(`<tanacode-instructions path="${app.work}/TANACODE.md"`);
    expect(context).toContain(RULES.trim());
    expect(context).toContain('<tanacode-parent-role>');
    expect(context).toContain(`<instructions-file path="${app.work}/TANACODE_PARENT.md">`);
    expect(context).toContain(PARENT_RULES.trim());
    // チャットには、知らせと、最初の指示（人の発言）が出る。囲みや、TANACODE.md のフックは出ない
    await app.byText('.chat-list .chat-notice', NOTICE).waitFor();
    await app.byText('.chat-list .chat-user', FIRST).waitFor();
    expect(await app.byText('.chat-list', '<tanacode-').count()).toBe(0);
    expect(await app.page.locator('.chat-list .hook-runs').count()).toBe(0);
  });

  it('ヘッダーの「親にする」を押すと、TANACODE_PARENT.md がもう一度 Claude に渡り、知らせが出る', async () => {
    const before = parentPrompts();
    const button = app.page.locator('.claude-header [aria-label="親にする"]');
    await expect.poll(() => button.isEnabled()).toBe(true);
    await button.click();
    await app.waitUntil('親にする', () => parentPrompts() > before);
    await expect.poll(() => app.byText('.chat-list .chat-notice', NOTICE).count()).toBe(2);
  });

  it('/clear で会話を消しても、次の会話の始まりに TANACODE.md が渡る。TANACODE_PARENT.md は渡らない（親の状態は覚えない）', async () => {
    await app.send('/clear');
    await app.byText('.chat-list .chat-notice', NOTICE).first().waitFor({ state: 'detached' });
    await app.send(AFTER_CLEAR);
    await said(AFTER_CLEAR).waitFor();
    const context = contextOf(AFTER_CLEAR);
    expect(context).toContain(RULES.trim());
    expect(context).not.toContain(PARENT_RULES.trim());
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
