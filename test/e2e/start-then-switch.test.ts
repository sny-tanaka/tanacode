import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 新規セッションの画面で、セッションを始めている途中（worktree を作っている間など）にフォルダを変える。
// 変えた先の送信はすぐ使え、前のフォルダのセッションができても、変えた先の画面から勝手に移らない

const SLOW = '時間のかかるフォルダで始めてください';
const OTHER = '変えた先のフォルダで始めてください';

describe('セッションを始めている途中で、新規セッションの画面のフォルダを変える', () => {
  let app: E2EApp;
  let other: string;
  const release = () => join(app.root, 'worktree.release');
  // 新規セッションの画面の送信（セッションの画面に移ると無くなる）
  const send = () => app.page.locator('section.claude:has(.new-session-body) .chat-input-row [aria-label="送信"]');
  const folderChip = (dir: string) => app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${dir}"]`);

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: app.home } });

  // フォルダを選ぶ（ダイアログで dir を選んだことにする）
  const pick = async (dir: string) => {
    await app.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, dir);
    await app.page.click('.new-session-chips .folder-picker > button.new-session-chip');
    const menu = app.byText('.folder-menu-item', '別のフォルダを選ぶ…');
    if (await menu.isVisible()) await menu.click();
    await app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${dir}"]`).waitFor();
  };

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      conversations: () => [
        { match: SLOW, steps: [[{ type: 'text', text: '時間のかかるフォルダの返事です' }]] },
        { match: OTHER, steps: [[{ type: 'text', text: '変えた先のフォルダの返事です' }]] },
      ],
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
    other = join(app.root, 'other');
    mkdirSync(other);
    run(other, 'init', '-q', '-b', 'main');
    run(other, 'commit', '-qm', 'init', '--allow-empty');
    await app.page.click('nav.sidebar .new-session-button');
    // Remote Control は使わない（パッケージしたアプリでは既定でオン。モックの API ではつながらない）
    const remote = app.page.locator('.claude-header [role="switch"]');
    if ((await remote.count()) > 0 && (await remote.getAttribute('aria-checked')) === 'true') await remote.click();
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`start-then-switch-${task.name}`);
  });

  afterAll(async () => {
    if (app) writeFileSync(release(), '');
    await app?.close();
  });

  it('worktree で始めている途中にフォルダを変えると、変えた先の送信はすぐ使える', async () => {
    await pick(app.work);
    await app.page.check('.new-session-chips .new-session-check input[type="checkbox"]');
    await app.page.fill('.chat-input textarea', SLOW);
    await send().click();
    // 始めている間は、同じフォルダからは送れない
    await expect.poll(() => send().isDisabled()).toBe(true);
    await pick(other);
    // 前のフォルダのセッションは、まだ worktree を作っている（作るのを待たせている）
    await app.byText('.session-list .session-row', 'worktree を作っています').waitFor();
    await expect.poll(() => send().isDisabled(), { timeout: 2_000 }).toBe(false);
    await app.page.uncheck('.new-session-chips .new-session-check input[type="checkbox"]');
    await app.page.fill('section.claude:has(.new-session-body) .chat-input textarea', OTHER);
    expect(await send().isDisabled()).toBe(false);
  });

  it('前のフォルダのセッションができても、変えた先の画面から移らない。できたセッションは一覧に出る', async () => {
    writeFileSync(release(), '');
    await app.byText('.session-list .session-row', SLOW).waitFor();
    // 前のフォルダのセッションの返事が届くまで待っても、新規セッションの画面のまま（変えた先のフォルダと書きかけの指示）
    await app.waitUntil('前のフォルダのセッションが返事をする', () => app.api.lastPrompts.some((p) => p.includes(SLOW)));
    await folderChip(other).waitFor();
    expect(await app.page.inputValue('section.claude:has(.new-session-body) .chat-input textarea')).toBe(OTHER);
  });

  it('変えた先で送ると、そのフォルダでセッションが始まり、そのセッションに移る', async () => {
    await send().click();
    // 変えた先のフォルダは、まだ信頼していないので確認が出る（出るのは、変えた先のセッションに移っているから）
    const card = await app.menuCard('other');
    expect(await card.textContent()).toContain(other);
    await app.choose(card, /^Yes/);
    await app.byText('.claude-header .claude-title', OTHER).waitFor();
    await app.byText('.chat-list', '変えた先のフォルダの返事です').waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
