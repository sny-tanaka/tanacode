import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChecklistPanel } from './ChecklistPanel';
import { decisionList, sampleLists, sampleSession, sampleSessions, trashedLists } from './sampleChecklists';

// サイドパネルの「チェックリスト」。リストごとに、カードのタイトルだけを並べる。チェックはここで直接付け外しできる。
// Claude が付けたチェックは青、人が付けたものは緑。Claude からの未読の返信があるカードには、青い点が付く
const meta = {
  title: 'チェックリスト/一覧',
  parameters: { width: 320, background: '--bg-chrome' },
} satisfies Meta;

export default meta;

const frame = (children: React.ReactNode) => <div style={{ height: 560, display: 'flex', flexDirection: 'column' }}>{children}</div>;

export const いくつものリスト: StoryObj = {
  render: () =>
    frame(<ChecklistPanel session={sampleSession} lists={sampleLists} sessions={sampleSessions} activeCardId={decisionList.cards[0].id} onOpen={() => {}} />),
};

export const まだ無い: StoryObj = {
  render: () => frame(<ChecklistPanel session={sampleSession} lists={[]} sessions={sampleSessions} activeCardId={null} onOpen={() => {}} />),
};

// ゴミ箱に入れたカードとリストは、下の「ゴミ箱」から戻せる
export const ゴミ箱: StoryObj = {
  render: () => frame(<ChecklistPanel session={sampleSession} lists={trashedLists} sessions={sampleSessions} activeCardId={null} onOpen={() => {}} />),
};

// サイドパネルをいちばん狭くしたとき（中身の幅 175px）
export const 狭い幅: StoryObj = {
  parameters: { width: 175 },
  render: () => frame(<ChecklistPanel session={sampleSession} lists={sampleLists} sessions={sampleSessions} activeCardId={null} onOpen={() => {}} />),
};
