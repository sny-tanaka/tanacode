import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChecklistPanel } from './ChecklistPanel';
import { decisionList, keptList, listsWithDecisions, sampleLists, sampleSession, sampleSessions, trashedLists } from './sampleChecklists';

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

// 決定事項のリストは、チェックで消えない。チェック欄の代わりにピン、進み具合の代わりに有効な数。取り消したカードは残して印を付ける
export const 決定事項: StoryObj = {
  render: () =>
    frame(<ChecklistPanel session={sampleSession} lists={listsWithDecisions} sessions={sampleSessions} activeCardId={keptList.cards[0].id} onOpen={() => {}} />),
};

export const まだ無い: StoryObj = {
  render: () => frame(<ChecklistPanel session={sampleSession} lists={[]} sessions={sampleSessions} activeCardId={null} onOpen={() => {}} />),
};

// チェックリストのファイルを読めなかった（権限が無い・新しいバージョンのアプリが書いた形など）。空から始め、変更は保存しない
export const 保存できない: StoryObj = {
  render: () =>
    frame(<ChecklistPanel session={{ ...sampleSession, checklistUnsaved: true }} lists={sampleLists.slice(0, 1)} sessions={sampleSessions} activeCardId={null} onOpen={() => {}} />),
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
