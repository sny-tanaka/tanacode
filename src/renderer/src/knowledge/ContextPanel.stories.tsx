import { useEffect, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CompactMark, ContextItem } from '@shared/context';
import { ContextPanel } from './ContextPanel';
import { useCompactMarks } from './useSessionContext';

// サイドパネルの「コンテキスト」。今のコンテキストの中身を大きさの帯と一緒に並べ、圧縮で残す・捨てるの印を付ける
let order = 0;
const item = (kind: ContextItem['kind'], label: string, tokens: number, extra: Partial<ContextItem> = {}): ContextItem => ({
  id: `${kind}:${label}:${order}`,
  kind,
  label,
  tokens,
  order: order++,
  compacted: false,
  ...extra,
});

const items: ContextItem[] = [
  item('file', 'AGENTS.md', 820),
  item('topic', 'メニューの一覧に、売り切れの印を出してほしい', 6400),
  item('file', 'src/menu/MenuList.tsx', 5200),
  item('file', 'src/menu/menu.ts', 2100),
  item('tool', 'npm install', 9100, { tool: 'Bash' }),
  item('agent', '売り切れの持ち方を調査', 3400),
  item('topic', '質問への答え: 在庫の数で持つ (推奨)', 4100),
  item('file', 'src/menu/MenuList.tsx', 3600, { id: 'file:edited', edited: true }),
  item('tool', 'lsof -i :5173; ps -p 48211 -o command', 1300, { tool: 'Bash' }),
  item('image', '.menu-list', 1150, { tool: 'mcp__tanacode-browser__screenshot' }),
  item('topic', 'dev サーバーが起動しない', 7800),
  item('tool', 'https://example.com/docs/stock', 2600, { tool: 'WebFetch' }),
];

const compacted: ContextItem[] = [
  item('topic', '最初の画面を作って', 18000, { compacted: true }),
  item('file', 'src/App.tsx', 4000, { compacted: true }),
  item('tool', 'npm run build', 6000, { tool: 'Bash', compacted: true }),
];
const afterCompact: ContextItem[] = [item('summary', '前回の圧縮の要約', 3900), ...items.slice(6)];

const meta = {
  title: 'コンテキスト/中身の一覧',
  parameters: { width: 340, background: '--bg-chrome' },
} satisfies Meta;

export default meta;

const noop = () => {};

function Frame({ children }: { children: ReactNode }) {
  return <div style={{ height: 640, display: 'flex', flexDirection: 'column' }}>{children}</div>;
}

// 印を付けた状態で開く（印はセッションごとに覚えている）
function WithMarks({ sessionId, marks, children }: { sessionId: string; marks: [string, CompactMark][]; children: ReactNode }) {
  const { toggle, clear } = useCompactMarks(sessionId, '');
  useEffect(() => {
    clear();
    for (const [id, mark] of marks) toggle(id, mark);
  }, []);
  return <>{children}</>;
}

export const 一覧: StoryObj = {
  render: () => (
    <Frame>
      <ContextPanel sessionId="s1" context={{ items }} tokens={84_000} limit={200_000} canCompact compacting={false} onCompact={noop} />
    </Frame>
  ),
};

// 残す・捨てるの印。印を付けると「この選び方で圧縮…」が押せる
export const 印を付けた: StoryObj = {
  render: () => (
    <Frame>
      <WithMarks
        sessionId="s2"
        marks={[
          [items[2].id, 'keep'],
          [items[6].id, 'keep'],
          [items[4].id, 'drop'],
          [items[10].id, 'drop'],
        ]}
      >
        <ContextPanel sessionId="s2" context={{ items }} tokens={84_000} limit={200_000} canCompact compacting={false} onCompact={noop} />
      </WithMarks>
    </Frame>
  ),
};

// 圧縮のあと。前の圧縮より前のものは、要約に置き換わったものとして畳んで薄く出す
export const 圧縮のあと: StoryObj = {
  render: () => (
    <Frame>
      <ContextPanel
        sessionId="s3"
        context={{ items: [...compacted, ...afterCompact] }}
        tokens={52_000}
        limit={200_000}
        canCompact
        compacting={false}
        onCompact={noop}
      />
    </Frame>
  ),
};

// 作業中は圧縮できない
export const 作業中: StoryObj = {
  render: () => (
    <Frame>
      <WithMarks sessionId="s4" marks={[[items[4].id, 'drop']]}>
        <ContextPanel sessionId="s4" context={{ items }} tokens={84_000} limit={200_000} canCompact={false} compacting={false} onCompact={noop} />
      </WithMarks>
    </Frame>
  ),
};

// サイドパネルをいちばん狭くしたとき（中身の幅 175px）。圧縮のボタンは次の行に回り、印の数やボタンの文字を縦に割らない
export const 狭い幅: StoryObj = {
  parameters: { width: 175 },
  render: () => (
    <Frame>
      <WithMarks
        sessionId="s6"
        marks={[
          [items[2].id, 'keep'],
          [items[4].id, 'drop'],
        ]}
      >
        <ContextPanel sessionId="s6" context={{ items }} tokens={84_000} limit={200_000} canCompact compacting={false} onCompact={noop} />
      </WithMarks>
    </Frame>
  ),
};

export const まだ会話がない: StoryObj = {
  render: () => (
    <Frame>
      <ContextPanel sessionId="s5" context={{ items: [] }} tokens={null} limit={200_000} canCompact={false} compacting={false} onCompact={noop} />
    </Frame>
  ),
};
