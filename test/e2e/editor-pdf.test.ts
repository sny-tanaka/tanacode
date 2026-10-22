import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// エディタで PDF を開く（Electron 組み込みの PDF ビューアを、blob: の iframe で出す）と、SVG を画像（プレビュー）でも見られること、
// エディタのファイルを Finder で開くボタン。
// 組み込みのビューアは、画面の CSP（frame-src）や、main が見張る画面の移動に止められうるので、本物のアプリで確かめる

const PROMPT = 'PDF を見ていてください';
// 透過の背景に、円だけを描いた SVG（画像で出ると、円の分の大きさになる）
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><circle cx="100" cy="50" r="40" fill="#d97757"/></svg>\n';

// 1 ページだけの、文字入りの PDF（xref の位置まで正しいもの）
function miniPdf(): Buffer {
  const stream = 'BT /F1 24 Tf 30 100 Td (Hello PDF in tanacode) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('エディタで PDF・SVG を開く・Finder で開く', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      files: { 'note.txt': 'メモ\n', 'logo.svg': SVG },
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: 'わかりました' }]] }],
    });
    // PDF はバイナリなので、files とは別に置く
    writeFileSync(join(app.work, 'spec.pdf'), miniPdf());
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`editor-pdf-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('PDF を開くと、組み込みのビューアで出る（バイナリの案内を出さない）', async () => {
    await app.startSession(PROMPT, { mode: 'manual' });
    await app.byText('.chat-list', 'わかりました').waitFor();
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await app.page.click('.tree-row[title="spec.pdf"]');
    await app.byText('.editor-tab.active', 'spec.pdf').waitFor();
    const viewer = app.page.locator('.editor-pdf iframe');
    await viewer.waitFor();
    expect(await viewer.getAttribute('src')).toMatch(/^blob:/);
    expect(await app.page.locator('.editor-placeholder').count()).toBe(0);
    // ビューアは拡張機能のフレームで読み込まれる（止められると、フレームは空のまま）。出すまで少しかかる
    const frames = () => app.page.frames().map((frame) => frame.url());
    await expect
      .poll(() => frames().some((url) => url.startsWith('chrome-extension://')), { timeout: 15_000, message: JSON.stringify(frames()) })
      .toBe(true);
  });

  it('SVG を開くと、はじめは画像（プレビュー）で出る。ソースに切り替えると、文字のエディタに戻る', async () => {
    await app.page.click('.tree-row[title="logo.svg"]');
    await app.byText('.editor-tab.active', 'logo.svg').waitFor();
    const image = app.page.locator('.svg-preview img');
    await image.waitFor();
    // 画像として読み込めている（CSP が data: を通す）。SVG の width・height の大きさで出る
    await app.page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('.svg-preview img');
      return !!img && img.complete && img.naturalWidth === 200 && img.naturalHeight === 100;
    });
    expect(await image.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    await app.page.getByRole('tab', { name: 'ソース' }).click();
    await image.waitFor({ state: 'detached' });
    await app.page.locator('.editor .editor-monaco .view-line', { hasText: '<circle' }).first().waitFor();
  });

  it('Finder で開くボタンは、開いているファイルを Finder に渡す（絶対パスで）', async () => {
    // 本物の Finder は開かず、main で渡されたパスを控える
    await app.app.evaluate(({ shell }) => {
      (shell as { showItemInFolder: (path: string) => void }).showItemInFolder = (path) => {
        (globalThis as { e2eRevealed?: string[] }).e2eRevealed = [...((globalThis as { e2eRevealed?: string[] }).e2eRevealed ?? []), path];
      };
    });
    const revealed = () => app.app.evaluate(() => (globalThis as { e2eRevealed?: string[] }).e2eRevealed ?? []);
    // 前のテストで開いた SVG が、開いているファイル
    await app.page.getByRole('button', { name: 'Finder で開く' }).click();
    await expect.poll(revealed).toEqual([join(app.work, 'logo.svg')]);
    // PDF・文字のファイルでも出る
    for (const name of ['spec.pdf', 'note.txt']) {
      await app.page.click(`.tree-row[title="${name}"]`);
      await app.byText('.editor-tab.active', name).waitFor();
      await app.page.getByRole('button', { name: 'Finder で開く' }).click();
    }
    await expect.poll(revealed).toEqual([join(app.work, 'logo.svg'), join(app.work, 'spec.pdf'), join(app.work, 'note.txt')]);
  });
});
