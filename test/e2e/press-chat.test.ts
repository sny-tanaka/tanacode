import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// エディタの行に付ける Claude へのコメント（LineComments）。Monaco の中に差し込んだ欄なので、画面の部品のテスト（jsdom）では描けない。
// 書きかけの欄のキー（Esc でやめる・⌘Enter で付ける）と、付けたコメントの「削除」を押して、チャットの入力欄の札まで効くかを確かめる

const PROMPT = 'ファイルを見ていてください';
const REPLY = 'わかりました';
const COMMENT = 'ここは設定から読むようにしたい';
const TAX = ['export const TAX_RATE = 0.1;', '', 'export function withTax(price: number): number {', '  return Math.floor(price * (1 + TAX_RATE));', '}', ''].join('\n');

describe('エディタの行に付けるコメント', () => {
  let app: E2EApp;
  const draft = () => app.page.locator('.editor .comment-box.draft textarea');
  // 付けたコメント（書きかけでないもの）
  const added = () => app.page.locator('.editor .comment-box:not(.draft)', { hasText: COMMENT });
  const chip = () => app.byText('.chat-input .comment-chip', COMMENT);

  // エディタで text を含む行の、行番号の横（グリフの余白）を押して、コメントを書き始める。
  // Monaco は描き直すと行の要素を作り直すので、位置が取れて書きかけの欄が開くまで繰り返す
  async function startComment(text: string): Promise<void> {
    const editor = app.page.locator('.editor .editor-monaco');
    for (let i = 0; i < 20; i++) {
      const glyph = await editor.locator('.glyph-margin').boundingBox().catch(() => null);
      const row = await editor.locator('.view-line', { hasText: text }).first().boundingBox().catch(() => null);
      if (glyph && row) {
        const y = row.y + row.height / 2;
        await app.page.mouse.move(row.x + 40, y);
        await app.page.mouse.click(glyph.x + glyph.width / 2, y);
        if (await draft().waitFor({ timeout: 1000 }).then(() => true, () => false)) return;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(`「${text}」の行にコメントを書き始められません`);
  }

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      files: { 'src/tax.ts': TAX },
      conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: REPLY }]] }],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`press-chat-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('ファイルをエディタで開く', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', REPLY).waitFor();
    await app.page.keyboard.press('ControlOrMeta+P');
    await app.page.fill('.quick-open input', 'tax');
    await app.byText('.quick-open-list .quick-open-name', 'tax.ts').waitFor();
    await app.page.keyboard.press('Enter');
    await app.page.locator('.editor .editor-monaco .view-line', { hasText: 'TAX_RATE = 0.1' }).first().waitFor();
  });

  it('書きかけのコメントは、Esc でやめると何も付けずに欄を閉じる', async () => {
    await startComment('TAX_RATE = 0.1');
    await draft().fill(COMMENT);
    await draft().press('Escape');
    await draft().waitFor({ state: 'detached' });
    expect(await added().count()).toBe(0);
    expect(await chip().count()).toBe(0);
  });

  it('⌘Enter で、書いたコメントをその行に付け、チャットの入力欄にも札を出す。空のままでは付けない', async () => {
    await startComment('TAX_RATE = 0.1');
    await draft().press('ControlOrMeta+Enter');
    // 空なので、欄は開いたまま
    await app.page.waitForTimeout(300);
    expect(await draft().count()).toBe(1);
    await draft().fill(COMMENT);
    await draft().press('ControlOrMeta+Enter');
    await draft().waitFor({ state: 'detached' });
    await added().waitFor();
    expect(await added().locator('.comment-lines').innerText()).toBe('1 行目');
    await chip().waitFor();
    expect(await chip().locator('.comment-chip-where').innerText()).toBe('tax.ts:1');
  });

  it('付けたコメントの「削除」で、エディタの欄とチャットの入力欄の札から消す', async () => {
    await added().locator('[aria-label="削除"]').click();
    await added().waitFor({ state: 'detached' });
    await chip().waitFor({ state: 'detached' });
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
