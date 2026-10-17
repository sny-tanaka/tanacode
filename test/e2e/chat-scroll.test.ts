import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp } from './app';

// チャットの一覧のスクロール。一覧は最下部に張り付いて新しい行を追いかけ、人の操作でない上へのスクロールは最下部へ送り直す（ClaudePane）。
// Tab でフォーカスを移したときにブラウザが動かすスクロールと、その知らせの順（focusin より先に一覧が動く）は、画面の部品のテスト（jsdom）に
// 無いので、本物の画面で確かめる。
// 直す前: Tab（Shift+Tab）で上の見えていない要素へフォーカスを移すと、ブラウザは一覧を上へ送って見せたが、一覧がそれを最下部へ送り直し、
// フォーカスした要素が見えなくなった

const PROMPT = 'あいさつしてください';
const DONE = 'こんにちは';

describe('チャットの一覧のスクロール', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({ conversations: () => [{ match: PROMPT, steps: [[{ type: 'text', text: DONE }]] }] });
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

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
