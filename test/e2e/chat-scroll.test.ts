import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '../cli/mock-api';
import { ASK_PREVIEW } from '../scenarios/questions';
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
// プレビュー付きの質問（プレビューの高さが選択肢ごとに違う）
const PREVIEW_PROMPT = '並べ方を聞いてください';
const PREVIEW_DONE = '並べ方を決めました';
const askPreview: Block[] = [{ type: 'tool_use', id: 'toolu_preview', name: 'AskUserQuestion', input: { questions: ASK_PREVIEW } }];

describe('チャットの一覧のスクロール', () => {
  let app: E2EApp;

  beforeAll(async () => {
    app = await E2EApp.launch({
      trusted: true,
      conversations: () => [
        { match: PROMPT, steps: [[{ type: 'text', text: DONE }]] },
        { match: CARD_PROMPT, steps: [bash, [{ type: 'text', text: CARD_DONE }]] },
        { match: PREVIEW_PROMPT, steps: [askPreview, [{ type: 'text', text: PREVIEW_DONE }]] },
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

  // 直す前: プレビューをカードの一番下に出していたので、選択肢にマウスを乗せるとカードの高さが変わり、一覧が最下部を保とうとしてカードが
  // 上下に動いた。選択肢の上端近くに止めたマウスの下に別の選択肢が来てプレビューが替わり、また動くのを繰り返した。止めたマウスの下で
  // 要素が動いたときのホバーの出し直しは、画面の部品のテスト（jsdom）では起きないので、本物の画面で確かめる。
  // ポップアップはカードの上に出し、上に入りきらなければ下に出す。どちらに出るかはウインドウの大きさしだい（手元の Mac は 1600×960 で上、
  // CI は 1180×674 で、カードが一覧より高く下）なので、どちらの側でも確かめる。
  // CI で一度落ちた: 上に出ることを前提に確かめていた（テストの誤り）
  it('プレビュー付きの質問のカードで、選択肢の上端近くにマウスを止めても、プレビューの対象が替わり続けず、カードの高さが変わらない。プレビューはカードに重ならないポップアップに出て、マウスを移しても消えない', async () => {
    await app.startSession(PREVIEW_PROMPT);
    const card = await app.menuCard('question');
    // 一覧をスクロールさせる背の高い行を、一覧の頭に置く（一覧が最下部を保つと、カードの高さの変化がカードの位置の変化になる）
    await app.page.evaluate(() => {
      const filler = document.createElement('div');
      filler.style.flex = 'none';
      filler.style.height = '1500px';
      document.querySelector('.chat-list')?.prepend(filler);
    });
    await nextFrames();
    // プレビューを出している選択肢と、カードの高さの移り変わりを、変わるたびに記録する（1 回描くごとに替わり続けても取りこぼさない）。
    // 記録するのは変わったときだけ（ResizeObserver は見張り始めにも知らせる。裏のウインドウでは、それが届くのが遅れることがある）
    await app.page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.chat-list > .menu-card.question')!;
      const log: string[] = [];
      const entry = () => `${card.querySelector('.menu-option.previewed .menu-option-label')?.textContent ?? '-'} ${card.offsetHeight}`;
      let last = entry();
      const record = () => {
        const now = entry();
        if (now === last) return;
        log.push(now);
        last = now;
      };
      new MutationObserver(record).observe(card, { subtree: true, attributes: true, attributeFilter: ['class'] });
      new ResizeObserver(record).observe(card);
      Object.assign(window, { e2ePreviewLog: log });
    });
    const height = await card.evaluate((element) => (element as HTMLElement).offsetHeight);
    // カード・ポップアップの位置と、出しているプレビュー（落ちたときに読めるよう、文字にして添える）
    const state = () =>
      app.page.evaluate(() => {
        const box = document.querySelector('.chat-list > .menu-card.question')!.getBoundingClientRect();
        const popup = document.querySelector('.menu-preview-popup');
        const rect = popup?.getBoundingClientRect();
        const center = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          shown: popup?.querySelector('.menu-preview-label')?.textContent ?? null,
          window: `${innerWidth}×${innerHeight}`,
          card: `${Math.round(box.top)}〜${Math.round(box.bottom)}`,
          popup: rect ? `${Math.round(rect.top)}〜${Math.round(rect.bottom)} (${Math.round(rect.left)}〜${Math.round(rect.right)})` : null,
          // カードのどちら側にあるか（枠に 1px だけ重ねる。位置が端数のときの分を見込む）。overlap: カードに重なっている
          side: rect ? (rect.bottom <= box.top + 2 ? 'top' : rect.top >= box.bottom - 2 ? 'bottom' : 'overlap') : null,
          // カードの上に、ポップアップが入りきる場所がある（あれば上に出す）
          roomAbove: !!rect && box.top - 8 >= rect.height + 1,
          // ウインドウの中にあり、一覧の枠で切れず、前に出ている
          inWindow: !!rect && rect.top >= 0 && rect.bottom <= innerHeight,
          front: !!center && !!popup?.contains(center),
          log: (window as unknown as { e2ePreviewLog: string[] }).e2ePreviewLog.splice(0),
        };
      });
    // 出しているプレビューが label になるまで待つ（ポップアップの向きへ動かしたときは、止まってから切り替える。QuestionCard の REST_MS）
    const waitShown = (label: string | null) =>
      app.page
        .waitForFunction((expected) => (document.querySelector('.menu-preview-label')?.textContent ?? null) === expected, label, { timeout: 10_000 })
        .catch(async (error: unknown) => {
          throw new Error(`プレビューが「${label}」になりません（${JSON.stringify(await state())}）: ${String(error)}`);
        });
    const [first, second, none] = ASK_PREVIEW[0].options;
    for (const option of [first, second, none]) {
      const box = (await card.locator('.menu-option', { hasText: option.label }).boundingBox())!;
      await app.page.mouse.move(box.x + box.width / 2, box.y + 3);
      await waitShown(option.preview ? `プレビュー: ${option.label}` : null);
      // 替わり続けるなら、1 回描くごとに替わる。切り替わってから 10 回描く間、見張る
      for (let i = 0; i < 5; i++) await nextFrames();
      const now = await state();
      const message = JSON.stringify({ option: option.label, height, now });
      expect(now.log.every((entry) => entry.endsWith(` ${height}`)), message).toBe(true);
      expect(now.log.length, message).toBeLessThanOrEqual(1);
      if (!option.preview) continue;
      expect(now, message).toMatchObject({ shown: `プレビュー: ${option.label}`, inWindow: true, front: true });
      expect(['top', 'bottom'], message).toContain(now.side);
      if (now.roomAbove) expect(now.side, message).toBe('top');
    }
    // 選択肢から、ポップアップの側のカードの端（カードの余白。ほかの選択肢はまたがない）へ移り、そこからポップアップへ少しずつ移っても
    // 消えない（カードとポップアップの間に、外れる所が無い）。カードとポップアップの両方から外れたら消える
    const box = (await card.locator('.menu-option', { hasText: first.label }).boundingBox())!;
    const x = box.x + box.width / 2;
    await app.page.mouse.move(x, box.y + box.height / 2);
    await waitShown(`プレビュー: ${first.label}`);
    const { side } = await state();
    const edges = (await card.boundingBox())!;
    const edge = side === 'top' ? edges.y + 4 : edges.y + edges.height - 4;
    const onCard = await card.evaluate((element, [px, py]) => document.elementFromPoint(px, py) === element, [x, edge]);
    expect(onCard, JSON.stringify({ side, edge, card: edges })).toBe(true);
    await app.page.mouse.move(x, edge);
    const popup = app.page.locator('.menu-preview-popup');
    const target = (await popup.boundingBox())!;
    await app.page.mouse.move(x, target.y + target.height / 2, { steps: 10 });
    await nextFrames();
    const inside = await state();
    expect(inside, JSON.stringify(inside)).toMatchObject({ shown: `プレビュー: ${first.label}` });
    const sidebar = (await app.page.locator('nav.sidebar').boundingBox())!;
    await app.page.mouse.move(sidebar.x + sidebar.width / 2, sidebar.y + sidebar.height / 2, { steps: 5 });
    await popup.waitFor({ state: 'detached' });
    // 選んで答えられる
    await app.choose(card, none.label);
    await app.byText('.chat-list', PREVIEW_DONE).waitFor();
  });

  it('画面のコンソールにエラーが出ていない', () => {
    expect(app.consoleErrors).toEqual([]);
  });
});
