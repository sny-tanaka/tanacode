import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// ワークスペースにフォルダを追加する。エクスプローラーの見出しの ＋ で選んだフォルダが、セッションのフォルダの下にツリーで並び、
// エディタで開けて、ディスクの変更がエディタに戻るか。Claude Code にも --add-dir で渡り（手が空いているので、すぐ起動し直す）、
// Claude が確認なしでそのフォルダを読めるか。外すと、ツリーから消え、Claude Code にも渡さなくなるか

const PROMPT = 'フォルダを足すので待っていてください';
const READ = 'ライブラリのファイルを読んでください';
const SECOND = '足したフォルダが見えますか';
const LIB = 'lib';
const UTIL = 'export const util = 1;\n';

describe('ワークスペースにフォルダを追加して、エクスプローラー・エディタ・Claude Code で扱う', () => {
  let app: E2EApp;
  // 追加するフォルダ（作業フォルダの隣。作業フォルダの外）
  let lib: string;
  const editorLine = (text: string) => app.page.locator('.editor .editor-monaco .view-line', { hasText: text }).first();
  // 動いている Claude Code の起動の引数に、--add-dir があるか
  const passed = async () => (await app.claudeArgs()).some((args) => args.includes(`--add-dir ${lib}`));
  async function untilPassed(expected: boolean): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if ((await passed()) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Claude Code の起動の引数に --add-dir ${lib} が${expected ? '付き' : '無くなり'}ません`);
  }

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      files: { 'README.md': '# shop\n' },
      conversations: (work) => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'text', text: 'わかりました' }],
            [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: join(dirname(work), LIB, 'src', 'util.ts') } }],
            [{ type: 'text', text: '読みました' }],
          ],
        },
        { match: SECOND, steps: [[{ type: 'text', text: '見えています' }]] },
      ],
    });
    lib = join(app.root, LIB);
    mkdirSync(join(lib, 'src'), { recursive: true });
    writeFileSync(join(lib, 'src', 'util.ts'), UTIL);
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`added-folders-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('見出しの ＋ で選んだフォルダが、セッションのフォルダの下にツリーで並び、Claude Code に --add-dir で渡る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', 'わかりました').waitFor();
    expect(await passed()).toBe(false);
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    // フォルダを選ぶダイアログは、追加するフォルダを選んだことにする
    await app.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, lib);
    await app.page.click('.side-panel-title [aria-label="フォルダを追加"]');
    await app.page.locator(`.tree-row[title="${lib}"]`).waitFor();
    await app.page.locator('.tree-row[title="README.md"]').waitFor();
    // 手が空いているので、すぐに起動し直して渡す
    await untilPassed(true);
  });

  it('追加したフォルダのファイルを開くと、エディタに出て、ディスクの変更がエディタに戻る', async () => {
    await app.page.click(`.tree-row[title="${lib}/src"]`);
    await app.page.click(`.tree-row[title="${lib}/src/util.ts"]`);
    await app.byText('.editor-tab.active', 'util.ts').waitFor();
    await editorLine('export const util = 1').waitFor();
    writeFileSync(join(lib, 'src', 'util.ts'), 'export const util = 2;\n');
    await editorLine('export const util = 2').waitFor();
  });

  it('Claude は、追加したフォルダのファイルを確認なしで読める。読んだファイルに印が付く', async () => {
    await app.send(READ);
    await app.byText('.chat-list', '読みました').waitFor();
    expect(await app.page.locator('.chat-list .menu-card.permission').count()).toBe(0);
    expect(app.api.toolResults.some((r) => r.includes('export const util = 2'))).toBe(true);
    await app.page.locator(`.tree-row[title="${lib}/src/util.ts"] .tree-know.read`).waitFor();
  });

  it('外すと、ツリーから消え、Claude Code にも渡さなくなる（フォルダそのものは残る）', async () => {
    const row = app.page.locator(`.tree-row[title="${lib}"]`);
    await row.hover();
    await row.locator('[aria-label="ワークスペースから外す"]').click();
    await row.waitFor({ state: 'detached' });
    await untilPassed(false);
    await app.page.locator('.tree-row[title="README.md"]').waitFor();
  });

  it('新規セッションの画面で追加したフォルダは、始めたセッションに渡り、はじめから --add-dir で起動する', async () => {
    await app.page.click('nav.sidebar .new-session-button');
    // 見ていたセッションのフォルダ（作業フォルダ）が選ばれている
    await app.page.locator(`.new-session-chips .folder-picker > button.new-session-chip[title="${app.work}"]`).waitFor();
    await app.page.click('.side-panel-title [aria-label="フォルダを追加"]');
    await app.page.locator(`.tree-row[title="${lib}"]`).waitFor();
    // Remote Control は使わない（パッケージしたアプリでは既定でオン。モックの API ではつながらない）
    const remote = app.page.locator('.claude-header [role="switch"][aria-label="Remote Control"]');
    if ((await remote.count()) > 0 && (await remote.getAttribute('aria-checked')) === 'true') await remote.click();
    await app.send(SECOND);
    await app.byText('.chat-list', '見えています').waitFor();
    // 前のセッションからは外したので、--add-dir が付いているのは、始めたセッションの Claude Code
    expect(await passed()).toBe(true);
    await app.page.locator(`.tree-row[title="${lib}"]`).waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
