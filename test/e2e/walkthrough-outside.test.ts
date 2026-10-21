import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { walkthroughToolId } from '@shared/walkthrough-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// ウォークスルーで、セッションのフォルダの外のファイルも示せる（人と決めたこと: 制限しない。Claude はもともと、どのファイルも読める）。
// - start_walkthrough のステップに外のファイルがあっても始まり、そのステップでは、外のファイルをエディタに開いて吹き出しを出す。
//   開いている外のファイルが書き換わると、吹き出しに「Claude に示し直してもらう」を出す
// - show_code で外のファイルを示すと、エディタに開いて吹き出しを出し、示したことが Claude に戻る
// （直す前は、どちらも「フォルダの外」として断っていた）

const ASK = 'ウォークスルーしてください';
const SHOW = '外のメモの終わりも見せてください';
const TITLE = '税とメモ';
// セッションのフォルダの外のファイル（作業フォルダの隣）
const OUTSIDE = (work: string) => join(dirname(work), 'notes', 'memo.ts');
const MEMO = ['// 外のメモ', 'export const memo = 1;', 'export const note = 2;', '', 'export const last = 3;', ''].join('\n');

const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name, input }];

describe('ウォークスルーで、セッションのフォルダの外のファイルを示す', () => {
  let app: E2EApp;
  const box = () => app.page.locator('.editor .walk-box');

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      files: { 'src/tax.ts': 'export const TAX_RATE = 0.1;\n' },
      conversations: (work) => [
        {
          match: ASK,
          steps: [
            tool('toolu_walk', walkthroughToolId('start_walkthrough'), {
              title: TITLE,
              steps: [
                { path: 'src/tax.ts', start_line: 1, title: '税率を決める', body: '税率は 10% で固定にしました。' },
                { path: OUTSIDE(work), start_line: 2, end_line: 3, title: '外のメモ', body: 'フォルダの外のメモから読みます。' },
              ],
            }),
            [{ type: 'text', text: '1/2 から見てください' }],
            tool('toolu_show', walkthroughToolId('show_code'), { path: OUTSIDE(work), start_line: 5, body: 'メモの終わりです。' }),
            [{ type: 'text', text: '示しました' }],
          ],
        },
      ],
    });
    mkdirSync(dirname(OUTSIDE(app.work)), { recursive: true });
    writeFileSync(OUTSIDE(app.work), MEMO);
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`walkthrough-outside-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('外のファイルのステップがあっても始まり、そのステップでは外のファイルをエディタに開いて吹き出しを出す。書き換わると示し直しを勧める', async () => {
    await app.startSession(ASK);
    await app.byText('.chat-list', '1/2 から見てください').waitFor();
    // 始めたあと（ツールの結果が返ったあと）の時刻
    const started = Date.now();
    expect(app.api.toolResults.find((r) => r.startsWith(`Started the walkthrough "${TITLE}"`))).toContain(`Opened 1/2 "税率を決める" (src/tax.ts:1)`);
    await app.byText('.editor-tab.active', 'tax.ts').waitFor();
    await box().getByText('税率は 10% で固定にしました。').waitFor();
    await app.page.click('.walk-box [aria-label="次へ"]');
    await app.byText('.editor-tab.active', 'memo.ts').waitFor();
    await box().getByText('フォルダの外のメモから読みます。').waitFor();
    expect(await app.page.locator('.editor-tab.active').getAttribute('title')).toBe(OUTSIDE(app.work));
    // 外のファイルの変更も届く（エディタで開いている間）。示している位置がずれているかもしれない。
    // 始めて 3 秒のうちの変更は、始める前の Claude の書き込みとみなす（App の WALK_STALE_GRACE_MS）ので、過ぎてから書き換える
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 3500 - Date.now())));
    writeFileSync(OUTSIDE(app.work), `// 先頭に足した行\n${MEMO}`);
    await box().getByText('Claude に示し直してもらう').waitFor();
    // フォルダの中のステップ（相対パス）は、変わるまで勧めない。変わったら勧める
    await app.page.click('.walk-box [aria-label="戻る"]');
    await app.byText('.editor-tab.active', 'tax.ts').waitFor();
    await box().getByText('税率は 10% で固定にしました。').waitFor();
    expect(await box().getByText('Claude に示し直してもらう').count()).toBe(0);
    writeFileSync(join(app.work, 'src', 'tax.ts'), '// 先頭に足した行\nexport const TAX_RATE = 0.1;\n');
    await box().getByText('Claude に示し直してもらう').waitFor();
  });

  it('show_code で外のファイルを示すと、エディタに開いて吹き出しを出し、示したことが Claude に戻る', async () => {
    await app.send(SHOW);
    await app.byText('.chat-list', '示しました').waitFor();
    expect(app.api.toolResults).toContain(`Showed ${OUTSIDE(app.work)}:5 in the user's editor (an aside). When the user clicks "ウォークスルーに戻る（1/2）", the editor returns to 1/2.`);
    await app.byText('.editor-tab.active', 'memo.ts').waitFor();
    await box().getByText('メモの終わりです。').waitFor();
    await box().getByText(`${OUTSIDE(app.work)}:5`).waitFor();
  });
});
