import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { shownStep, type Walkthrough } from '@shared/walkthrough';
import { EditorPane, type OpenFile } from '../editor/EditorPane';
import { DiffPane } from '../scm/DiffPane';
import { walkthroughCommentBody, type WalkthroughCommentDraft } from '@shared/walkthrough-comment';
import { CommentDialog } from './CommentDialog';
import { WalkthroughBand } from './WalkthroughBand';
import { WalkthroughList } from './WalkthroughList';
import { WalkthroughBox } from './WalkthroughZone';

// ウォークスルー。Claude がエディタで示している範囲に色を付け、その下の吹き出しで説明する。
// 人は「次へ」「戻る」・ソース管理の一覧で進め、「質問する」で見ている場所を添えて Claude に聞く。行を選ぶと「ここを聞く」も出る

const tax = `// 税込の金額を計算する
import { settings } from './settings';

export type Price = { net: number; category: 'food' | 'drink' | 'goods' };

// 税率は設定から読む。軽減税率の品目は reducedRate
export function taxRate(price: Price): number {
  const { standardRate, reducedRate } = settings();
  return price.category === 'goods' ? standardRate : reducedRate;
}

// 1 円未満は切り捨てる（レシートの表示と合わせる）
export function withTax(price: Price): number {
  return Math.floor(price.net * (1 + taxRate(price)));
}
`;

const settingsFile = `export type Settings = { standardRate: number; reducedRate: number };

let current: Settings = { standardRate: 0.1, reducedRate: 0.08 };

export function settings(): Settings {
  return current;
}

export function updateSettings(next: Settings): void {
  current = next;
}
`;

const FILES: OpenFile[] = [
  { path: 'src/tax.ts', content: { kind: 'text', text: tax } },
  { path: 'src/settings.ts', content: { kind: 'text', text: settingsFile } },
];

const WALK: Walkthrough = {
  id: 'w1',
  title: '税率を可変にした変更',
  open: true,
  steps: [
    {
      path: 'src/settings.ts',
      startLine: 1,
      endLine: 7,
      view: 'file',
      title: '税率を設定に持たせる',
      body: '税率を定数から設定に移しました。**管理画面から変えられるようにする**ためです。\n\nファイルに保存するのは次の PR で、今はメモリの上だけです。',
    },
    {
      path: 'src/tax.ts',
      startLine: 6,
      endLine: 10,
      view: 'file',
      title: '品目で税率を選ぶ',
      body: '軽減税率の品目（食品・飲み物）とそれ以外で分けています。`category` を増やすときは、ここに足してください。',
    },
    {
      path: 'src/tax.ts',
      startLine: 12,
      endLine: 15,
      view: 'file',
      title: '1 円未満は切り捨てる',
      body: 'レシートの表示と合わせるため、四捨五入ではなく切り捨てにしました。合計ではなく 1 品ごとに切り捨てる点は、前の実装と同じです。',
    },
  ],
  current: 1,
  aside: null,
  visited: [0, 1],
  movedBy: 'claude',
  seq: 1,
  startedAt: 0,
};

const noop = () => {};

// エディタに吹き出しを出す。「次へ」「戻る」で、ステップのファイルに移る。
// 左はソース管理パネルの「ウォークスルー」の一覧。閉じたあとも、ここから押したステップを開き直せる
function Pane({ initial, stale = false }: { initial: Walkthrough; stale?: boolean }) {
  const [walk, setWalk] = useState<Walkthrough>(initial);
  const [activePath, setActivePath] = useState(shownStep(initial).path);
  const [asked, setAsked] = useState<string | null>(null);
  const go = (index: number) => {
    const current = Math.min(Math.max(index, 0), walk.steps.length - 1);
    setActivePath(walk.steps[current].path);
    setWalk({ ...walk, open: true, current, aside: null, visited: [...new Set([...walk.visited, current])], movedBy: 'human', seq: walk.seq + 1 });
  };
  const close = () => setWalk({ ...walk, open: false, aside: null, movedBy: 'human', seq: walk.seq + 1 });
  const open = walk.open ? walk : null;
  return (
    <div style={{ height: 560, display: 'flex', border: '1px solid var(--border-subtle)' }}>
      <div className="side-panel" style={{ width: 260, flex: 'none', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', borderRight: '1px solid var(--border-subtle)' }}>
        <WalkthroughList walkthrough={walk} onGo={go} onPublish={noop} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {open && shownStep(open).path !== activePath && <WalkthroughBand walkthrough={open} onShow={() => setActivePath(shownStep(open).path)} onClose={close} />}
        <EditorPane
          sessionId="s1"
          files={FILES}
          activePath={activePath}
          changes={{}}
          mergeBase={null}
          onShowDiff={noop}
          onOpenFile={noop}
          reveal={null}
          onActivate={setActivePath}
          onClose={noop}
          onSave={async () => {}}
          onCursor={noop}
          comments={[]}
          onAddComment={noop}
          onRemoveComment={noop}
          walkthrough={open && { walkthrough: open, stale, onGo: go, onClose: close, onAsk: setAsked, onRestart: noop, onPublish: noop, onShowList: noop }}
          onAsk={open ? (q) => setAsked(`${q.path}:${q.startLine}-${q.endLine} ${q.text}`) : undefined}
        />
        {asked && <div style={{ padding: 8, fontSize: 12, color: 'var(--text-secondary)' }}>Claude に送った質問: {asked}</div>}
      </div>
    </div>
  );
}

const meta = {
  title: 'エディタ/ウォークスルー',
  parameters: { width: 1020 },
} satisfies Meta;
export default meta;

type Story = StoryObj<typeof meta>;

export const エディタで示す: Story = { render: () => <Pane initial={WALK} /> };

export const 最後のステップ: Story = { render: () => <Pane initial={{ ...WALK, current: 2, visited: [0, 1, 2] }} /> };

// 質問に答えるために、手順の外の場所を示した
export const 寄り道: Story = {
  render: () => (
    <Pane
      initial={{
        ...WALK,
        aside: { path: 'src/settings.ts', startLine: 9, endLine: 11, view: 'file', title: '', body: '設定を変えるのはここだけです。管理画面の保存ボタンから呼びます。' },
      }}
    />
  ),
};

// 始めたあとで、ファイルがディスク側で変わった
export const コードが変わった: Story = { render: () => <Pane initial={WALK} stale /> };

// ブランチの変更の差分に出す（view: diff）。消した行も並べて見せる
const before = tax.replace('  const { standardRate, reducedRate } = settings();\n  return price.category === \'goods\' ? standardRate : reducedRate;', '  return price.category === \'goods\' ? 0.1 : 0.08;');
export const 差分で示す: Story = {
  parameters: { width: 1000 },
  render: () => (
    <div style={{ height: 560, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-subtle)' }}>
      <DiffPane
        path="src/tax.ts"
        subtitle="main から"
        load={async () => ({ original: before, modified: tax })}
        reloadKey=""
        onClose={noop}
        onOpenFile={noop}
        walkthrough={{ walkthrough: { ...WALK, steps: WALK.steps.map((s) => ({ ...s, view: 'diff' })) }, stale: false, onGo: noop, onClose: noop, onAsk: noop, onRestart: noop }}
      />
    </div>
  ),
};

// 吹き出しだけ（質問を書いているところは、押して確かめる）
export const 吹き出し: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <WalkthroughBox walkthrough={WALK} stale={false} onGo={noop} onClose={noop} onAsk={noop} onRestart={noop} onPublish={noop} onShowList={noop} />
    </div>
  ),
};

// 人が自分で別のファイルを開いたときの帯
export const 戻る帯: Story = {
  render: () => <WalkthroughBand walkthrough={WALK} onShow={noop} onClose={noop} />,
};

// GitHub の PR にコメントとして載せる前の下見。本文は手で直せる。「載せる」を押すと、作り物の API が URL を返す
const SHA = '3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345';
const draftOk: WalkthroughCommentDraft = {
  ok: true,
  prNumber: 42,
  prUrl: 'https://github.com/me/cafe/pull/42',
  sha: SHA,
  body: walkthroughCommentBody(WALK, 'https://github.com/me/cafe', SHA, ''),
  postedUrl: null,
};
const fakeApi = (draft: WalkthroughCommentDraft) => ({
  draftComment: async () => draft,
  postComment: async () => 'https://github.com/me/cafe/pull/42#issuecomment-1',
});

export const PRに載せる: Story = { render: () => <CommentDialog sessionId="s1" onClose={noop} api={fakeApi(draftOk)} /> };
export const PRに載せる_載せたことがある: Story = {
  render: () => <CommentDialog sessionId="s1" onClose={noop} api={fakeApi({ ...draftOk, postedUrl: 'https://github.com/me/cafe/pull/42#issuecomment-1' })} />,
};
export const PRに載せる_プッシュしていない: Story = {
  render: () => (
    <CommentDialog
      sessionId="s1"
      onClose={noop}
      api={fakeApi({ ok: false, reason: '手元の HEAD（3f9c2a1）が、PR の最新のコミット（8e1d0c4）と違います。プッシュ（かプル）してから載せてください。' })}
    />
  ),
};

// 閉じたウォークスルー。ソース管理の一覧から、押したステップを開き直せる
export const 閉じたあと: Story = { render: () => <Pane initial={{ ...WALK, open: false, visited: [0, 1, 2] }} /> };
