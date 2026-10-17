import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// ⌘R で画面を読み込み直す。セッションのシェル（開発サーバーなど）は止めずに、読み込み直した画面のターミナルパネルに、
// 同じタブと画面の中身を出し直す（Claude Code のセッションと同じく、画面を読み込み直しても動き続ける）。
// 前の画面が開いた新規セッションの画面のフォルダは、そこで開いたシェルごと片付ける（新しい画面からは見えず、使えないため）

const PROMPT = 'ターミナルを使います';

describe('画面を読み込み直しても、セッションのシェルを引き継ぐ', () => {
  let app: E2EApp;
  const shell = () => app.page.locator('.terminal-panel .terminal-host:not([hidden]) .terminal-instance:not([hidden])');
  const rows = () => shell().locator('.xterm-rows');
  // シェルの pid を書かせたファイルから読む
  const pidIn = (name: string) => Number(readFileSync(join(app.root, name), 'utf8').trim());
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // 見えているシェルに打って、出力を待つ
  const type = async (command: string, output: string) => {
    await rows().waitFor();
    await shell().locator('.xterm-helper-textarea').focus();
    await app.page.keyboard.type(command);
    await app.page.keyboard.press('Enter');
    await rows().getByText(output, { exact: false }).waitFor();
  };

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: 'どうぞ' }]] }],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`reload-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('セッションのシェルは動き続け、同じタブと画面が戻る。新規セッションの画面で開いたシェルは止める', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', 'どうぞ').waitFor();
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await type(`export MARK=kept; echo $$ > ${join(app.root, 'session.pid')}; echo before-$((1+1))`, 'before-2');
    // 新規セッションの画面でも、そのフォルダのシェルが開く（パネルは開いたまま）
    await app.page.click('nav.sidebar .new-session-button');
    await app.page.locator('section.claude:has(.new-session-body)').waitFor();
    await type(`echo $$ > ${join(app.root, 'draft.pid')}; echo draft-$((2+1))`, 'draft-3');
    const sessionPid = pidIn('session.pid');
    const draftPid = pidIn('draft.pid');

    await app.page.reload();
    await app.page.waitForSelector('nav.sidebar');
    await app.byText('.claude-header .claude-title', PROMPT).waitFor();
    // 新規セッションの画面で開いたシェルは止める。セッションのシェルは動いたまま
    await app.waitUntil('新規セッションの画面のシェルが終わる', () => !alive(draftPid));
    expect(alive(sessionPid)).toBe(true);
    // ターミナルパネルを開くと、同じシェルのタブが 1 つだけ出て（新しく開かない）、読み込み直す前の画面が見える
    await app.page.click('.activity-bar [aria-label="ターミナル"]');
    await rows().getByText('before-2', { exact: false }).waitFor();
    expect(await app.page.locator('.terminal-panel .terminal-tab').count()).toBe(1);
    // 同じシェルなので、読み込み直す前に決めた変数が残っている
    await type('echo $MARK-$((3+1))', 'kept-4');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
