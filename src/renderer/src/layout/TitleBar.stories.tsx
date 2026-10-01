import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SEEN_KEY } from './AppUpdate';
import { TitleBar } from './TitleBar';

const meta = {
  title: '全体/タイトルバー',
  component: TitleBar,
  parameters: { width: 900, background: '--bg-chrome' },
  args: { notifications: true, onNotificationsChange: () => {}, update: null },
} satisfies Meta<typeof TitleBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// 右端のベルは、クリックで通知のオン・オフが切り替わる
function Demo({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  return <TitleBar notifications={on} onNotificationsChange={setOn} update={null} />;
}

export const 通知オン: Story = { render: () => <Demo initial /> };

export const 通知オフ: Story = { render: () => <Demo initial={false} /> };

// 設定を読み込むまでは、ベルを出さない
export const 読み込み中: Story = { args: { notifications: null } };

// バージョンの横の印。最新ならチェック、新しいバージョンがあればダウンロードの印。マウスを乗せると説明が出る
export const 最新バージョン: Story = { args: { update: { latest: __APP_VERSION__, available: false, url: '' } } };

// まだ見ていない新しいバージョンは、印が動き続ける（マウスを乗せると止まる。見るたびに動くよう、見た記録を消してから出す）
export const 新しいバージョンあり: Story = {
  beforeEach: () => localStorage.removeItem(SEEN_KEY),
  args: { update: { latest: '9.9.9', available: true, url: 'https://github.com/sny-tanaka/tanacode/releases/tag/v9.9.9' } },
};
