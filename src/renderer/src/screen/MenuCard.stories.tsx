import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PendingPermission } from '@shared/questions';
import { mockApi } from '../../../../.storybook/mockApi';
import { MenuCard } from './MenuCard';

// Claude Code が答えを待っている、質問でない要求（許可の確認・プランの承認）のカード
const permission = (patch: Partial<PendingPermission> = {}): PendingPermission => ({
  id: 'req-1',
  tool: 'Bash',
  title: 'Claude wants to run a command',
  description: 'テストを流す',
  input: { command: 'npm test -- --run test/session-manager.test.ts', description: 'テストを流す' },
  reason: null,
  always: ['Bash(npm test:*)'],
  plan: null,
  agent: null,
  ...patch,
});

const PLAN = [
  '## ログインの不具合を直すプラン',
  '',
  '1. `src/Login.tsx` の `useEffect` の依存の配列に `onSubmit` を足す（送信のたびに二重に呼ばれているため）',
  '2. `test/login.test.tsx` に、二重に送らないことを確かめるテストを足す',
  '3. `npm test` を流して、ほかのテストが落ちないことを確かめる',
  '',
  '変えるのは 2 ファイルだけです。設定やほかの画面には触れません。',
].join('\n');

const meta = {
  title: 'チャット/許可の確認のカード',
  component: MenuCard,
  args: { sessionId: 'story', permission: permission() },
} satisfies Meta<typeof MenuCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const コマンドの許可: Story = {};

// 「今後は聞かない」の候補を Claude Code が出さないとき（読むだけの Bash など、覚えさせられないもの）
export const 今後は聞かないが無い: Story = {
  args: { permission: permission({ always: null, reason: 'このコマンドはフォルダの外に書き込みます' }) },
};

export const ファイルの編集: Story = {
  args: {
    permission: permission({
      tool: 'Edit',
      title: 'Claude wants to edit a file',
      description: null,
      input: { file_path: '/Users/me/work/app/src/Login.tsx', old_string: 'useEffect(() => {}, [])', new_string: 'useEffect(() => {}, [onSubmit])' },
      always: ['acceptEdits'],
    }),
  },
};

export const サブエージェントの中の呼び出し: Story = {
  args: { permission: permission({ agent: 'agent-7f3a', description: 'ビルドの結果を調べる' }) },
};

export const プランの承認: Story = {
  args: { permission: permission({ tool: 'ExitPlanMode', title: null, description: null, input: { plan: PLAN }, always: null, plan: PLAN }) },
};

// 答えたが、もう待っていなかった（スマホで先に答えた）
export const 答えられなかった: Story = {
  beforeEach: () => mockApi({ 'permission.reply': () => Promise.resolve(false) }),
};
