import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 作業フォルダのファイルを、エクスプローラー・エディタ・Markdown のプレビュー・⌘P・全文検索で扱う。
// エディタで書いたものがディスクに保存され、ディスクの変更がエディタに戻るか（フォルダの監視の外のファイル（監視しない out の中・
// リンク越し・作業フォルダの外）も、Claude Code の編集も）。日本語の名前のファイルも、⌘P と入力欄の @ の補完で扱えるか

const PROMPT = 'ファイルを見ていてください';
const MENTION = 'を読んでください';
const OUTSIDE_READ = '外のメモを読んでください';
const OUTSIDE_EDIT = '外のメモを直してください';
// 作業フォルダの外のファイル（作業フォルダの隣）
const OUTSIDE = (work: string) => join(dirname(work), 'notes', 'memo.txt');
// 日本語の名前のファイル（一覧を -z なしで読むと、"\347\250\216..." のようにエスケープされて返る）
const NOTE = '税込みの価格は、1 円未満を切り捨てます。\n';
// 1×1 の PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const README = [
  '# 使い方の説明',
  '',
  '本文の段落です。',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  入力 --> 出力',
  '```',
  '',
  '![図](docs/dot.png)',
  '',
  '[税の計算](src/tax.ts#L3)',
  '',
].join('\n');
const TAX = ['export const TAX_RATE = 0.1;', '', 'export function withTax(price: number): number {', '  return Math.floor(price * (1 + TAX_RATE));', '}', ''].join('\n');

describe('作業フォルダのファイルを、エディタと検索で扱う', () => {
  let app: E2EApp;
  // エディタに描かれた行（タブが切り替わってから、Monaco が行を描くまで少しかかるので待つ）
  const editorLine = (text: string) => app.page.locator('.editor .editor-monaco .view-line', { hasText: text }).first();

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      files: { 'README.md': README, 'src/tax.ts': TAX, 'docs/税の説明.md': NOTE },
      conversations: (work) => [
        {
          match: PROMPT,
          steps: [
            [{ type: 'text', text: 'わかりました' }],
            [{ type: 'tool_use', id: 'toolu_read_outside', name: 'Read', input: { file_path: OUTSIDE(work) } }],
            [{ type: 'text', text: '外のメモを読みました' }],
            [{ type: 'tool_use', id: 'toolu_edit_outside', name: 'Edit', input: { file_path: OUTSIDE(work), old_string: 'はじめのメモ', new_string: 'Claude が直したメモ' } }],
            [{ type: 'text', text: '外のメモを直しました' }],
            [{ type: 'text', text: '説明を読みました' }],
          ],
        },
      ],
    });
    // 画像はバイナリなので、files とは別に置く
    mkdirSync(join(app.work, 'docs'), { recursive: true });
    writeFileSync(join(app.work, 'docs', 'dot.png'), PNG);
    // 作業フォルダの外のファイルと、作業フォルダから外のファイルを指すリンク
    mkdirSync(dirname(OUTSIDE(app.work)), { recursive: true });
    writeFileSync(OUTSIDE(app.work), 'はじめのメモ\n');
    mkdirSync(join(app.root, 'shared'));
    writeFileSync(join(app.root, 'shared', 'note.txt'), '共有のメモ\n');
    symlinkSync(join(app.root, 'shared', 'note.txt'), join(app.work, 'shared-note.txt'));
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`workspace-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Markdown を開くと、整形して出る（コードの色付け・mermaid の図・フォルダの中の画像）', async () => {
    // 作業フォルダの外のファイルを読む・書くときに、許可の確認を出させる（あとのテスト）
    await app.startSession(PROMPT, { mode: 'manual' });
    await app.byText('.chat-list', 'わかりました').waitFor();
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await app.page.click('.tree-row[title="README.md"]');
    const doc = app.page.locator('.markdown-preview .markdown-doc');
    await doc.locator('h1', { hasText: '使い方の説明' }).waitFor();
    // ts のコードは Monaco と同じ色付けになる（色の付いた span に分かれる）
    await doc.locator('pre > code span', { hasText: 'answer' }).first().waitFor();
    // mermaid は図（SVG）になる
    await doc.locator('svg').first().waitFor();
    // フォルダの中の画像は、アプリが読んで出す
    await app.page.waitForFunction(() => document.querySelector<HTMLImageElement>('.markdown-preview img[data-path="docs/dot.png"]')?.src.startsWith('data:'));
  });

  it('プレビューの相対リンクで、ファイルの行を開ける', async () => {
    await app.byText('.markdown-preview a', '税の計算').click();
    await app.byText('.editor-tab.active', 'tax.ts').waitFor();
    await editorLine('TAX_RATE').waitFor();
  });

  it('エディタで書き換えて ⌘S で保存すると、ディスクに書かれる', async () => {
    await app.page.locator('.editor .editor-monaco .view-line', { hasText: 'export const TAX_RATE' }).click();
    await app.page.keyboard.press('End');
    await app.page.keyboard.type(' // 消費税');
    await app.page.locator('.editor-tab.active .editor-tab-dot.dirty').waitFor();
    await app.page.keyboard.press('ControlOrMeta+S');
    await app.page.locator('.editor-tab.active .editor-tab-dot.dirty').waitFor({ state: 'detached' });
    expect(readFileSync(join(app.work, 'src/tax.ts'), 'utf8').split('\n')[0]).toBe('export const TAX_RATE = 0.1; // 消費税');
  });

  it('ディスクで書き換わったファイルは、エディタにも戻る', async () => {
    writeFileSync(join(app.work, 'src/tax.ts'), TAX.replace('0.1', '0.08'));
    await app.page.waitForFunction(() => document.querySelector('.editor .editor-monaco .view-lines')?.textContent?.includes('0.08'));
  });

  it('⌘P で、ファイル名から開ける', async () => {
    await app.page.keyboard.press('ControlOrMeta+P');
    await app.page.fill('.quick-open input', 'READ');
    await app.byText('.quick-open-list .quick-open-name', 'README.md').waitFor();
    await app.page.keyboard.press('Enter');
    await app.byText('.editor-tab.active', 'README.md').waitFor();
    await app.page.locator('.quick-open').waitFor({ state: 'detached' });
  });

  it('⌘⇧F の全文検索で見つけた行を、エディタで開ける', async () => {
    await app.page.keyboard.press('ControlOrMeta+Shift+F');
    await app.page.locator('.search-panel input').fill('withTax');
    await app.byText('.search-panel .search-file-name', 'tax.ts').waitFor();
    await app.byText('.search-panel .search-match', 'withTax').first().click();
    await app.byText('.editor-tab.active', 'tax.ts').waitFor();
  });

  it('変更の知らせを取りこぼしても、開いているファイルを開き直すと、ディスクから読み直す', async () => {
    // 画面へのファイルの変更の知らせ（fs:changed）を、main で止める
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
    try {
      writeFileSync(join(app.work, 'src/tax.ts'), TAX.replace('0.1', '0.05'));
      await app.page.keyboard.press('ControlOrMeta+P');
      await app.page.fill('.quick-open input', 'tax');
      await app.byText('.quick-open-list .quick-open-name', 'tax.ts').waitFor();
      await app.page.keyboard.press('Enter');
      await app.page.locator('.quick-open').waitFor({ state: 'detached' });
      await editorLine('TAX_RATE = 0.05').waitFor();
    } finally {
      await app.app.evaluate(() => (globalThis as { e2eRestoreSend?: () => void }).e2eRestoreSend?.());
    }
  });

  // 変更の知らせが届く前（知らせをまとめる間）に保存しても、書く前に main が、読んだときの中身のままかを確かめる
  it('保存していない変更があるうちにディスク側でも変わっていたら、⌘S では書かず、衝突の知らせを出す。「このまま保存」を選んだときだけ上書きする', async () => {
    const report = join(app.work, 'out', 'report.txt');
    const dirty = () => app.page.locator('.editor-tab.active .editor-tab-dot.dirty');
    mkdirSync(join(app.work, 'out'));
    writeFileSync(report, 'はじめの報告\n');
    await app.page.keyboard.press('ControlOrMeta+P');
    await app.page.fill('.quick-open input', 'report');
    await app.byText('.quick-open-list .quick-open-name', 'report.txt').waitFor();
    await app.page.keyboard.press('Enter');
    await app.byText('.editor-tab.active', 'report.txt').waitFor();
    await editorLine('はじめの報告').click();
    await app.page.keyboard.press('End');
    await app.page.keyboard.type(' 手で直した');
    await dirty().waitFor();
    writeFileSync(report, 'Claude が書いた報告\n');
    await app.page.keyboard.press('ControlOrMeta+S');
    await app.byText('.pending-banner', '未保存の変更があるうちに、ディスク上のファイルが変更されました').waitFor();
    expect(readFileSync(report, 'utf8')).toBe('Claude が書いた報告\n');
    await dirty().waitFor();
    await app.page.getByRole('button', { name: 'このまま保存' }).click();
    await dirty().waitFor({ state: 'detached' });
    expect(readFileSync(report, 'utf8')).toBe('はじめの報告 手で直した\n');
  });

  it('監視しないフォルダ（out など）のファイルも、開いている間は、ディスクで書き換わるとエディタに戻る', async () => {
    await app.byText('.editor-tab.active', 'report.txt').waitFor();
    writeFileSync(join(app.work, 'out', 'report.txt'), 'ビルドし直した報告\n');
    await editorLine('ビルドし直した報告').waitFor();
  });

  it('リンク越しに開いたファイルも、リンクの先が書き換わるとエディタに戻る', async () => {
    await app.page.keyboard.press('ControlOrMeta+P');
    await app.page.fill('.quick-open input', 'shared-note');
    await app.byText('.quick-open-list .quick-open-name', 'shared-note.txt').waitFor();
    await app.page.keyboard.press('Enter');
    await app.page.locator('.quick-open').waitFor({ state: 'detached' });
    await app.byText('.editor-tab.active', 'shared-note.txt').waitFor();
    await editorLine('共有のメモ').waitFor();
    writeFileSync(join(app.root, 'shared', 'note.txt'), '共有のメモを書き換えた\n');
    await editorLine('共有のメモを書き換えた').waitFor();
  });

  it('作業フォルダの外のファイルも、チャットのツールから開くと、Claude Code の編集とディスクの変更がエディタに戻る', async () => {
    await app.send(OUTSIDE_READ);
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', '外のメモを読みました').waitFor();
    // ツールの呼び出しは畳まれているので、開いてから、Read のカードでファイルを開く
    const head = app.page.locator('.chat-list .tool-group-head[aria-expanded="false"]').last();
    await app.press(head);
    await app.byText('.chat-list .tool-card', 'memo.txt').click();
    await app.byText('.editor-tab.active', 'memo.txt').waitFor();
    await editorLine('はじめのメモ').waitFor();
    // Claude Code は、一時ファイルに書いてから置き換える
    await app.send(OUTSIDE_EDIT);
    await app.choose(await app.menuCard('permission'), /^許可する/);
    await app.byText('.chat-list', '外のメモを直しました').waitFor();
    expect(readFileSync(OUTSIDE(app.work), 'utf8')).toBe('Claude が直したメモ\n');
    await editorLine('Claude が直したメモ').waitFor();
    writeFileSync(OUTSIDE(app.work), 'ディスクで書き換えたメモ\n');
    await editorLine('ディスクで書き換えたメモ').waitFor();
  });

  // エクスプローラーの右クリックのメニュー。作ったファイルは開き、書きかけのまま名前を変えるときは保存してから変えて、タブも新しい名前にする。
  // ゴミ箱に入れたら、そのタブを閉じる（本当のゴミ箱には入れず、main の shell.trashItem を差し替えて、渡したパスを見る）
  it('右クリックのメニューで、ファイルを作り、書きかけのまま名前を変え、ゴミ箱に入れる。開いているタブも合わせる', async () => {
    const row = (path: string) => app.page.locator(`.tree-row[title="${path}"]`);
    const pick = async (path: string, label: string) => {
      await row(path).click({ button: 'right' });
      await app.page.getByRole('menuitem', { name: label }).click();
    };
    const confirms: string[] = [];
    const onDialog = (dialog: import('playwright').Dialog) => {
      confirms.push(dialog.message());
      void dialog.accept();
    };
    app.page.on('dialog', onDialog);
    try {
      // 前のテストの全文検索で、サイドパネルが検索になっている
      await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
      await pick('src', '新規ファイル');
      await app.page.locator('.tree-input').fill('rate.ts');
      await app.page.keyboard.press('Enter');
      await app.byText('.editor-tab.active', 'rate.ts').waitFor();
      expect(readFileSync(join(app.work, 'src/rate.ts'), 'utf8')).toBe('');

      await app.page.locator('.editor .editor-monaco .view-lines').click();
      await app.page.keyboard.type('export const RATE = 0.1;');
      await app.page.locator('.editor-tab.active .editor-tab-dot.dirty').waitFor();
      await pick('src/rate.ts', '名前を変更');
      await app.page.locator('.tree-input').fill('rates.ts');
      await app.page.keyboard.press('Enter');
      await app.byText('.editor-tab.active', 'rates.ts').waitFor();
      await row('src/rates.ts').waitFor();
      expect(confirms).toEqual(['rate.ts に、保存していない変更があります。保存してから名前を変えますか？']);
      expect(existsSync(join(app.work, 'src/rate.ts'))).toBe(false);
      expect(readFileSync(join(app.work, 'src/rates.ts'), 'utf8')).toBe('export const RATE = 0.1;');
      expect(await app.page.locator('.editor-tab.active .editor-tab-dot.dirty').count()).toBe(0);

      await app.app.evaluate(({ shell }) => {
        const trashed: string[] = [];
        (globalThis as { e2eTrashed?: string[] }).e2eTrashed = trashed;
        shell.trashItem = async (path: string) => {
          trashed.push(path);
        };
      });
      await pick('src/rates.ts', 'ゴミ箱に入れる');
      await app.byText('.editor-tab', 'rates.ts').waitFor({ state: 'detached' });
      expect(confirms.at(-1)).toBe('rates.ts をゴミ箱に入れますか？');
      expect(await app.app.evaluate(() => (globalThis as { e2eTrashed?: string[] }).e2eTrashed)).toEqual([join(realpathSync(app.work), 'src', 'rates.ts')]);
    } finally {
      app.page.off('dialog', onDialog);
    }
  });

  // ⌘P の枠を開いたまま落ちると、続くテストの操作が枠に遮られるので、画面を操作するテストの最後に置く
  it('日本語の名前のファイルも、⌘P で開け、入力欄の @ の補完で選んで送ると、中身が Claude に渡る', async () => {
    await app.page.keyboard.press('ControlOrMeta+P');
    await app.page.fill('.quick-open input', '税の');
    await app.byText('.quick-open-list .quick-open-name', '税の説明.md').waitFor();
    await app.page.keyboard.press('Enter');
    await app.byText('.editor-tab.active', '税の説明.md').waitFor();
    const input = app.page.locator('.chat-input textarea');
    await input.fill('');
    await input.pressSequentially('@税の');
    await app.byText('.suggest-item .suggest-detail', 'docs/税の説明.md').waitFor();
    await input.press('Enter');
    expect(await input.inputValue()).toBe('@docs/税の説明.md ');
    await input.pressSequentially(MENTION);
    await app.page.click('.chat-input-row [aria-label="送信"]');
    await app.byText('.chat-list', '説明を読みました').waitFor();
    expect(app.api.contexts.at(-1)).toContain('1 円未満を切り捨てます');
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
