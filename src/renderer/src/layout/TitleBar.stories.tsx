import type { Meta, StoryObj } from '@storybook/react-vite';
import { TitleBar } from './TitleBar';

const meta = {
  title: '全体/タイトルバー',
  component: TitleBar,
  parameters: { width: 900, background: '--bg-chrome' },
} satisfies Meta<typeof TitleBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ロゴとバージョン: Story = {};
