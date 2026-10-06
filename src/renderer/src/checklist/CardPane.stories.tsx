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

// 別のセッションへのコピー。選べるのは同じフォルダと親子・兄弟のセッションだけ
export const 別のセッションへコピー: StoryObj = {
  render: () => <CopyDialog session={sampleSession} sessions={sampleSessions} list={goalList} cardIds={goalList.cards.slice(1).map((c) => c.id)} onClose={() => {}} />,
};
