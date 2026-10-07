import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// Claude が直したファイルを、ソース管理の画面で見て、差分の行にコメントを付けて Claude に返し、画面からコミットする。
// コメントは、チャットの入力欄に付けて送ると、ファイルと行の付いた指示として Claude に届く

const PROMPT = '税率を 8% に直してください';
const REPLY = '直しました';
const COMMENT = 'ここは設定から読むようにしたい';
const FOLLOW = 'コメントを見てください';
const READ_COMMENT = 'コメントを読みました';
const COMMIT = '税率を 8% にする';
const TAX = ['export const TAX_RATE = 0.1;', '', 'export function withTax(price: number): number {', '  return Math.floor(price * (1 + TAX_RATE));', '}', ''].join('\n');

describe('ソース管理の画面から、差分にコメントして返し、コミットする', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      git: true,
      trusted: true,
      files: { 'src/tax.ts': TAX },
      conversations: (work) => [
        {
          match: PROMPT,
          steps: [
            // 書き換える前に読む（Claude Code は、読んでいないファイルを書き換えない）
            [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: join(work, 'src/tax.ts') } }],
            [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: join(work, 'src/tax.ts'), old_string: 'TAX_RATE = 0.1', new_string: 'TAX_RATE = 0.08' } }],
            [{ type: 'text', text: REPLY }],
            [{ type: 'text', text: READ_COMMENT }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`scm-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Claude が直したファイルが、ソース管理の変更に出る', async () => {
    // 編集を確認なしで通す
    await app.startSession(PROMPT, { mode: 'acceptEdits' });
    await app.byText('.chat-list', REPLY).waitFor();
    expect(readFileSync(join(app.work, 'src/tax.ts'), 'utf8')).toContain('TAX_RATE = 0.08');
    await app.page.click('.activity-bar [aria-label^="ソース管理"]');
    await app.page.locator('.scm-panel .scm-row[title="src/tax.ts"]').waitFor();
  });

  it('差分を開いて行にコメントを付け、チャットから送ると Claude に届く', async () => {
    await app.page.click('.scm-panel .scm-row[title="src/tax.ts"]');
    await app.page.locator('.diff-pane .modified-in-monaco-diff-editor .view-line', { hasText: 'TAX_RATE = 0.08' }).waitFor();
    await app.startComment('TAX_RATE = 0.08');
    await app.page.fill('.comment-box.draft textarea', COMMENT);
    await app.page.click('.comment-box.draft [aria-label="コメントを追加"]');
    // コメントは入力欄に付く
    await app.byText('.chat-input .comment-chip', COMMENT).waitFor();
    await app.send(FOLLOW);
    await app.byText('.chat-list', READ_COMMENT).waitFor();
    const sent = app.api.lastPrompts.find((p) => p.includes(FOLLOW)) ?? '';
    expect(sent).toContain(COMMENT);
    expect(sent).toContain('src/tax.ts:1');
  });

  it('変更をステージして、画面からコミットできる', async () => {
    // 行のボタンは、マウスを乗せると出る
    const row = app.page.locator('.scm-panel .scm-row[title="src/tax.ts"]');
    await row.hover();
    await row.locator('[aria-label="ステージする"]').click();
    await app.page.locator('.scm-panel .scm-row[title="src/tax.ts"] [aria-label="ステージを取り消す"]').waitFor();
    await app.page.fill('.scm-commit textarea', COMMIT);
    await app.page.click('.scm-commit [aria-label="コミット"]');
    await app.page.locator('.scm-panel .scm-row[title="src/tax.ts"]').waitFor({ state: 'detached' });
    expect(app.git('log', '-1', '--format=%s').trim()).toBe(COMMIT);
    expect(app.git('status', '--porcelain').trim()).toBe('');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
