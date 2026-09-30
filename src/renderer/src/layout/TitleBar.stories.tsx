import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { TitleBar } from './TitleBar';

const meta = {
  title: '全体/タイトルバー',
  component: TitleBar,
  parameters: { width: 900, background: '--bg-chrome' },
  args: { notifications: true, onNotificationsChange: () => {} },
} satisfies Meta<typeof TitleBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// 右端のベルは、クリックで通知のオン・オフが切り替わる
function Demo({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  return <TitleBar notifications={on} onNotificationsChange={setOn} />;
}

export const 通知オン: Story = { render: () => <Demo initial /> };

export const 通知オフ: Story = { render: () => <Demo initial={false} /> };

// 設定を読み込むまでは、ベルを出さない
export const 読み込み中: Story = { args: { notifications: null } };
