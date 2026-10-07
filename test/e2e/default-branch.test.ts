import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 新規セッションの画面の「最新のデフォルトブランチへ切り替える」。フォルダ（リポジトリ）を切り替えた直後に押しても効き、
// あるフォルダの切り替え（フェッチ）に時間がかかっていても、ほかのフォルダのボタンと送信はすぐ使える

describe('新規セッションの画面で、最新のデフォルトブランチへ切り替える', () => {
  let app: E2EApp;
  const button = () => app.page.locator('.new-session-chips [aria-label="最新のデフォルトブランチへ切り替える"]');
  const branchChip = (name: string) => app.byText('.new-session-chips .new-session-chip.branch', new RegExp(`^${name}$`));

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: app.home } });
  const branchOf = (dir: string) => run(dir, 'branch', '--show-current').trim();

  // origin（手元の bare リポジトリ）を持ち、feature ブランチにいるリポジトリを作る。
  // slow なら、origin は合図（release のファイル）があるまで答えない（時間のかかるフェッチ）
  const repo = (name: string, { slow = false } = {}): string => {
    const dir = join(app.root, name);
    const bare = join(app.root, `${name}.git`);
    mkdirSync(dir);
    run(dir, 'init', '-q', '-b', 'main');
    run(dir, 'commit', '-qm', 'init', '--allow-empty');
    run(app.root, 'init', '-q', '--bare', '-b', 'main', bare);
    run(dir, 'remote', 'add', 'origin', bare);
    run(dir, 'push', '-q', '-u', 'origin', 'main');
    run(dir, 'remote', 'set-head', 'origin', 'main');
    if (slow) {
      // git の ext:: で、release ができるまで待ってから、ふつうに upload-pack で答える
      run(dir, 'config', 'protocol.ext.allow', 'always');
      const wait = `while [ ! -e ${release(name)} ]; do sleep 0.1; done; exec git %s ${bare}`;
      run(dir, 'remote', 'set-url', 'origin', `ext::sh -c ${wait.replaceAll(' ', '% ')}`);
    }
    run(dir, 'switch', '-q', '-c', 'feature');
    return dir;
  };
  const release = (name: string) => join(app.root, `${name}.release`);

  // フォルダを選ぶ（ダイアログで dir を選んだことにする）
  const pick = async (dir: string) => {
    await app.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, dir);
    await app.page.click('.new-session-chips .folder-picker > button.new-session-chip');
    const other = app.byText('.folder-menu-item', '別のフォルダを選ぶ…');
    if (await other.isVisible()) await other.click();
    await app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${dir}"]`).waitFor();
  };

  let a: string;
  let b: string;
  let slow: string;

  beforeAll(async () => {
    app = await E2EApp.launch({ trusted: true });
    a = repo('repo-a');
    b = repo('repo-b');
    slow = repo('repo-slow', { slow: true });
    await app.page.click('nav.sidebar .new-session-button');
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`default-branch-${task.name}`);
  });

  afterAll(async () => {
    // 待たせたままのフェッチがあれば、終わらせてから閉じる
    if (slow) writeFileSync(release('repo-slow'), '');
    await app?.close();
  });

  it('押すと、デフォルトブランチへ切り替わる', async () => {
    await pick(a);
    await branchChip('feature').waitFor();
    await button().click();
    await branchChip('main').waitFor();
    expect(branchOf(a)).toBe('main');
    await expect.poll(() => button().isDisabled()).toBe(false);
  });

  it('フォルダを切り替えた直後に押しても、切り替えたフォルダで切り替わる', async () => {
    await pick(b);
    // ボタンが出たらすぐ押す
    await button().click();
    await expect.poll(() => branchOf(b), { timeout: 20_000 }).toBe('main');
    await branchChip('main').waitFor();
    await expect.poll(() => button().isDisabled()).toBe(false);
  });

  it('フェッチに時間がかかっている間にフォルダを変えると、変えた先のボタンと送信はすぐ使え、押すと切り替わる', async () => {
    run(b, 'switch', '-q', 'feature');
    await pick(slow);
    await branchChip('feature').waitFor();
    await button().click();
    await expect.poll(() => button().isDisabled()).toBe(true);
    await pick(b);
    await branchChip('feature').waitFor();
    await expect.poll(() => button().isDisabled(), { timeout: 5_000 }).toBe(false);
    // 前のフォルダの切り替えで、最初の指示も止めない
    await app.page.fill('.chat-input textarea', '始めてください');
    await expect.poll(() => app.page.locator('.chat-input-row [aria-label="送信"]').isDisabled()).toBe(false);
    await app.page.fill('.chat-input textarea', '');
    await button().click();
    await expect.poll(() => branchOf(b), { timeout: 20_000 }).toBe('main');
    await branchChip('main').waitFor();
  });

  it('時間のかかっているフォルダに戻ると、まだ切り替え中のまま（止めない）。リモートが答えると切り替わる', async () => {
    await pick(slow);
    await expect.poll(() => button().isDisabled()).toBe(true);
    expect(branchOf(slow)).toBe('feature');
    writeFileSync(release('repo-slow'), '');
    await expect.poll(() => branchOf(slow), { timeout: 20_000 }).toBe('main');
    await branchChip('main').waitFor();
    await expect.poll(() => button().isDisabled()).toBe(false);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
