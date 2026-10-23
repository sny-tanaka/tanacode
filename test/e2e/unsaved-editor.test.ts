import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// エディタのタブはフォルダ単位で、別のフォルダのセッションへ移ると、エディタを作り直す。保存していない変更があるときは、
// 移る前に「保存して移る・保存せずに移る・やめる」を確かめる（確かめずに消さない）。同じフォルダのまま移るときは聞かず、変更も残す

const FIRST = '作業フォルダで始めてください';
const SECOND = '別のフォルダで始めてください';
const NOTE = 'はじめの文\n';

describe('保存していない変更があるうちに、別のフォルダのセッションへ移る', () => {
  let app: E2EApp;
  let other: string;
  const dialog = () => app.page.locator('[role="dialog"][aria-label="保存していない変更"]');
  const dirtyTab = () => app.page.locator('.editor-tab.active .editor-tab-dot.dirty');
  const row = (text: string) => app.byText('.session-list .session-row', text);
  const title = (text: string) => app.byText('.claude-header .claude-title', text);

  // 作業フォルダのセッションで note.txt を開き、行の終わりに text を打つ（保存していない変更にする）
  const edit = async (text: string) => {
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await app.page.click('.tree-row[title="note.txt"]');
    await app.page.locator('.editor .editor-monaco .view-line', { hasText: 'はじめの文' }).first().click();
    await app.page.keyboard.press('End');
    await app.page.keyboard.type(text);
    await dirtyTab().waitFor();
  };

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      files: { 'note.txt': NOTE, 'memo.txt': 'メモ\n' },
      conversations: () => [
        { match: FIRST, steps: [[{ type: 'text', text: '作業フォルダの返事です' }]] },
        { match: SECOND, steps: [[{ type: 'text', text: '別のフォルダの返事です' }]] },
      ],
    });
    other = join(app.root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'other.txt'), '別のフォルダのファイル\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other });
    // 別のフォルダのセッションを先に始め、作業フォルダのセッションをあとに始める（作業フォルダのセッションを見ている状態にする）
    await app.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, other);
    await app.page.click('nav.sidebar .new-session-button');
    await app.page.click('.new-session-chips .folder-picker > button.new-session-chip');
    const menu = app.byText('.folder-menu-item', '別のフォルダを選ぶ…');
    if (await menu.isVisible()) await menu.click();
    await app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${other}"]`).waitFor();
    const remote = app.page.locator('.claude-header [role="switch"][aria-label="Remote Control"]');
    if ((await remote.count()) > 0 && (await remote.getAttribute('aria-checked')) === 'true') await remote.click();
    await app.send(SECOND);
    await app.byText('.chat-list', '別のフォルダの返事です').waitFor();
    await app.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, app.work);
    await app.startSession(FIRST);
    await app.byText('.chat-list', '作業フォルダの返事です').waitFor();
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`unsaved-editor-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('移ろうとすると確かめる。「やめる」なら移らず、変更も残る', async () => {
    await edit(' 書きかけ');
    await row(SECOND).click();
    await dialog().waitFor();
    expect(await dialog().innerText()).toContain('note.txt');
    await dialog().getByRole('button', { name: 'やめる' }).click();
    await dialog().waitFor({ state: 'detached' });
    await title(FIRST).waitFor();
    await dirtyTab().waitFor();
    expect(readFileSync(join(app.work, 'note.txt'), 'utf8')).toBe(NOTE);
  });

  it('「保存せずに移る」なら、保存せずに移る。戻ると、ディスクの内容のまま', async () => {
    await row(SECOND).click();
    await dialog().getByRole('button', { name: '保存せずに移る' }).click();
    await title(SECOND).waitFor();
    expect(readFileSync(join(app.work, 'note.txt'), 'utf8')).toBe(NOTE);
    // 別のフォルダでは、変更は無いので、戻るときは聞かない
    await row(FIRST).click();
    await title(FIRST).waitFor();
    expect(await dialog().count()).toBe(0);
    await app.page.click('.tree-row[title="note.txt"]');
    await app.byText('.editor-tab.active', 'note.txt').waitFor();
    await app.page.waitForFunction(() => document.querySelector('.editor .editor-monaco .view-lines')?.textContent?.includes('はじめの文'));
    expect(await app.page.locator('.editor .editor-monaco .view-lines').innerText()).not.toContain('書きかけ');
    expect(await dirtyTab().count()).toBe(0);
  });

  it('同じフォルダの新規セッションの画面へ移るときは聞かず、変更も残る', async () => {
    await edit(' 残す');
    await app.page.click('nav.sidebar .new-session-button');
    await app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${app.work}"]`).waitFor();
    expect(await dialog().count()).toBe(0);
    await dirtyTab().waitFor();
    await app.page.click('section.claude:has(.new-session-body) [aria-label="キャンセル"]');
    await title(FIRST).waitFor();
    expect(await dialog().count()).toBe(0);
    await dirtyTab().waitFor();
  });

  it('「保存して移る」なら、保存してから移る', async () => {
    await row(SECOND).click();
    await dialog().getByRole('button', { name: '保存して移る' }).click();
    await title(SECOND).waitFor();
    expect(readFileSync(join(app.work, 'note.txt'), 'utf8')).toBe('はじめの文 残す\n');
  });

  it('新規セッションの画面でフォルダを変えるときも確かめる', async () => {
    await row(FIRST).click();
    await title(FIRST).waitFor();
    await edit(' もう一度');
    await app.page.click('nav.sidebar .new-session-button');
    await app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${app.work}"]`).waitFor();
    await app.page.click('.new-session-chips .folder-picker > button.new-session-chip');
    await app.page.click(`.folder-menu-item[title="${other}"]`);
    await dialog().waitFor();
    await dialog().getByRole('button', { name: 'やめる' }).click();
    await app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${app.work}"]`).waitFor();
    await dirtyTab().waitFor();
  });

  it('ディスク側でも変わったファイルは分けて示し、「保存して移る」は押せない。「やめる」でそのファイルを開き、衝突の知らせを見せる', async () => {
    // note.txt は書きかけのまま（前のテスト）。ディスク側で note.txt が変わり、エディタに届いて衝突になる
    const conflictBanner = () => app.byText('.pending-banner', '未保存の変更があるうちに、ディスク上のファイルが変更されました');
    writeFileSync(join(app.work, 'note.txt'), 'Claude が書いた\n');
    await conflictBanner().waitFor();
    // 別のタブ（memo.txt）を見ている間は、衝突の知らせは見えない
    await app.page.click('.tree-row[title="memo.txt"]');
    await app.byText('.editor-tab.active', 'memo.txt').waitFor();
    await conflictBanner().waitFor({ state: 'detached' });
    await app.page.click('.new-session-chips .folder-picker > button.new-session-chip');
    await app.page.click(`.folder-menu-item[title="${other}"]`);
    await dialog().waitFor();
    expect(await dialog().innerText()).toContain('ディスク側（Claude など）でも変わっています');
    expect(await dialog().getByRole('button', { name: '保存して移る' }).isDisabled()).toBe(true);
    await dialog().getByRole('button', { name: 'やめる' }).click();
    await dialog().waitFor({ state: 'detached' });
    // 衝突しているファイルを開き、どちらを残すかを選ぶ知らせを出す。ディスクは Claude が書いたまま
    await app.byText('.editor-tab.active', 'note.txt').waitFor();
    await conflictBanner().waitFor();
    expect(readFileSync(join(app.work, 'note.txt'), 'utf8')).toBe('Claude が書いた\n');
  });

  // ディスクの変更の知らせ（fs:changed）が届く前に「保存して移る」を押したときは、確かめを出す時点では衝突と分からない。
  // 開いているタブは、監視しないフォルダ（out）の中でも見張っていて、知らせはすぐ届くので、main で知らせを止めてこの場面を作る
  // （止めないと、知らせが届く早さ次第で、確かめを出す時点で衝突と分かり、「保存して移る」が押せないことがある）
  it('「保存して移る」で保存しようとして、ディスク側でも変わっていたと分かったファイルは書かず、移らない。「やめる」でそのファイルを開き、衝突の知らせを見せる', async () => {
    const report = join(app.work, 'out', 'report.txt');
    const conflictBanner = () => app.byText('.pending-banner', '未保存の変更があるうちに、ディスク上のファイルが変更されました');
    // 前のテストの衝突は、ディスクの内容を読み込んで片付け、作業フォルダのセッションに戻る
    await app.page.getByRole('button', { name: 'ディスクの内容を読み込む' }).click();
    await app.page.click('section.claude:has(.new-session-body) [aria-label="キャンセル"]');
    await title(FIRST).waitFor();
    mkdirSync(join(app.work, 'out'));
    writeFileSync(report, 'はじめの報告\n');
    await app.page.keyboard.press('ControlOrMeta+P');
    await app.page.fill('.quick-open input', 'report');
    await app.byText('.quick-open-list .quick-open-name', 'report.txt').waitFor();
    await app.page.keyboard.press('Enter');
    await app.byText('.editor-tab.active', 'report.txt').waitFor();
    await app.page.locator('.editor .editor-monaco .view-line', { hasText: 'はじめの報告' }).first().click();
    await app.page.keyboard.press('End');
    await app.page.keyboard.type(' 手で直した');
    await dirtyTab().waitFor();
    // 画面へのファイルの変更の知らせを、main で止める
    await app.app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      (globalThis as { e2eRestoreSend?: () => void }).e2eRestoreSend = () => {
        contents.send = send;
      };
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel !== 'fs:changed') send(channel, ...args);
      };
    });
    const alerts: string[] = [];
    try {
      writeFileSync(report, 'Claude が書いた報告\n');
      await row(SECOND).click();
      await dialog().waitFor();
      expect(await dialog().innerText()).toContain('out/report.txt');
      // 保存できなかった理由は window.alert で出る（押したボタンのクリックは、alert を閉じるまで終わらないので、受けたらすぐ閉じる）
      app.page.once('dialog', (shown) => {
        alerts.push(shown.message());
        void shown.accept();
      });
      await dialog().getByRole('button', { name: '保存して移る' }).click();
      await expect.poll(() => alerts.length, { timeout: 30_000 }).toBe(1);
    } finally {
      await app.app.evaluate(() => (globalThis as { e2eRestoreSend?: () => void }).e2eRestoreSend?.());
    }
    expect(alerts[0]).toContain('out/report.txt は、ディスク側（Claude など）でも変わっています');
    await dialog().getByRole('button', { name: '保存して移る', disabled: false }).waitFor();
    await title(FIRST).waitFor();
    expect(readFileSync(report, 'utf8')).toBe('Claude が書いた報告\n');
    await dialog().getByRole('button', { name: 'やめる' }).click();
    await dialog().waitFor({ state: 'detached' });
    await app.byText('.editor-tab.active', 'report.txt').waitFor();
    await conflictBanner().waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
