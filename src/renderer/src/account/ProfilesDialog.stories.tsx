import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ProfilesState } from '@shared/profile';
import { mockApi } from '../../../../.storybook/mockApi';
import { ProfilesDialog } from './ProfilesDialog';

// プロファイルの管理。名前（その場で直せる）・色・Claude Code の設定のフォルダ・登録から外す。
// 「追加」で、名前・色・フォルダ（既定は ~/.claude-<名前>）を入れて足す

const STATE: ProfilesState = {
  profiles: [
    { id: 'default', name: '会社', color: '#6d9ccf', claudeDir: null },
    { id: 'p2', name: '個人', color: '#d4835c', claudeDir: '/Users/me/.claude-me' },
  ],
  current: 'default',
  othersAttention: false,
};

const meta = {
  title: 'セッション/プロファイルの管理',
  component: ProfilesDialog,
  args: { mode: 'manage', onClose: () => {} },
  beforeEach: () => mockApi({ 'profiles.get': () => Promise.resolve(STATE) }),
} satisfies Meta<typeof ProfilesDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// 一覧。標準のプロファイル（~/.claude）は外せない
export const 一覧: Story = {};

// 足す欄を開いたところ。名前を入れると、フォルダの既定が ~/.claude-<名前> になる（英数字でなければ ~/.claude-profile-<番号>）
export const 追加: Story = { args: { mode: 'add' } };
