import { expect } from 'vitest';
import type { AskQuestion, Menu } from '@shared/screen';
import type { Step } from '../cli/mock-api';

// AskUserQuestion の質問の台本と、アプリが読み取れるべきもの。
// 本物の claude を動かす確認（test/cli/questions.test.ts）と、そのとき取った控えを読む確認で共有する。
// 控えの画面は parseMenu で読み、下の質問（ASK_*）を applyQuestions に渡してから checkXxx にかける（見えた状態の記憶は空のまま）。
// 台本: 発言ごとに AskUserQuestion を 1 回呼び、答えが返ったら文章で返事する
// 1. 3 つの質問（単一選択・複数選択・単一選択）。タブ・ページ送り・チェックの付け外し・自由記述・回答の確認画面
// 2. 複数選択だけの質問。最後の質問なので、確定の行は Submit
// 3. プレビュー付きの選択肢（選択肢の右にプレビューの枠が並ぶ形）。質問文は長く、縦線の枠で折り返す
// 4. 説明の長い選択肢。メニューが画面より高く、上が切れて質問文と 1 つめの選択肢が見えない

export const PROMPT = '質問の確認を始めてください';
// 2 つめからの発言（どれも同じ台本の続き）
export const NEXT_PROMPTS = ['複数選択の質問をしてください', 'プレビュー付きの質問をしてください', '説明の長い質問をしてください'];

// 1. 複数の質問
export const ASK_TABS: AskQuestion[] = [
  {
    question: '文章はどちらの書き方にしますか？',
    header: '書き方',
    multiSelect: false,
    options: [
      { label: 'です・ます', description: '丁寧な書き方' },
      { label: 'だ・である', description: '言い切る書き方' },
    ],
  },
  {
    question: 'どの言語を使いますか？（いくつでも）',
    header: '言語',
    multiSelect: true,
    options: [
      { label: 'TypeScript', description: '型の付いた JavaScript' },
      { label: 'Rust', description: '速くて安全' },
      { label: 'Go', description: '簡潔' },
    ],
  },
  {
    question: '画面の色はどうしますか？',
    header: '色',
    multiSelect: false,
    options: [
      { label: '明るい色', description: '白の背景' },
      { label: '暗い色', description: '黒の背景' },
    ],
  },
];
// 複数選択の自由記述と、3 つめの質問の自由記述に打つ文
export const TYPED_LANGUAGE = 'Zig';
export const TYPED_COLOR = '目に優しい緑';
// 選んだ答え（会話ログの answers）。複数選択は選択肢の順に「, 」でつながり、自由記述は最後に付く
export const TABS_ANSWERS = ['だ・である', `TypeScript, Go, ${TYPED_LANGUAGE}`, TYPED_COLOR];

// 2. 複数選択だけの質問
export const ASK_MULTI: AskQuestion[] = [
  {
    question: 'どの確認を入れますか？',
    header: '確認',
    multiSelect: true,
    options: [
      { label: '型チェック', description: 'tsc で確かめる' },
      { label: '単体テスト', description: 'vitest で確かめる' },
      { label: 'リンター', description: 'eslint で確かめる' },
    ],
  },
];
export const MULTI_ANSWERS = ['型チェック, リンター'];

// 3. プレビュー付きの選択肢。名前は左の列の幅で折り返されるくらい長くする（日本語と英語）
export const ASK_PREVIEW: AskQuestion[] = [
  {
    question: `${'画面の部品の並べ方を決めるための、少し長めの質問文です。'.repeat(3)}どの並べ方にしますか？`,
    header: '並べ方',
    multiSelect: false,
    options: [
      { label: '縦に並べて、上から順に読めるようにする並べ方', description: '上から下へ', preview: '┌────────┐\n│ 部品 A │\n├────────┤\n│ 部品 B │\n└────────┘' },
      { label: 'Side by side with a long English label', description: '左から右へ', preview: '┌────────┬────────┐\n│ 部品 A │ 部品 B │\n└────────┴────────┘' },
      { label: 'プレビュー無し', description: 'プレビューの無い選択肢' },
    ],
  },
];
export const PREVIEW_ANSWERS = ['Side by side with a long English label'];

// 4. 説明の長い選択肢（端末は 120×40）。メニューの高さが画面を超え、上が切れる
export const ASK_TALL: AskQuestion[] = [
  {
    question: 'どの進め方にしますか？',
    header: '進め方',
    multiSelect: false,
    options: Array.from({ length: 4 }, (_, i) => ({
      label: `進め方${i + 1}`,
      description: `進め方${i + 1}の説明です。`.repeat(60),
    })),
  },
];
export const TALL_ANSWERS = ['進め方4'];

const ask = (id: string, questions: AskQuestion[]): Step => [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }];

// モックの API が返す応答。質問に答えたら、次の発言まで文章で返事して待つ
export const STEPS: Step[] = [
  ask('toolu_ask_tabs', ASK_TABS),
  [{ type: 'text', text: '複数の質問の答えを受け取りました' }],
  ask('toolu_ask_multi', ASK_MULTI),
  [{ type: 'text', text: '複数選択の答えを受け取りました' }],
  ask('toolu_ask_preview', ASK_PREVIEW),
  [{ type: 'text', text: 'プレビュー付きの答えを受け取りました' }],
  ask('toolu_ask_tall', ASK_TALL),
  [{ type: 'text', text: '説明の長い質問の答えを受け取りました' }],
];

// 質問のメニューの選択肢（applyQuestions で組み立てたもの）が、質問の選択肢・自由記述・Chat about this の順に並ぶ
function checkOptions(menu: Menu, q: AskQuestion, previewLayout = false): void {
  const choices = menu.options.filter((o) => /^\d+$/.test(o.id) && Number(o.id) <= q.options.length);
  expect(choices.map((o) => ({ id: o.id, label: o.label, description: o.description }))).toEqual(
    q.options.map((o, i) => ({ id: String(i + 1), label: o.label, description: o.description })),
  );
  const text = menu.options.filter((o) => o.textInput);
  // プレビューが並ぶ形には自由記述が無い
  expect(text.map((o) => o.id)).toEqual(previewLayout ? [] : [String(q.options.length + 1)]);
  expect(menu.options.filter((o) => o.id === 'submit')).toHaveLength(q.multiSelect ? 1 : 0);
  if (!previewLayout) expect(menu.options[menu.options.length - 1]).toMatchObject({ id: String(q.options.length + 2), label: 'Chat about this' });
  expect(menu.multiSelect).toBe(q.multiSelect);
  expect(menu.options.filter((o) => o.pointed)).toHaveLength(1);
}

function checkTabs(menu: Menu, answered: boolean[]): void {
  expect(menu.tabs).toEqual(ASK_TABS.map((q, i) => ({ label: q.header, answered: answered[i] })));
}

// 1 問目のページ（まだどれにも答えていない）
export function checkTabsFirst(menu: Menu | null): void {
  expect(menu?.kind).toBe('question');
  checkTabs(menu!, [false, false, false]);
  expect(menu!.title).toBe(ASK_TABS[0].question);
  expect(menu!.context).toEqual([]);
  checkOptions(menu!, ASK_TABS[0]);
  expect(menu!.options[0].pointed).toBe(true);
}

// 2 問目のページ（複数選択）。TypeScript と Go にチェックを付け、自由記述に打ったところ。
// 途中の質問なので、確定の行は Next
export function checkTabsMulti(menu: Menu | null): void {
  expect(menu?.kind).toBe('question');
  checkTabs(menu!, [true, true, false]);
  expect(menu!.title).toBe(ASK_TABS[1].question);
  checkOptions(menu!, ASK_TABS[1]);
  expect(menu!.options.map((o) => o.checked)).toEqual([true, false, true, true, null, null]);
  expect(menu!.options.find((o) => o.textInput)?.label).toBe(TYPED_LANGUAGE);
  expect(menu!.options.find((o) => o.id === 'submit')?.label).toBe('Next');
}

// 3 問目のページ（単一選択。自由記述はまだ空）
export function checkTabsLast(menu: Menu | null): void {
  expect(menu?.kind).toBe('question');
  checkTabs(menu!, [true, true, false]);
  expect(menu!.title).toBe(ASK_TABS[2].question);
  checkOptions(menu!, ASK_TABS[2]);
  expect(menu!.options.find((o) => o.textInput)?.label).toMatch(/^Type something\.?$/);
}

// 回答の確認画面。質問と答えが上から順に補足に並び、問いかけが見出しになる
export function checkReview(menu: Menu | null, questions: AskQuestion[], answers: string[]): void {
  expect(menu?.kind).toBe('question');
  expect(menu!.title).toMatch(/submit/i);
  const context = menu!.context.join('\n');
  expect(context).toContain('Review your answers');
  let at = -1;
  questions.forEach((q, i) => {
    const question = context.indexOf(q.question, at + 1);
    expect(question, q.question).toBeGreaterThan(at);
    const answer = context.indexOf(answers[i], question + q.question.length);
    expect(answer, answers[i]).toBeGreaterThan(question);
    at = answer;
  });
  expect(menu!.options.map((o) => o.label)).toEqual(['Submit answers', 'Cancel']);
  expect(menu!.options[0].pointed).toBe(true);
}

export function checkTabsReview(menu: Menu | null): void {
  checkReview(menu, ASK_TABS, TABS_ANSWERS);
  checkTabs(menu!, [true, true, true]);
}

// 複数選択だけの質問。型チェックとリンターにチェックを付けたところ。最後の質問なので、確定の行は Submit
export function checkMulti(menu: Menu | null): void {
  expect(menu?.kind).toBe('question');
  expect(menu!.tabs).toEqual([{ label: ASK_MULTI[0].header, answered: true }]);
  expect(menu!.title).toBe(ASK_MULTI[0].question);
  checkOptions(menu!, ASK_MULTI[0]);
  expect(menu!.options.map((o) => o.checked)).toEqual([true, false, true, false, null, null]);
  expect(menu!.options.find((o) => o.id === 'submit')?.label).toBe('Submit');
}

export function checkMultiReview(menu: Menu | null): void {
  checkReview(menu, ASK_MULTI, MULTI_ANSWERS);
}

// プレビュー付きの選択肢。長い質問文は縦線の枠から 1 つの文につなぎ直す
export function checkPreview(menu: Menu | null): void {
  expect(menu?.kind).toBe('question');
  expect(menu!.previewLayout).toBe(true);
  expect(menu!.tabs).toEqual([{ label: ASK_PREVIEW[0].header, answered: false }]);
  expect(menu!.title).toBe(ASK_PREVIEW[0].question);
  checkOptions(menu!, ASK_PREVIEW[0], true);
  expect(menu!.options.map((o) => o.preview)).toEqual(ASK_PREVIEW[0].options.map((o) => o.preview));
  expect(menu!.options[0].pointed).toBe(true);
}

// 説明の長い選択肢。画面には質問文も 1 つめの選択肢も出ていないが、カードには全部の選択肢が出る。
// pointed: カーソルのある選択肢。はじめは見えていない 1 つめ（question-tall）。
// カーソルを 3 つめに送ると、画面の質問文の代わりに上の選択肢の説明の切れ端が見える（question-tall-moved）
export function checkTall(menu: Menu | null, pointed = '1'): void {
  expect(menu?.kind).toBe('question');
  expect(menu!.title).toBe(ASK_TALL[0].question);
  expect(menu!.context).toEqual([]);
  checkOptions(menu!, ASK_TALL[0]);
  expect(menu!.options.find((o) => o.pointed)?.id).toBe(pointed);
}
