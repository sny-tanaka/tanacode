import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { finalCommentBody } from '@shared/walkthrough-comment';
import { walkthroughToolId } from '@shared/walkthrough-tools';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// Claude に頼むと、ウォークスルーを GitHub の PR にコメントとして載せる（post_walkthrough）。GitHub には書かず、偽の gh が受け取る。
// - 載せる前に、許可の確認が出る（GitHub に書き込むので、許可済みにしない）
// - 答えると載せ、コメントの URL が Claude に戻る
// - 載せた本文は、ボタンで開く下見の本文に、一言を添えたもの。下見には、もう載せたことが出る

const ASK = 'ウォークスルーを PR に載せてください';
const DONE = 'PR に載せました';
const TITLE = '税の計算';
const PR = 'https://github.com/me/cafe/pull/12';
// 偽の gh。開いている PR が 1 つあり、最新のコミットは手元の HEAD。コメントの本文は ~/gh-comment.md に書く
const GH = [
  '#!/bin/sh',
  'case "$1 $2" in',
  `  "pr list") printf '[{"number":12,"state":"OPEN","headRefOid":"%s","baseRefName":"main","url":"${PR}"}]\\n' "$(git rev-parse HEAD)" ;;`,
  `  "pr comment") cat > "$HOME/gh-comment.md" && echo "${PR}#issuecomment-1" ;;`,
  '  *) exit 1 ;;',
  'esac',
  '',
].join('\n');

const tool = (id: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id, name, input }];

describe('Claude がウォークスルーを PR に載せる', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      git: true,
      files: { 'src/tax.ts': 'export const TAX_RATE = 0.1;\n\nexport function withTax(price: number): number {\n  return Math.floor(price * (1 + TAX_RATE));\n}\n' },
      commands: { gh: GH },
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
            tool('toolu_post', walkthroughToolId('post_walkthrough'), {}),
            [{ type: 'text', text: DONE }],
          ],
        },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`walkthrough-post-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('載せる前に許可の確認が出る', async () => {
    await app.startSession(ASK, { mode: 'manual' });
    const card = await app.menuCard('permission');
    expect(await card.textContent()).toContain('tanacode-walkthrough — PR に載せる');
    await app.choose(card, /^許可する/);
  });

  it('答えると載せ、コメントの URL が Claude に戻る', async () => {
    await app.byText('.chat-list', DONE).waitFor();
    expect(app.api.toolResults).toContain(`Posted the walkthrough "${TITLE}" (2 steps) to PR #12 as a comment: ${PR}#issuecomment-1`);
  });

  it('載せた本文は、ボタンで開く下見の本文に一言を添えたもの。下見には、もう載せたことが出る', async () => {
    await app.page.click('.walk-box [aria-label="GitHub の PR にコメントとして載せる"]');
    const dialog = app.page.locator('.walk-comment-dialog');
    await app.byText('.walk-comment-dialog .walk-comment-note.warn', 'もう載せています').waitFor();
    const body = await dialog.locator('textarea.walk-comment-body').inputValue();
    expect(body).toContain(`## ウォークスルー: ${TITLE}`);
    expect(readFileSync(join(app.home, 'gh-comment.md'), 'utf8')).toBe(finalCommentBody(body, true));
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
