import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 新規セッションの画面の「最新のデフォルトブランチへ切り替える」。フォルダ（リポジトリ）を切り替えた直後でも動き、
// リモートが応答しなくても、いつまでも「切り替え中」のままにならない

describe('新規セッションの画面で、最新のデフォルトブランチへ切り替える', () => {
  let app: E2EApp;
  // 応答しないリモート（つないでも何も返さない HTTP サーバー）
  let silent: Server;
  const sockets = new Set<import('node:net').Socket>();
  const button = () => app.page.locator('.new-session-chips [aria-label="最新のデフォルトブランチへ切り替える"]');
  const branchChip = () => app.page.locator('.new-session-chips .new-session-chip.branch');

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: app.home } });

  // origin（手元の bare リポジトリ）を持ち、feature ブランチにいるリポジトリを作る
  const repo = (name: string, origin?: string): string => {
    const dir = join(app.root, name);
    mkdirSync(dir);
    run(dir, 'init', '-q', '-b', 'main');
    run(dir, 'commit', '-qm', 'init', '--allow-empty');
    if (origin) {
      run(dir, 'remote', 'add', 'origin', origin);
    } else {
      const bare = join(app.root, `${name}.git`);
      run(app.root, 'init', '-q', '--bare', '-b', 'main', bare);
      run(dir, 'remote', 'add', 'origin', bare);
      run(dir, 'push', '-q', '-u', 'origin', 'main');
      run(dir, 'remote', 'set-head', 'origin', 'main');
    }
    run(dir, 'switch', '-q', '-c', 'feature');
    return dir;
  };

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
  let hung: string;

  beforeAll(async () => {
    silent = createServer(() => {});
    silent.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    app = await E2EApp.launch({ trusted: true });
    a = repo('repo-a');
    b = repo('repo-b');
    hung = repo('repo-hung', `http://127.0.0.1:${(silent.address() as AddressInfo).port}/hung.git`);
    await app.page.click('nav.sidebar .new-session-button');
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`default-branch-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
    for (const socket of sockets) socket.destroy();
    silent?.close();
  });

  it('押すと、デフォルトブランチへ切り替わる', async () => {
    await pick(a);
    await app.byText('.new-session-chips .new-session-chip.branch', 'feature').waitFor();
    await button().click();
    await app.byText('.new-session-chips .new-session-chip.branch', /^main$/).waitFor();
    expect(run(a, 'branch', '--show-current').trim()).toBe('main');
    await expect.poll(() => button().isDisabled()).toBe(false);
  });

  it('フォルダを切り替えた直後に押しても、切り替えたフォルダで切り替わる', async () => {
    await pick(b);
    // ボタンが出たらすぐ押す
    await button().click();
    await expect.poll(() => run(b, 'branch', '--show-current').trim(), { timeout: 20_000 }).toBe('main');
    await app.byText('.new-session-chips .new-session-chip.branch', /^main$/).waitFor();
    await expect.poll(() => button().isDisabled(), { timeout: 20_000 }).toBe(false);
  });

  it('切り替え中にフォルダを変えると、変えた先のボタンは押せる', async () => {
    run(b, 'switch', '-q', 'feature');
    await pick(hung);
    await app.byText('.new-session-chips .new-session-chip.branch', 'feature').waitFor();
    await button().click();
    await expect.poll(() => button().isDisabled()).toBe(true);
    await pick(b);
    await app.byText('.new-session-chips .new-session-chip.branch', 'feature').waitFor();
    await expect.poll(() => button().isDisabled(), { timeout: 5_000 }).toBe(false);
    // 前のフォルダの切り替えで、最初の指示も止めない
    await app.page.fill('.chat-input textarea', '始めてください');
    await expect.poll(() => app.page.locator('.chat-input-row [aria-label="送信"]').isDisabled()).toBe(false);
    await app.page.fill('.chat-input textarea', '');
    await button().click();
    await expect.poll(() => run(b, 'branch', '--show-current').trim(), { timeout: 20_000 }).toBe('main');
  });

  it('リモートが応答しなくても、いつまでも「切り替え中」のままにならず、理由が出る', async () => {
    // 前のテストで押した、応答しないリモートのフォルダの切り替えが、まだ続いている
    await pick(hung);
    await app.byText('.new-session-chips .new-session-chip.branch', 'feature').waitFor();
    await expect.poll(() => button().isDisabled()).toBe(true);
    // 何も進まないまま 30 秒たつと止める
    await expect.poll(() => button().isDisabled(), { timeout: 45_000 }).toBe(false);
    await app.byText('.new-session-chips .new-session-warning', 'リモートから 30 秒応答が無いため、止めました').waitFor();
    expect(run(hung, 'branch', '--show-current').trim()).toBe('feature');
  }, 60_000);

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
