import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { E2EApp } from './app';

// worktree で始める。指示を送ったら、Claude Code が worktree を作るのを待たずに、すぐそのセッションの画面に移る。
// 作っている間は、移った先で準備の段階を出して待つ（フォルダを読むエクスプローラー・ソース管理・ターミナルも、できるまで待つ）。
// 作れなかったら、新規セッションの画面に戻して、送るはずだった指示を入力欄に戻し、理由を出す

const PROMPT = 'worktree に分けて始めてください';
const REPLY = 'worktree で始めた返事です';

const newSession = (app: E2EApp) => app.page.locator('section.claude:has(.new-session-body)');
const sessions = (app: E2EApp) =>
  app.page.evaluate(() => (window as unknown as { tanacode: { sessions: { list(): Promise<SessionSummary[]> } } }).tanacode.sessions.list());

// 新規セッションの画面で、作業フォルダと「worktree を使う」を選んで、指示を書く（送る手前まで）
async function compose(app: E2EApp): Promise<void> {
  const page = app.page;
  await page.click('nav.sidebar .new-session-button');
  const chosen = page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${app.work}"]`);
  const other = app.byText('.folder-menu-item', '別のフォルダを選ぶ…');
  await page.click('.new-session-chips .folder-picker > button.new-session-chip');
  await chosen.or(other).first().waitFor();
  if (await other.isVisible()) await other.click();
  await chosen.waitFor();
  // Remote Control は使わない（パッケージしたアプリでは既定でオン。モックの API ではつながらない）
  const remote = page.locator('.claude-header [role="switch"][aria-label="Remote Control"]');
  if ((await remote.count()) > 0 && (await remote.getAttribute('aria-checked')) === 'true') await remote.click();
  await page.check('.new-session-chips .new-session-check input[type="checkbox"]');
  await page.fill('.chat-input textarea', PROMPT);
}

describe('worktree で始めると、作るのを待たずにセッションの画面に移る', () => {
  let app: E2EApp;
  const release = () => join(app.root, 'worktree.release');
  const side = (selector: string) => app.page.locator(`aside.explorer .side-body:not([hidden]) ${selector}`);

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      files: { 'a.txt': 'a\n' },
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: REPLY }]] }],
    });
    // worktree を作るのを、合図（release のファイル）があるまで待たせる。アプリの PATH の先頭（root/bin）に git の代わりを置き、
    // worktree add のときだけ待ってから本物の git に渡す（Claude Code が worktree を作るのに使う git も、この PATH から探される）
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const wrapper = join(app.root, 'bin', 'git');
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in *" worktree add "*) while [ ! -e ${JSON.stringify(release())} ]; do sleep 0.1; done ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`worktree-start-${task.name}`);
  });

  afterAll(async () => {
    if (app) writeFileSync(release(), '');
    await app?.close();
  });

  it('送ったら、worktree を作っている間でも、すぐセッションの画面に移る。送った指示は、準備が終わるまで預かる', async () => {
    await compose(app);
    // ターミナルを開いておく（フォルダが無い間に、シェルを開こうとしないことを見る）
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await app.page.locator('.terminal-panel .terminal-tab').first().waitFor();
    await app.page.click('section.claude:has(.new-session-body) .chat-input-row [aria-label="送信"]');
    // worktree を作るのは待たせたまま。それでも、新規セッションの画面からセッションの画面に移る
    await app.page.locator('.chat-note.worktree-preparing', { hasText: 'worktree を作っています' }).waitFor({ timeout: 10_000 });
    expect(await newSession(app).count()).toBe(0);
    const pending = app.page.locator('.chat-user.pending');
    await pending.waitFor();
    expect(await pending.textContent()).toContain(PROMPT);
    expect(await pending.textContent()).toContain('worktree の準備が終わるのを待って送ります');
    await app.byText('.session-list .session-row', 'worktree を作っています').waitFor();
    // worktree は、まだ無い
    const [session] = await sessions(app);
    expect(session.worktree?.preparing).toBe('creating');
    expect(existsSync(session.cwd)).toBe(false);
  });

  it('worktree ができるまで、エクスプローラー・ソース管理・ターミナルは、準備の段階を出して待つ', async () => {
    await side('.scm-empty').waitFor();
    expect(await side('.scm-empty').textContent()).toContain('worktree を作っています');
    expect(await app.page.locator('aside.explorer .tree').count()).toBe(0);
    await app.page.click('.activity-bar [aria-label^="ソース管理"]');
    expect(await side('.scm-empty').textContent()).toContain('worktree を作っています');
    await app.page.click('.activity-bar [aria-label="エクスプローラー"]');
    // ターミナルは、無いフォルダでシェルを開かない（開くと、すぐ終わって開き直しを繰り返す）
    await app.page.locator('.terminal-panel .terminal-waiting').waitFor();
    await app.page.waitForTimeout(1000);
    expect(await app.page.locator('.terminal-panel .terminal-tab').count()).toBe(0);
    expect(await app.page.locator('.terminal-panel [aria-label="新しいターミナル"]').isDisabled()).toBe(true);
  });

  it('worktree ができたら、預かっていた指示を送り、エクスプローラーとターミナルが worktree を開く', async () => {
    writeFileSync(release(), '');
    await app.byText('.chat-list', REPLY).waitFor();
    expect(await app.page.locator('.chat-note.worktree-preparing').count()).toBe(0);
    await app.byText('aside.explorer .tree .tree-row', 'a.txt').waitFor();
    await app.page.locator('.terminal-panel .terminal-tab').first().waitFor();
    expect(await app.page.locator('.terminal-panel .terminal-waiting').count()).toBe(0);
    const [session] = await sessions(app);
    expect(existsSync(join(session.cwd, 'a.txt'))).toBe(true);
    // ソース管理も worktree のブランチを読む
    await app.byText('.statusbar', session.worktree!.branch).waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});

describe('worktree を作れなかったら、新規セッションの画面に戻して理由を出す', () => {
  let app: E2EApp;
  // 理由のダイアログ（window.alert）に出た文
  const alerts = () => app.page.evaluate(() => (window as unknown as { alerts: string[] }).alerts);

  beforeAll(async () => {
    // フォルダを信頼していない。claude --worktree は、信頼の確認を出さずに終わる
    app = await E2EApp.launch({
      git: true,
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: REPLY }]] }],
    });
    await app.page.evaluate(() => {
      const w = window as unknown as { alerts: string[] };
      w.alerts = [];
      window.alert = (message?: unknown) => void w.alerts.push(String(message));
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`worktree-start-failed-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('新規セッションの画面に戻り、送るはずだった指示が入力欄に戻っている。始めかけたセッションは一覧に残らない', async () => {
    await compose(app);
    await app.page.click('section.claude:has(.new-session-body) .chat-input-row [aria-label="送信"]');
    await expect.poll(async () => (await alerts()).length, { timeout: 30_000 }).toBe(1);
    expect(await alerts()).toEqual([
      'セッションを始められませんでした: このフォルダは、まだ Claude Code で信頼していません。一度 worktree なしで始めて、フォルダの信頼の確認に答えてから、worktree で始めてください',
    ]);
    await newSession(app).waitFor();
    expect(await app.page.inputValue('section.claude:has(.new-session-body) .chat-input textarea')).toBe(PROMPT);
    await app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${app.work}"]`).waitFor();
    expect(await sessions(app)).toEqual([]);
    expect(await app.page.locator('.session-list .session-row').count()).toBe(0);
  });

  it('worktree なしで送り直すと、同じ指示で始まる', async () => {
    await app.page.uncheck('.new-session-chips .new-session-check input[type="checkbox"]');
    await app.page.click('section.claude:has(.new-session-body) .chat-input-row [aria-label="送信"]');
    // 信頼の確認に答える
    const card = await app.menuCard('other');
    await app.choose(card, /^Yes/);
    await app.byText('.chat-list', REPLY).waitFor();
    expect(await alerts()).toHaveLength(1);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
