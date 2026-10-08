import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents } from '@shared/chat';
import type { AskQuestion, Menu, MenuOption, ScreenInfo } from '@shared/screen';
import {
  ASK_MULTI,
  ASK_PREVIEW,
  ASK_TABS,
  ASK_TALL,
  MULTI_ANSWERS,
  NEXT_PROMPTS,
  PREVIEW_ANSWERS,
  PROMPT,
  STEPS,
  TABS_ANSWERS,
  TALL_ANSWERS,
  TYPED_COLOR,
  TYPED_LANGUAGE,
  checkMulti,
  checkMultiReview,
  checkPreview,
  checkTabsFirst,
  checkTabsLast,
  checkTabsMulti,
  checkTabsReview,
  checkTall,
} from '../scenarios/questions';
import { ClaudeRun, claudeVersion, menuOf } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、AskUserQuestion の質問をアプリと同じ読み取りで読めるか、
// アプリのカードのボタンと同じ操作（ScreenTracker の choose）で答えられるかを確かめる。
// 台本は test/scenarios/questions.ts（複数の質問・複数選択・プレビュー付き・説明の長い選択肢）

const version = claudeVersion();

describe(`Claude Code ${version} の AskUserQuestion`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const events = () => run.entries.flatMap((e) => toChatEvents(e, run.cwd));
  const menu = () => menuOf('question')(run.screen.current);

  // 質問文が title の質問のメニュー（check があれば、それも満たすもの）
  const titled =
    (title: string, check: (menu: Menu) => boolean = () => true) =>
    (info: ScreenInfo): Menu | null => {
      const shown = menuOf('question')(info);
      return shown && shown.title === title && check(shown) ? shown : null;
    };
  const question = (label: string, title: string, check?: (menu: Menu) => boolean) => run.waitFor(label, titled(title, check));

  // 回答の確認画面
  const review = (info: ScreenInfo): Menu | null => {
    const shown = menuOf('question')(info);
    return shown?.context.includes('Review your answers') ? shown : null;
  };

  const option = (m: Menu, id: string): MenuOption | undefined => m.options.find((o) => o.id === id);

  // 会話ログに書かれた答え（toChatEvents の tool-result の answers）
  const answered = (toolUseId: string) => () => {
    const result = events().find((e) => e.type === 'tool-result' && e.id === toolUseId);
    return result?.type === 'tool-result' ? result.answers : undefined;
  };

  // アプリのカードのボタンと同じ操作（ScreenTracker の choose）で選び、check が満たされるまで待つ。
  // 出たばかりの質問に Claude Code が入力を捨てる間を待つのは choose。カードに「受け付けませんでした」と出たときだけ、
  // 人と同じく押し直す（ClaudeRun.press）
  const choose = async <T>(label: string, [id, key, text]: Parameters<ClaudeRun['screen']['choose']>, check: (info: ScreenInfo) => T | null | undefined | false) => {
    await run.press(label, { optionId: id, key, text }, (c) => run.screen.choose(c.optionId, c.key, c.text));
    return run.waitFor(label, check);
  };

  // 複数選択のチェックを付け外し（space）して、画面のチェックが変わるまで待つ
  const toggle = (title: string, id: string, checked: boolean) =>
    choose(`選択肢 ${id} のチェック`, [id, 'space'], titled(title, (m) => option(m, id)?.checked === checked));

  const expected = (questions: AskQuestion[], answers: string[]) =>
    questions.map((q, i) => ({ header: q.header, question: q.question, answer: answers[i] }));

  // 答えたあとの返事が書かれ、入力欄に戻るまで待ってから、次の発言を送る
  const next = async (reply: string, prompt: string) => {
    await run.waitFor('返事', () => events().some((e) => e.type === 'assistant-text' && e.text === reply));
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    await run.send(prompt);
  };

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [{ match: PROMPT, steps: STEPS }];
    run = new ClaudeRun(await api.start());
    await run.open();
  });

  afterAll(async () => {
    if (process.env.TANACODE_RECORD) run?.recordScreens(join('test', 'fixtures', 'claude-code', version));
    try {
      run?.stop();
    } catch (error) {
      // 止めた直後の claude が、まだ使い捨てのフォルダに書いていて消せないことがある。少し待ちながら消し直す
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
      rmSync(run.root, { recursive: true, force: true, maxRetries: 10 });
    }
    await api?.stop();
  });

  it('複数の質問を、タブを読みながら 1 問ずつ答え、回答の確認画面で送れる', async () => {
    await run.send(PROMPT);
    checkTabsFirst(await question('1 問目', ASK_TABS[0].question));
    run.capture('question-tabs-first');

    // 1 問目（単一選択）に答えると、2 問目のページに進む
    await choose('2 問目', ['2', 'enter'], titled(ASK_TABS[1].question));

    // 2 問目（複数選択）。チェックを付けて外し、自由記述に打つと、打った答えにもチェックが付く
    await toggle(ASK_TABS[1].question, '1', true);
    await toggle(ASK_TABS[1].question, '2', true);
    await toggle(ASK_TABS[1].question, '2', false);
    await toggle(ASK_TABS[1].question, '3', true);
    await choose(
      '自由記述',
      ['4', 'none', TYPED_LANGUAGE],
      titled(ASK_TABS[1].question, (m) => option(m, '4')?.label === TYPED_LANGUAGE && option(m, '4')?.checked === true),
    );
    run.capture('question-tabs-multi');
    checkTabsMulti(menu());

    // Next で 3 問目へ
    checkTabsLast(await choose('3 問目', ['submit', 'enter'], titled(ASK_TABS[2].question)));
    run.capture('question-tabs-last');

    // 3 問目は自由記述で答える（打って Enter）。最後の質問なので、回答の確認画面に進む
    checkTabsReview(await choose('回答の確認画面', ['3', 'enter', TYPED_COLOR], review));
    run.capture('question-tabs-review');

    expect(await choose('答え', ['1', 'enter'], answered('toolu_ask_tabs'))).toEqual(expected(ASK_TABS, TABS_ANSWERS));
  });

  it('複数選択だけの質問で、チェックを付けて Submit できる', async () => {
    await next('複数の質問の答えを受け取りました', NEXT_PROMPTS[0]);
    const title = ASK_MULTI[0].question;
    await question('複数選択の質問', title);
    await toggle(title, '1', true);
    await toggle(title, '3', true);
    run.capture('question-multi');
    checkMulti(menu());

    checkMultiReview(await choose('回答の確認画面', ['submit', 'enter'], review));
    run.capture('question-multi-review');

    expect(await choose('答え', ['1', 'enter'], answered('toolu_ask_multi'))).toEqual(expected(ASK_MULTI, MULTI_ANSWERS));
  });

  it('プレビュー付きの選択肢が読め、選べる', async () => {
    await next('複数選択の答えを受け取りました', NEXT_PROMPTS[1]);
    checkPreview(await question('プレビュー付きの質問', ASK_PREVIEW[0].question));
    run.capture('question-preview');

    expect(await choose('答え', ['2', 'enter'], answered('toolu_ask_preview'))).toEqual(expected(ASK_PREVIEW, PREVIEW_ANSWERS));
  });

  it('メニューが画面より高く上が切れても、全部の選択肢が出て、選べる', async () => {
    await next('プレビュー付きの答えを受け取りました', NEXT_PROMPTS[2]);
    checkTall(await question('説明の長い質問', ASK_TALL[0].question));
    run.capture('question-tall');

    // 見えていない 1 つめの選択肢から、カーソルを送る
    checkTall(await choose('カーソルを送ったあと', ['3', 'none'], titled(ASK_TALL[0].question, (m) => option(m, '3')?.pointed === true)), '3');
    run.capture('question-tall-moved');

    expect(await choose('答え', ['4', 'enter'], answered('toolu_ask_tall'))).toEqual(expected(ASK_TALL, TALL_ANSWERS));
  });
});
