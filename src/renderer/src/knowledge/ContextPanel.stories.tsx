import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ContextItem } from '@shared/context';
import { ContextPanel } from './ContextPanel';

// サイドパネルの「コンテキスト」。今のコンテキストの中身（何がどれだけ入っているか）を、大きさの帯と一緒に並べる
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

function Frame({ children }: { children: ReactNode }) {
  return <div style={{ height: 640, display: 'flex', flexDirection: 'column' }}>{children}</div>;
}

export const 一覧: StoryObj = {
  render: () => (
    <Frame>
      <ContextPanel context={{ items }} tokens={84_000} limit={200_000} />
    </Frame>
  ),
};

// 圧縮のあと。前の圧縮より前のものは、要約に置き換わったものとして畳んで薄く出す
export const 圧縮のあと: StoryObj = {
  render: () => (
    <Frame>
      <ContextPanel context={{ items: [...compacted, ...afterCompact] }} tokens={52_000} limit={200_000} />
    </Frame>
  ),
};

// サイドパネルをいちばん狭くしたとき（中身の幅 175px）
export const 狭い幅: StoryObj = {
  parameters: { width: 175 },
  render: () => (
    <Frame>
      <ContextPanel context={{ items }} tokens={84_000} limit={200_000} />
    </Frame>
  ),
};

export const まだ会話がない: StoryObj = {
  render: () => (
    <Frame>
      <ContextPanel context={{ items: [] }} tokens={null} limit={200_000} />
    </Frame>
  ),
};
