import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// 作業フォルダのファイルを、エクスプローラー・エディタ・Markdown のプレビュー・⌘P・全文検索で扱う。
// エディタで書いたものがディスクに保存され、ディスクの変更がエディタに戻るか

const PROMPT = 'ファイルを見ていてください';
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
      files: { 'README.md': README, 'src/tax.ts': TAX },
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: 'わかりました' }]] }],
    });
    // 画像はバイナリなので、files とは別に置く
    mkdirSync(join(app.work, 'docs'), { recursive: true });
    writeFileSync(join(app.work, 'docs', 'dot.png'), PNG);
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`workspace-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Markdown を開くと、整形して出る（コードの色付け・mermaid の図・フォルダの中の画像）', async () => {
    await app.startSession(PROMPT);
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

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
