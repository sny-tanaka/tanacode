import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// カードの選択肢を押して離す間に、チャットの一覧の中身が動いても（上の行が縮む・下に行が増えて最下部を追いかける）、
// 離したクリックが選択肢に届くか。画面の部品のテスト（jsdom）には本物の配置が無いので、本物の画面で確かめる。
// 直す前: 押した選択肢が動いて、離した所が選択肢から外れ、click が選択肢に届かなかった（人が押しても効かない。
// CI の browser-outside では、Playwright の click が成功で返ったまま、許可のカードが閉じずに止まった）。
// 一覧がスクロールしない大きさ（手元の Mac）では上の行の縮みで、最下部に張り付く大きさ（CI の Mac）では下の行への追いかけで動くので、両方を起こす

const PROMPT = '確かめのコマンドを動かしてください';
const DONE = 'コマンドを動かしました';
const bash = (id: string, command: string): Block[] => [{ type: 'tool_use', id, name: 'Bash', input: { command, description: '確かめのコマンド' } }];

describe('カードの選択肢を押している間に、チャットの一覧の中身が動く', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [{ match: PROMPT, steps: [bash('toolu_mkdir', 'mkdir pressed && echo pressed-$((40+2))'), [{ type: 'text', text: DONE }]] }],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`press-card-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('押してから離すまでに、上の行が縮み、下に行が増えても、離したクリックが「許可する」に届き、コマンドが動く', async () => {
    await app.startSession(PROMPT, { mode: 'manual' });
    const card = await app.menuCard('permission');
    // 縮める行を、一覧の頭に置いておく
    await app.page.evaluate(() => {
      const row = document.createElement('div');
      row.className = 'e2e-shrinking-row';
      // 一覧は縦に並べる flex で、中身の無い行は縮められるので、縮まないようにする
      row.style.flex = 'none';
      row.style.height = '60px';
      document.querySelector('.chat-list')?.prepend(row);
    });
    const press = await app.pressHolding(card.locator('.menu-option', { hasText: /^許可する/ }).first(), async () => {
      await app.page.evaluate(() => {
        const list = document.querySelector('.chat-list');
        const shrinking = list?.querySelector<HTMLElement>('.e2e-shrinking-row');
        if (shrinking) shrinking.style.height = '0px';
        const added = document.createElement('div');
        added.className = 'e2e-added-row';
        added.style.flex = 'none';
        added.style.height = '60px';
        list?.append(added);
      });
      // 押したまま、変わった中身を一度描かせる（大きさの変化の知らせと、最下部への追いかけは、次に描く前に動く）
      await app.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    });
    expect(press.reached, press.lines.join('\n')).toBe(true);
    await app.byText('.chat-list', DONE).waitFor();
    expect(app.api.toolResults.some((r) => r.includes('pressed-42'))).toBe(true);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
