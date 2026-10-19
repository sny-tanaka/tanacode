import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// カードの選択肢を押して離す間に、チャットの一覧の中身が動いても（上の行が縮む・下に行が増えて最下部を追いかける）、
// 離したクリックが選択肢に届くか。画面の部品のテスト（jsdom）には本物の配置が無いので、本物の画面で確かめる。
// 直す前: 押した選択肢が動いて、離した所が選択肢から外れ、click が選択肢に届かなかった（人が押しても効かない。
// CI の browser-outside では、Playwright の click が成功で返ったまま、許可のカードが閉じずに止まった）。
// 一覧がスクロールしない大きさ（手元の Mac）では上の行の縮みで、最下部に張り付く大きさ（CI の Mac）では下の行への追いかけで動くので、両方を起こす。
// 押し始めにカードがまだ動いているときも確かめる（テストの部品 pressHolding が、選択肢の外を押さないか）。
// 行の中が変わってから次に描くまでに離すときも確かめる（Playwright の click は、押してから離すまでが短い）

const PROMPT = '確かめのコマンドを動かしてください';
const DONE = 'コマンドを動かしました';
const MOVING_PROMPT = '出たばかりのカードを押します';
const MOVING_DONE = '出たばかりのカードで許可されました';
const NESTED_PROMPT = '行の中が変わる間に押します';
const NESTED_DONE = '行の中が変わっても許可されました';
const bash = (id: string, command: string): Block[] => [{ type: 'tool_use', id, name: 'Bash', input: { command, description: '確かめのコマンド' } }];

describe('カードの選択肢を押している間に、チャットの一覧の中身が動く', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: PROMPT, steps: [bash('toolu_mkdir', 'mkdir pressed && echo pressed-$((40+2))'), [{ type: 'text', text: DONE }]] },
        { match: MOVING_PROMPT, steps: [bash('toolu_moving', 'mkdir moving && echo moving-$((40+2))'), [{ type: 'text', text: MOVING_DONE }]] },
        { match: NESTED_PROMPT, steps: [bash('toolu_nested', 'mkdir nested && echo nested-$((40+2))'), [{ type: 'text', text: NESTED_DONE }]] },
      ],
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

  // 直す前: pressHolding の hover は、位置が止まっていないと確かめ直し、2 回目は要素をスクロールで送ってから位置を測った。
  // 一覧はその上へのスクロールを最下部へ戻すので、マウスは選択肢の下に残り、そこを押した（CI で、選択肢の 200px 下を押して落ちた）
  it('カードが出たばかりで動いている間に押し始めても、一覧が最下部に張り付く大きさで、押したクリックが「許可する」に届く', async () => {
    await app.startSession(MOVING_PROMPT, { mode: 'manual' });
    const card = await app.menuCard('permission');
    // CI の Mac と同じく、一覧を、最下部に張り付いてスクロールする大きさにする（手元の Mac の大きさでは、一覧がスクロールしない）
    await app.page.evaluate(() => {
      const filler = document.createElement('div');
      filler.className = 'e2e-filler-row';
      filler.style.flex = 'none';
      filler.style.height = '1200px';
      document.querySelector('.chat-list')?.prepend(filler);
    });
    await app.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // カードは出るときに、下から少し浮き上がる（.chat-list > * の transition）。押し始めにその終わり際が重なった形を、短い動きでそろえる
    await app.page.evaluate(() => {
      const moving = document.querySelector<HTMLElement>('.chat-list > .menu-card');
      if (!moving) return;
      moving.style.transition = 'none';
      moving.style.transform = 'translateY(4px)';
      moving.getBoundingClientRect();
      moving.style.transition = 'transform 16ms ease-out';
      moving.style.transform = '';
    });
    const press = await app.pressHolding(card.locator('.menu-option', { hasText: /^許可する/ }).first(), async () => undefined);
    expect(press.reached, press.lines.join('\n')).toBe(true);
    await app.byText('.chat-list', MOVING_DONE).waitFor();
    expect(app.api.toolResults.some((r) => r.includes('moving-42'))).toBe(true);
  });

  // 直す前: 押している間の位置は、一覧の直下の行の出入りと、大きさの変化の知らせ（次に描くときに来る）でしか戻さなかった。行の中が変わって
  // （閉じたまとまりの下の、終わったツールの行が消えるなど）から次に描くまでに離すと、ずれた所で離し、click が届かなかった
  // （CI の chat で、Playwright の click が成功で返ったまま、ツールのまとまりが開かずに止まった）
  it('押してから離すまでに行の中が変わり、次に描く前に離しても、離したクリックが「許可する」に届く', async () => {
    await app.startSession(NESTED_PROMPT, { mode: 'manual' });
    const card = await app.menuCard('permission');
    // 一覧を、最下部に張り付いてスクロールする大きさにし、カードの下に、中身のある行を置く（中身が消えると、張り付いた一覧が押し戻され、
    // 選択肢が下へずれる）
    await app.page.evaluate(() => {
      const list = document.querySelector('.chat-list');
      const filler = document.createElement('div');
      filler.style.flex = 'none';
      filler.style.height = '1200px';
      list?.prepend(filler);
      const row = document.createElement('div');
      row.style.flex = 'none';
      const inner = document.createElement('div');
      inner.className = 'e2e-leaving';
      inner.style.height = '60px';
      row.append(inner);
      list?.append(row);
    });
    await app.rendered();
    const option = card.locator('.menu-option', { hasText: /^許可する/ }).first();
    // 行の中の要素を消し、描かせずに（同じ回のうちに）選択肢の位置を測る。そのまますぐ離す
    let drift = Number.NaN;
    const press = await app.pressHolding(option, async () => {
      drift = await option.evaluate(async (element) => {
        const before = element.getBoundingClientRect().top;
        document.querySelector('.e2e-leaving')?.remove();
        await Promise.resolve();
        return element.getBoundingClientRect().top - before;
      });
    });
    expect(Math.abs(drift)).toBeLessThan(1);
    expect(press.reached, press.lines.join('\n')).toBe(true);
    await app.byText('.chat-list', NESTED_DONE).waitFor();
    expect(app.api.toolResults.some((r) => r.includes('nested-42'))).toBe(true);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
