import type { Meta, StoryObj } from '@storybook/react-vite';
import { CardPane } from './CardPane';
import { CopyDialog } from './CopyDialog';
import { decisionList, goalList, rounding, sampleSession, sampleSessions } from './sampleChecklists';

// チェックリストのカードの詳細（エディタの場所）。上からタイトル・説明文・スレッド。返信欄は下に固定し、
// 「Claude に通知する」にチェックがあれば、返信したことを手の空いた Claude に知らせる
const meta = {
  title: 'チェックリスト/カード',
  parameters: { width: 760 },
} satisfies Meta;

export default meta;

const frame = (children: React.ReactNode) => <div style={{ height: 620, display: 'flex', flexDirection: 'column' }}>{children}</div>;

// 確認事項: Claude が判断して進め、人が訂正し、Claude が直したあとに人がチェックした
export const スレッドでのやりとり: StoryObj = {
  render: () => frame(<CardPane session={sampleSession} sessions={sampleSessions} list={decisionList} card={rounding} onClose={() => {}} />),
};

export const 説明文なし: StoryObj = {
  render: () => frame(<CardPane session={sampleSession} sessions={sampleSessions} list={goalList} card={goalList.cards[1]} onClose={() => {}} />),
};

// 長いタイトルは、ヘッダーではなく本文の先頭に折り返して全文を出す。幅が狭くても、スレッドのカードは親の幅に収まる
// （コードブロックや表、途切れない長い文字列は、カードの中でスクロールする）
const longTitleCard = {
  ...rounding,
  title: '税込価格の端数の処理を、既存の請求書に合わせて切り捨てにしたが、経理の指示で四捨五入に直し、あわせて請求書 PDF と画面の表示も揃えた',
  thread: [
    ...rounding.thread,
    {
      id: 'long-reply-0000-0000-0000-000000000000',
      at: Date.parse('2026-10-06T11:10:00+09:00'),
      author: 'claude' as const,
      kind: 'reply' as const,
      text: '直した箇所です。\n\n```ts\nexport const roundTax = (price: number, rate: number) => Math.round(price * rate); // 四捨五入\n```\n\n| 税率 | 価格 | 税 |\n| --- | --- | --- |\n| 10% | 1,234 | 123 |\n| 8% | 1,234 | 99 |\n\nhttps://example.com/very/long/path/that/does/not/break/anywhere/in/the/text/and/keeps/going/on/and/on',
    },
  ],
};

export const 長いタイトルと狭い幅: StoryObj = {
  parameters: { width: 340 },
  render: () => frame(<CardPane session={sampleSession} sessions={sampleSessions} list={decisionList} card={longTitleCard} onClose={() => {}} />),
};

// 別のセッションへのコピー。選べるのは同じフォルダと親子・兄弟のセッションだけ
export const 別のセッションへコピー: StoryObj = {
  render: () => <CopyDialog session={sampleSession} sessions={sampleSessions} list={goalList} cardIds={goalList.cards.slice(1).map((c) => c.id)} onClose={() => {}} />,
};
