import type { AskQuestion } from '@shared/screen';

// AskUserQuestion の質問の台本。本物の claude で要求に答える確認（test/cli/cards.test.ts）と、待っている質問の単体の確認
// （test/pending-questions.test.ts）で共有する

// 複数の質問（単一選択・複数選択・単一選択）
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
// 複数選択の自由記述と、3 つめの質問の自由記述に書く文
export const TYPED_LANGUAGE = 'Zig';
export const TYPED_COLOR = '目に優しい緑';
// 選んだ答え（会話ログの answers）。複数選択は選択肢の順に「, 」でつながり、自由記述は最後に付く
export const TABS_ANSWERS = ['だ・である', `TypeScript, Go, ${TYPED_LANGUAGE}`, TYPED_COLOR];

// プレビュー付きの選択肢。名前は長くする（日本語と英語）
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
