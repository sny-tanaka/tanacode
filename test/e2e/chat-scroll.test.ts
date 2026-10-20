import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '../cli/mock-api';
import { E2EApp } from './app';

// チャットの一覧のスクロール。一覧は最下部に張り付いて新しい行を追いかけ、人の操作でない上へのスクロールは最下部へ送り直す（ClaudePane）。
// Tab でフォーカスを移したときにブラウザが動かすスクロールと、その知らせの順（focusin より先に一覧が動く）は、画面の部品のテスト（jsdom）に
// 無いので、本物の画面で確かめる。
// 直す前: Tab（Shift+Tab）で上の見えていない要素へフォーカスを移すと、ブラウザは一覧を上へ送って見せたが、一覧がそれを最下部へ送り直し、
// フォーカスした要素が見えなくなった。
// 「最新のメッセージへ」のボタンと、カードの選択肢の重なりも、本物の配置とホイールのスクロールで確かめる

const PROMPT = 'あいさつしてください';
const DONE = 'こんにちは';
const CARD_PROMPT = '確かめのコマンドを動かしてください';
const CARD_DONE = 'コマンドを動かしました';
// 許可を聞くコマンド（echo だけなら、聞かずに動く）
const bash: Block[] = [{ type: 'tool_use', id: 'toolu_scroll', name: 'Bash', input: { command: 'mkdir scrolled && echo scrolled-$((40+2))', description: '確かめのコマンド' } }];

describe('チャットの一覧のスクロール', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: PROMPT, steps: [[{ type: 'text', text: DONE }]] },
        { match: CARD_PROMPT, steps: [bash, [{ type: 'text', text: CARD_DONE }]] },
      ],
    });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await app?.keepEvidence(`chat-scroll-${task.name}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  // 次に描き終えるまで待つ（スクロールの知らせと、それを受けた一覧の送り直しは、次に描くときに動く）
  const nextFrames = () => app.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  it('最下部に張り付いているとき、Shift+Tab で上の見えていない要素へフォーカスを移すと、その要素が見えたままになり、「最新のメッセージへ」が出る', async () => {
    await app.startSession(PROMPT);
    await app.byText('.chat-list', DONE).waitFor();
    // 一覧の頭に、フォーカスを移す先のボタンと、一覧をスクロールさせる背の高い行を置き、その下に、フォーカスを置いておくボタンを置く
    await app.page.evaluate(() => {
      const list = document.querySelector('.chat-list');
      const button = (className: string) => {
        const element = document.createElement('button');
        element.className = className;
        element.textContent = className;
        element.style.flex = 'none';
        return element;
      };
      const filler = document.createElement('div');
      filler.style.flex = 'none';
      filler.style.height = '1500px';
      list?.prepend(button('e2e-focus-target'), filler, button('e2e-focus-start'));
    });
    await nextFrames();
    const state = () =>
      app.page.evaluate(() => {
        const list = document.querySelector('.chat-list');
        const target = document.querySelector('.e2e-focus-target');
        const box = list?.getBoundingClientRect();
        const rect = target?.getBoundingClientRect();
        return {
          focused: document.activeElement?.className ?? '',
          visible: !!box && !!rect && rect.top >= box.top && rect.bottom <= box.bottom,
          scroll: list ? `${Math.round(list.scrollTop)}/${list.scrollHeight}/${list.clientHeight}` : '-',
        };
      });
    // 一覧は最下部に張り付いていて、上のボタンは見えていない。下のボタンに、一覧を動かさずにフォーカスを置く
    expect(await state()).toMatchObject({ visible: false });
    await app.page.evaluate(() => document.querySelector<HTMLElement>('.e2e-focus-start')?.focus({ preventScroll: true }));
    await app.page.keyboard.press('Shift+Tab');
    await nextFrames();
    expect(await state()).toMatchObject({ focused: 'e2e-focus-target', visible: true });
    await app.page.getByRole('button', { name: '最新のメッセージへ' }).waitFor();
  });

  // 直す前: 少し上へスクロールして、カードの選択肢が一覧の下端に来ると、その上に「最新のメッセージへ」が重なった
  // （選択肢を押したつもりが、ボタンを押してしまう）。
  // CI で一度落ちた（gap が 0）: 許可のカードは stream から、ツールの行は会話ログからあとで届く。ホイールで動いた位置の知らせ（scroll）が
  // 届く前にツールの行が届くと、一覧がまだ最下部を追いかけているつもりで、最下部へ送り直していた（アプリの不具合。ClaudePane の toBottom で直した。
  // 決まった順で起こす確かめは test/renderer/press-chat-pane.test.tsx）
  it('許可の確認のカードが見えている間は、少し上へスクロールしても「最新のメッセージへ」を出さず、カードが見えなくなるまで上へ送ると出す', async () => {
    await app.startSession(CARD_PROMPT, { mode: 'manual' });
    const card = await app.menuCard('permission');
    // 一覧をスクロールさせる背の高い行を、一覧の頭に置く
    await app.page.evaluate(() => {
      const filler = document.createElement('div');
      filler.style.flex = 'none';
      filler.style.height = '1500px';
      document.querySelector('.chat-list')?.prepend(filler);
    });
    await nextFrames();
    const jump = app.page.getByRole('button', { name: '最新のメッセージへ' });
    // 最下部からの距離（gap）と、カードの上端が一覧の下端よりどれだけ上にあるか（cardShown。正なら見えている）。スクロールが止まるまで
    // 待って読む。落ちたときに読めるよう、一覧の位置と大きさ・カードの位置（一覧の上端から）・行の数・ボタンが出ているかも添える
    const settled = async () => {
      let last = '';
      for (let i = 0; i < 100; i++) {
        await nextFrames();
        const now = await app.page.evaluate(() => {
          const list = document.querySelector('.chat-list')!;
          const view = list.getBoundingClientRect();
          const card = document.querySelector('.chat-list > .menu-card')!.getBoundingClientRect();
          return {
            gap: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight),
            cardShown: Math.round(view.bottom - card.top),
            scrollTop: Math.round(list.scrollTop),
            scrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight,
            card: `${Math.round(card.top - view.top)}〜${Math.round(card.bottom - view.top)}`,
            rows: list.children.length,
            jump: !!document.querySelector('.chat-jump-bottom'),
          };
        });
        if (JSON.stringify(now) === last) return now;
        last = JSON.stringify(now);
      }
      throw new Error(`一覧のスクロールが止まりません（${last}）`);
    };
    const box = (await app.page.locator('.chat-list').boundingBox())!;
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await settled();
    await app.page.mouse.wheel(0, -70);
    const near = await settled();
    const state = JSON.stringify({ before, near });
    // 最下部から離れた（ボタンを出す距離）が、カードはまだ見えている。ホイールで動かした直後に会話ログからツールの行が届いても、
    // 最下部へ戻さない（ClaudePane の toBottom）
    expect(near.gap, state).toBeGreaterThanOrEqual(40);
    expect(near.cardShown, state).toBeGreaterThan(0);
    expect(await jump.isVisible(), state).toBe(false);
    await app.page.mouse.wheel(0, -(near.cardShown + 200));
    const far = await settled();
    expect(far.cardShown, JSON.stringify(far)).toBeLessThan(0);
    await jump.waitFor();
    // ボタンで最下部へ戻ると、カードの選択肢を押せる
    await jump.click();
    await card.locator('.menu-option', { hasText: /^許可する/ }).first().click();
    await app.byText('.chat-list', CARD_DONE).waitFor();
    expect(app.api.toolResults.some((r) => r.includes('scrolled-42'))).toBe(true);
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
