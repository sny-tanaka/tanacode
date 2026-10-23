import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// Claude がフォルダの外で読んだもの。Claude が作業フォルダの外のファイルを読むと、エクスプローラーに見出しを分けて並ぶか
// （git のリポジトリの中ならそのリポジトリのいちばん上をツリーで、それ以外はファイルを 1 行で）。~/.claude の中は出ないか。
// 出すだけで Claude Code には --add-dir で渡さず、＋ で追加したフォルダに移すと渡るか。× で一覧から消えるか

const PROMPT = '外のファイルを読んでください';
const REPO = 'other-repo';
const LOOSE = 'loose';

describe('Claude がフォルダの外で読んだものを、エクスプローラーに出す', () => {
  let app: E2EApp;
  // 作業フォルダの隣の、git のリポジトリと、どのリポジトリにも入っていないファイル
  let repo: string;
  let memo: string;
  const passed = async () => (await app.claudeArgs()).some((args) => args.includes(`--add-dir ${repo}`));
  async function untilPassed(): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (await passed()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Claude Code の起動の引数に --add-dir ${repo} が付きません`);
  }

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      ownTmp: true,
      files: { 'README.md': '# shop\n' },
      // 作業フォルダの外を読むので、確認を出さないよう Read を許しておく
      claudeSettings: { permissions: { allow: ['Read'] } },
      conversations: (work) => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'tool_use', id: 'toolu_repo', name: 'Read', input: { file_path: join(dirname(work), REPO, 'src', 'pay.ts') } }],
            [{ type: 'tool_use', id: 'toolu_memo', name: 'Read', input: { file_path: join(dirname(work), LOOSE, 'memo.txt') } }],
            [{ type: 'tool_use', id: 'toolu_config', name: 'Read', input: { file_path: join(dirname(work), 'home', '.claude', 'settings.json') } }],
            [{ type: 'text', text: '読みました' }],
          ],
        },
      ],
    });
    repo = join(app.root, REPO);
    memo = join(app.root, LOOSE, 'memo.txt');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'pay.ts'), 'export const pay = 1;\n');
    mkdirSync(dirname(memo));
    writeFileSync(memo, 'メモ\n');
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`outside-reads-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('リポジトリはいちばん上をツリーで、それ以外はファイルを、見出しを分けて並べる。~/.claude の中は出さず、--add-dir にも渡さない', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', '読みました').waitFor();
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await app.byText('.tree-section', 'Claude が読んだフォルダ').waitFor();
    await app.byText('.tree-section', 'フォルダ外で Claude が読み書きしたファイル').waitFor();
    await app.page.locator(`.tree-row[title="${repo}"]`).waitFor();
    // ファイルの行には、読んだ印が付く
    await app.page.locator(`.tree-row[title="${memo}"] .tree-know.read`).waitFor();
    expect(await app.page.locator(`.tree-row[title*="/home/.claude"]`).count()).toBe(0);
    // リポジトリは閉じて始め、開くと中身を読む。中のファイルにも読んだ印が付く
    await app.page.click(`.tree-row[title="${repo}"]`);
    await app.page.click(`.tree-row[title="${repo}/src"]`);
    await app.page.locator(`.tree-row[title="${repo}/src/pay.ts"] .tree-know.read`).waitFor();
    expect(await passed()).toBe(false);
  });

  it('ファイルの行を押すと、エディタで開く', async () => {
    await app.page.click(`.tree-row[title="${memo}"]`);
    await app.byText('.editor-tab.active', 'memo.txt').waitFor();
  });

  it('リポジトリの行の ＋ で、追加したフォルダに移し、Claude Code に --add-dir で渡す', async () => {
    const row = app.page.locator(`.tree-row[title="${repo}"]`);
    await row.hover();
    await row.locator('[aria-label="ワークスペースに追加"]').click();
    await app.byText('.tree-section', 'Claude が読んだフォルダ').waitFor({ state: 'detached' });
    // 追加したフォルダとして残る（外すボタンが付く）
    await row.hover();
    await row.locator('[aria-label="ワークスペースから外す"]').waitFor();
    await untilPassed();
  });

  it('ファイルの行の × で、一覧から消す（ファイルそのものは残る）', async () => {
    const row = app.page.locator(`.tree-row[title="${memo}"]`);
    await row.hover();
    await row.locator('[aria-label="一覧から消す"]').click();
    await row.waitFor({ state: 'detached' });
    expect(await app.page.locator('.tree-section').count()).toBe(0);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
