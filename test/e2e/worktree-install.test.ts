import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// worktree の準備の install（lock が元のフォルダと違うので npm install する）は、ターミナルパネルに出さずに裏で流す。
// 人と一緒に見る必要があるものだけをタブに出す: 失敗したとき・出力が止まって入力を待っているように見えるとき・人が「ターミナルで見る」を押したとき。
// 直す前: install はいつもタブに出し、終わってもタブが残った（子のターミナルを開くと、終わった install のタブだけがたまっていた）。
// npm は偽物にする（PATH の先頭に置く）。動き方は、作業フォルダの隣のファイル（npm-mode）で決める。
// install はログインシェル（zsh -l -c）で動き、/etc/zprofile の path_helper が PATH の並びを変えるので、~/.zprofile で偽物を先頭に戻す

const FAKE_NPM = `#!/bin/sh
here=$(cd "$(dirname "$0")/.." && pwd)
case "$(cat "$here/npm-mode" 2>/dev/null)" in
  fail) echo "npm error E2E install failed" >&2; exit 1 ;;
  ask) printf 'Proceed? (Y/n) '; read answer; echo "answered-$answer"; exit 0 ;;
  slow) echo "fetching-e2e"; while [ ! -e "$here/npm-release" ]; do sleep 0.1; done; echo "fetched-e2e"; exit 0 ;;
  *) echo "added-e2e"; exit 0 ;;
esac
`;

const scenarios = {
  ok: { prompt: 'worktree で始めます（install は通る）', reply: 'install が通った返事です' },
  fail: { prompt: 'worktree で始めます（install は失敗する）', reply: 'install が失敗した返事です' },
  ask: { prompt: 'worktree で始めます（install が入力を待つ）', reply: 'install に答えたあとの返事です' },
  slow: { prompt: 'worktree で始めます（install を見る）', reply: 'install を見たあとの返事です' },
} as const;
type Mode = keyof typeof scenarios;

describe('worktree の準備の install は、ターミナルに出さずに裏で流す', () => {
  let app: E2EApp;
  const tabs = () => app.page.locator('.terminal-panel .terminal-tab');
  const shown = () => app.page.locator('.terminal-panel .terminal-host:not([hidden]) .terminal-instance:not([hidden])');
  const tabTexts = () => tabs().allTextContents();

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      files: {
        'package.json': '{ "name": "e2e", "version": "1.0.0" }\n',
        'package-lock.json': '{ "name": "e2e", "lockfileVersion": 3, "packages": {} }\n',
        '.gitignore': 'node_modules\n',
      },
      commands: { npm: FAKE_NPM },
      conversations: () => Object.values(scenarios).map(({ prompt, reply }) => ({ match: prompt, steps: [[{ type: 'text', text: reply }]] })),
    });
    // 元のフォルダは依存を入れていて（node_modules がある）、lock をコミットしたものから変えている。worktree の lock（コミットしたもの）と
    // 違うので、worktree で install する
    mkdirSync(join(app.work, 'node_modules'));
    writeFileSync(join(app.work, 'package-lock.json'), '{ "name": "e2e", "lockfileVersion": 3, "packages": { "": {} } }\n');
    writeFileSync(join(app.home, '.zprofile'), `export PATH=${JSON.stringify(join(app.root, 'bin'))}:"$PATH"\n`);
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`worktree-install-${task.name}`);
  });

  afterAll(async () => {
    if (app) writeFileSync(join(app.root, 'npm-release'), '');
    await app?.close();
  });

  // 新規セッションの画面で、作業フォルダと「worktree を使う」を選んで、mode の指示を送る
  async function start(mode: Mode): Promise<void> {
    writeFileSync(join(app.root, 'npm-mode'), mode);
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
    await page.fill('.chat-input textarea', scenarios[mode].prompt);
    await page.click('section.claude:has(.new-session-body) .chat-input-row [aria-label="送信"]');
  }

  it('install が通ったら、子のターミナルに install のタブを残さない（開くと、ふつうのシェルだけ）', async () => {
    await start('ok');
    await app.byText('.chat-list', scenarios.ok.reply).waitFor({ timeout: 60_000 });
    // 準備の知らせには、install したことが出る
    await app.byText('.chat-list', 'npm install（いちばん上） を実行しました').waitFor();
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await shown().locator('.xterm-rows').waitFor();
    const texts = await tabTexts();
    expect(texts.some((text) => text.includes('npm install')), JSON.stringify(texts)).toBe(false);
    expect(texts).toHaveLength(1);
  });

  it('install が失敗したら、それまでの出力ごとタブに出し、チャットに注意の行を出す', async () => {
    await start('fail');
    await app.byText('.chat-list', scenarios.fail.reply).waitFor({ timeout: 60_000 });
    await app.byText('.chat-list', 'npm install（いちばん上・終了コード 1） が失敗しました').waitFor();
    const failed = tabs().filter({ hasText: 'npm install（失敗 1）' });
    await failed.waitFor();
    expect(await failed.getAttribute('aria-selected')).toBe('true');
    await shown().locator('.xterm-rows').getByText('npm error E2E install failed').waitFor();
  });

  it('install が入力を待っているように見えたら、タブに出し、チャットに注意の行を出す。タブで答えると、準備が終わって指示が届く', async () => {
    await start('ask');
    await app.byText('.chat-list', 'npm install（いちばん上） が入力を待っているようです').waitFor({ timeout: 60_000 });
    const waiting = tabs().filter({ hasText: 'npm install（実行中）' });
    await waiting.waitFor();
    expect(await waiting.getAttribute('aria-selected')).toBe('true');
    // 隠れている間の出力（問い）も、タブに出ている
    await shown().locator('.xterm-rows').getByText('Proceed? (Y/n)').waitFor();
    await shown().locator('.xterm-helper-textarea').focus();
    await app.page.keyboard.type('y');
    await app.page.keyboard.press('Enter');
    await shown().locator('.xterm-rows').getByText('answered-y').waitFor();
    await app.byText('.chat-list', scenarios.ask.reply).waitFor({ timeout: 60_000 });
    // 人が答えたタブは、閉じるまで残す
    await tabs().filter({ hasText: 'npm install（完了）' }).waitFor();
  });

  it('準備中の「ターミナルで見る」を押すと、動いている install をそれまでの出力ごとタブに出す', async () => {
    await start('slow');
    const note = app.page.locator('.chat-note.worktree-preparing', { hasText: 'パッケージをインストールしています' });
    await note.waitFor({ timeout: 60_000 });
    expect(await tabs().filter({ hasText: 'npm install' }).count()).toBe(0);
    await note.getByRole('button', { name: 'ターミナルで見る' }).click();
    const running = tabs().filter({ hasText: 'npm install（実行中）' });
    await running.waitFor();
    expect(await running.getAttribute('aria-selected')).toBe('true');
    await shown().locator('.xterm-rows').getByText('fetching-e2e').waitFor();
    writeFileSync(join(app.root, 'npm-release'), '');
    await shown().locator('.xterm-rows').getByText('fetched-e2e').waitFor();
    await app.byText('.chat-list', scenarios.slow.reply).waitFor({ timeout: 60_000 });
    await tabs().filter({ hasText: 'npm install（完了）' }).waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
