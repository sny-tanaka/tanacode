import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusBar } from './StatusBar';

const noop = () => {};

const meta = {
  title: '全体/ステータスバー',
  component: StatusBar,
  parameters: { width: 1200, background: '--bg-chrome' },
  args: {
    previewOpen: false,
    onTogglePreview: noop,
    terminalOpen: true,
    onToggleTerminal: noop,
    status: 'idle',
    exitCode: null,
    branch: 'develop',
    onOpenScm: () => {},
    pr: { number: 128, url: 'https://github.com/example/tanacode/pull/128', repository: 'example/tanacode' },
    showCursor: false,
    language: 'TypeScript',
  },
} satisfies Meta<typeof StatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 待機中: Story = {};
export const 起動中: Story = { args: { status: 'starting' } };
export const 作業中: Story = { args: { status: 'running' } };
export const 異常終了: Story = { args: { status: 'exited', exitCode: 1 } };
