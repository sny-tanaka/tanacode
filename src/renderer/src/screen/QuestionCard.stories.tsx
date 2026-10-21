import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PendingQuestion } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';
import { mockApi } from '../../../../.storybook/mockApi';
import { QuestionCard } from './QuestionCard';

// Claude Code が答えを待っている AskUserQuestion の質問のカード（質問の入力だけで描く）。プレビュー付きの質問には、メモ欄が付く
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

const meta = {
  title: 'チャット/質問のカード',
  component: QuestionCard,
  args: { sessionId: 'story', question: pending(handling) },
  // 送ると、待っている質問が無くなってカードが消える（ここでは、送れたことにして何も変えない）
  beforeEach: () => mockApi({ 'question.reply': () => Promise.resolve(true) }),
} satisfies Meta<typeof QuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// 質問が 1 つで単一選択。選んだらすぐ送る
export const 質問: Story = {};

// 質問が 3 つ（単一選択・複数選択・単一選択）。タブで答えた質問が分かり、最後に回答の確認を出す
export const 複数の質問: Story = { args: { question: pending(style, languages, color) } };

// 複数選択だけの質問。チェックしてから、回答の確認へ
export const 複数選択: Story = { args: { question: pending(languages) } };

// 選択肢にマウスを乗せる（Tab で移る）と、比べるためのプレビューをカードの外にポップアップで出す（上に入りきらなければ下）。
// この形には自由記述が無く、代わりにメモ欄が付く
export const プレビュー付き: Story = { args: { question: pending(layout) } };

// 送ろうとしたときに、もう答えられなかった（人がターミナルで答えた・Claude Code が先へ進んだ）
export const 答えられなかったとき: Story = {
  beforeEach: () => mockApi({ 'question.reply': () => Promise.resolve(false) }),
};
