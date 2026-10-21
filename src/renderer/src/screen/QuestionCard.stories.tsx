import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PendingQuestion } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';
import { mockApi } from '../../../../.storybook/mockApi';
import { QuestionCard } from './QuestionCard';

// Claude Code が答えを待っている AskUserQuestion の質問のカード（質問の入力だけで描く）。カードの形は、プレビューの有無で変わらない。
// 選択肢の下に、自由入力の欄が 1 つある（書いてから選択肢を押すと補足として一緒に送る。「入力だけで答える」で、書いた文だけを答えにする）
const pending = (...questions: AskQuestion[]): PendingQuestion => ({ id: '1', questions, answered: {} });

const handling: AskQuestion = {
  question:
    '新規指摘 D1-1（staging.yml に注記を足す案）は、どう扱いますか？ 私の判断は次 PR メモ送りです。指摘の趣旨は今回の修正で満たされており、この注記は本 PR の目的の範囲外なので、PR 本文に残すだけにします。',
  header: '扱い',
  multiSelect: false,
  options: [
    { label: '次 PR メモ送り（推奨）', description: '差分は変えず、PR 本文の「次 PR メモ」欄に 1 行記録して先へ進む' },
    { label: '今修正する', description: 'staging.yml:46 付近に注記を 1〜2 行足してコミットする' },
    { label: '不要として捨てる', description: '記録せずに先へ進む' },
  ],
};

const style: AskQuestion = {
  question: '文章はどちらの書き方にしますか？',
  header: '書き方',
  multiSelect: false,
  options: [
    { label: 'です・ます', description: '丁寧な書き方' },
    { label: 'だ・である', description: '言い切る書き方' },
  ],
};

const languages: AskQuestion = {
  question: 'どの言語を使いますか？（いくつでも）',
  header: '言語',
  multiSelect: true,
  options: [
    { label: 'TypeScript', description: '型の付いた JavaScript' },
    { label: 'Rust', description: '速くて安全' },
    { label: 'Go', description: '簡潔' },
  ],
};

const color: AskQuestion = {
  question: '画面の色はどうしますか？',
  header: '色',
  multiSelect: false,
  options: [
    { label: '明るい色', description: '白の背景' },
    { label: '暗い色', description: '黒の背景' },
  ],
};

const layout: AskQuestion = {
  question: '画面の部品の並べ方はどうしますか？',
  header: '並べ方',
  multiSelect: false,
  options: [
    { label: '縦に並べる', description: '上から下へ', preview: '┌────────┐\n│ 部品 A │\n├────────┤\n│ 部品 B │\n└────────┘' },
    { label: '横に並べる', description: '左から右へ', preview: '┌────────┬────────┐\n│ 部品 A │ 部品 B │\n└────────┴────────┘' },
    { label: 'プレビュー無し', description: 'プレビューの無い選択肢' },
  ],
};

// 横に長い表と、縦に長い一覧のプレビュー
const table = [
  '| 画面       | 一覧の並べ方         | 1 行の高さ | 1 画面の件数 | 並べ替え           | 絞り込み             |',
  '|------------|----------------------|------------|--------------|--------------------|----------------------|',
  ...Array.from({ length: 12 }, (_, i) => `| 画面 ${String(i + 1).padStart(2, '0')}    | 表（列を固定）       | 32px       | ${String(20 + i).padEnd(12)} | 列の見出しを押す   | 上の検索欄           |`),
].join('\n');
const big: AskQuestion = {
  question: '一覧の画面の作りはどれにしますか？',
  header: '一覧',
  multiSelect: false,
  options: [
    { label: '表にする', description: '列を並べる', preview: table },
    { label: 'カードを並べる', description: '1 件を 1 枚のカードに', preview: Array.from({ length: 60 }, (_, i) => `┌──────────┐\n│ カード ${String(i + 1).padStart(2)} │\n└──────────┘`).join('\n') },
    { label: 'プレビュー無し', description: 'プレビューの無い選択肢' },
  ],
};

const meta = {
  title: 'チャット/質問のカード',
  component: QuestionCard,
  args: { sessionId: 'story', question: pending(handling) },
  // 送ると、待っている質問が無くなってカードが消える（ここでは、送れたことにして何も変えない）
  beforeEach: () => mockApi({ 'question.reply': () => Promise.resolve(true) }),
} satisfies Meta<typeof QuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// 質問が 1 つで単一選択。選んだらすぐ送る（入力欄に書いてあれば、補足として一緒に送る）
export const 質問: Story = {};

// 質問が 3 つ（単一選択・複数選択・単一選択）。タブで答えた質問が分かり、最後に回答の確認を出す
export const 複数の質問: Story = { args: { question: pending(style, languages, color) } };

// 複数選択だけの質問。チェックしてから、回答の確認へ（入力欄に書いてあれば、チェックと一緒に送る）
export const 複数選択: Story = { args: { question: pending(languages) } };

// 選択肢にマウスを乗せる（Tab で移る）と、比べるためのプレビューを、カードの右に選択肢の高さにそろえてポップアップで出す。
// ほかは、プレビューの無い質問と同じ（選択肢の下に、自由入力の欄がある）
export const プレビュー付き: Story = { args: { question: pending(layout) } };

// 大きなプレビュー。右に出すときは、右の幅とウインドウの高さまで使い、入りきらない分は中でスクロールする
export const 大きなプレビュー: Story = { args: { question: pending(big) } };

// カードの右に場所が無いとき（カードが画面の幅いっぱい）は、前と同じく、カードの上（入りきらなければ下）に出す
export const 右に場所が無いとき: Story = { args: { question: pending(big) }, parameters: { width: 'none' } };

// 送ろうとしたときに、もう答えられなかった（人がターミナルで答えた・Claude Code が先へ進んだ）
export const 答えられなかったとき: Story = {
  beforeEach: () => mockApi({ 'question.reply': () => Promise.resolve(false) }),
};
