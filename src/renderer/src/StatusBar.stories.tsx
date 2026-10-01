import type { Meta, StoryObj } from '@storybook/react-vite';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import { StatusBar } from './StatusBar';

const noop = () => {};

// 動作確認済のバージョンの最後の数字をずらした版
const shifted = (delta: number) => VERIFIED_CLAUDE_CODE_VERSION.replace(/\d+$/, (n) => String(Number(n) + delta));

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
    claudeVersion: VERIFIED_CLAUDE_CODE_VERSION,
  },
} satisfies Meta<typeof StatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 待機中: Story = {};
export const 起動中: Story = { args: { status: 'starting' } };
export const 作業中: Story = { args: { status: 'running' } };
export const 異常終了: Story = { args: { status: 'exited', exitCode: 1 } };
// Claude Code の版が、tanacode で動作確認済のバージョンと違う（マウスを乗せると理由が出る）
export const 版が新しい: Story = { args: { claudeVersion: shifted(3) } };
export const 版が古い: Story = { args: { claudeVersion: shifted(-3) } };
export const Claudeが見つからない: Story = { args: { claudeVersion: null } };
