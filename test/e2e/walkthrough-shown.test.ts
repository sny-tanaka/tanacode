import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { walkthroughToolId } from '@shared/walkthrough-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude がウォークスルーで示した場所を、画面がどう扱ったかが、ツールの結果で Claude に戻る。
// - 始めると、エディタに 1 つ目のステップを開き、開いたことが戻る
// - 人が自分で別のファイルを開いているときは、示しても（show_code）エディタは動かさずに帯だけを出し、動かさなかったことが戻る。
//   walkthrough_status も、人が別のファイルを見ていると返す（直す前は、どちらも「示した」「見ている」と返していた）

const ASK = 'ウォークスルーしてください';
const SHOW = '呼び出し元も見せてください';
const TITLE = '税の計算';

const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name, input }];

describe('ウォークスルーで示した場所を、画面がどう扱ったかが Claude に戻る', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      files: {
        'src/tax.ts': 'export const TAX_RATE = 0.1;\n\nexport function withTax(price: number): number {\n  return Math.floor(price * (1 + TAX_RATE));\n}\n',
        // フォルダの開き閉じに左右されないよう、いちばん上に置く
        'other.ts': 'export const other = 1;\n',
      },
      conversations: () => [
        {
          match: ASK,
          steps: [
            tool('toolu_walk', walkthroughToolId('start_walkthrough'), {
              title: TITLE,
              steps: [
                { path: 'src/tax.ts', start_line: 1, title: '税率を決める', body: '税率は 10% で固定にしました。' },
                { path: 'src/tax.ts', start_line: 3, end_line: 5, title: '税込にする', body: '1 円未満は切り捨てます。' },
              ],
            }),
            [{ type: 'text', text: '1/2 から見てください' }],
            tool('toolu_show', walkthroughToolId('show_code'), { path: 'src/tax.ts', start_line: 3, end_line: 5, body: 'ここから呼びます。' }),
            tool('toolu_status', walkthroughToolId('walkthrough_status'), {}),
            [{ type: 'text', text: '示しました' }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`walkthrough-shown-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('始めると 1 つ目のステップをエディタに開き、開いたことが Claude に戻る', async () => {
    await app.startSession(ASK);
    await app.byText('.chat-list', '1/2 から見てください').waitFor();
    await app.byText('.editor-tab.active', 'tax.ts').waitFor();
    expect(app.api.toolResults.find((r) => r.startsWith(`Started the walkthrough "${TITLE}"`))).toContain(`Opened 1/2 "税率を決める" (src/tax.ts:1) in the user's tanacode editor.`);
  });

  it('人が別のファイルを開いていれば、示してもエディタは動かさずに帯を出し、動かさなかったこと・別のファイルを見ていることが Claude に戻る', async () => {
    await app.page.click('.activity-bar [aria-label^="エクスプローラー"]');
    await app.page.click('.tree-row[title="other.ts"]');
    await app.byText('.editor-tab.active', 'other.ts').waitFor();
    await app.page.locator('.walk-band').waitFor();
    await app.send(SHOW);
    await app.byText('.chat-list', '示しました').waitFor();
    expect(app.api.toolResults).toContain(
      `Did not move the user's editor to src/tax.ts:3-5: the user has opened another file or view in this session. A band above the editor tells them that you are showing src/tax.ts:3-5, with "Claude が示している場所へ戻る" to open it. Mention the location in your reply so that the user can find it. When the user clicks "ウォークスルーに戻る（1/2）", the editor returns to 1/2.`,
    );
    expect(app.api.toolResults.find((r) => r.startsWith(`Walkthrough "${TITLE}"`))).toContain(
      'The user has opened another file or view in the editor instead (a band above the editor offers to go back). The walkthrough is at src/tax.ts:3-5, which you showed as an aside (going back returns to 1/2).',
    );
    // エディタは、人が開いたファイルのまま。帯から、示した場所を開ける
    expect(await app.page.locator('.editor-tab.active').textContent()).toContain('other.ts');
    await app.byText('.walk-band', '寄り道 · src/tax.ts:3-5').waitFor();
    await app.page.click('.walk-band button:has-text("Claude が示している場所へ戻る")');
    await app.byText('.editor-tab.active', 'tax.ts').waitFor();
  });
});
