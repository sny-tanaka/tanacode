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

// コマンドのほかの入力（裏で動かす・時間切れ・サンドボックスの外で動かす）も出す。説明はカードの説明と同じなので二度は出さない
export const コマンドのほかの入力: Story = {
  args: {
    permission: permission({
      input: {
        command: 'npm run build && npm run e2e',
        description: 'テストを流す',
        run_in_background: true,
        timeout: 600000,
        dangerouslyDisableSandbox: true,
      },
      always: null,
    }),
  },
};

// 置き換える前と後を、差分の行で出す（変わらない行は色を付けない）
export const ファイルの編集: Story = {
  args: {
    permission: permission({
      tool: 'Edit',
      title: 'Claude wants to edit a file',
      description: null,
      input: {
        file_path: '/Users/me/work/app/src/Login.tsx',
        old_string: ['  useEffect(() => {', '    onSubmit(form);', '  }, []);'].join('\n'),
        new_string: ['  useEffect(() => {', '    if (!submitted) onSubmit(form);', '  }, [onSubmit, submitted]);'].join('\n'),
        replace_all: false,
      },
      always: ['acceptEdits'],
    }),
  },
};

// 編集ごとに、何個めかの区切りを入れる
export const 複数の編集: Story = {
  args: {
    permission: permission({
      tool: 'MultiEdit',
      title: 'Claude wants to edit a file',
      description: null,
      input: {
        file_path: '/Users/me/work/app/src/price.ts',
        edits: [
          { old_string: 'const TAX = 0.08;', new_string: 'const TAX = 0.1;' },
          { old_string: 'price * (1 + TAX)', new_string: 'Math.round(price * (1 + TAX))', replace_all: true },
        ],
      },
      always: ['acceptEdits'],
    }),
  },
};

// 書く中身を、足す行として出す
export const ファイルを書く: Story = {
  args: {
    permission: permission({
      tool: 'Write',
      title: 'Claude wants to create a file',
      description: null,
      input: {
        file_path: '/Users/me/work/app/test/login.test.tsx',
        content: [
          "import { render } from '@testing-library/react';",
          "import { Login } from '../src/Login';",
          '',
          "it('送信は 1 回だけ', () => {",
          '  const onSubmit = vi.fn();',
          '  render(<Login onSubmit={onSubmit} />);',
          '  expect(onSubmit).toHaveBeenCalledTimes(1);',
          '});',
          '',
        ].join('\n'),
      },
      always: ['acceptEdits'],
    }),
  },
};

// とても長い中身は、頭だけにして省いた文字の数を出す
export const 長い中身: Story = {
  args: {
    permission: permission({
      tool: 'Write',
      title: 'Claude wants to create a file',
      description: null,
      input: { file_path: '/Users/me/work/app/data/prices.csv', content: Array.from({ length: 400 }, (_, i) => `item-${i},${(i * 37) % 1000}`).join('\n') },
      always: null,
    }),
  },
};

export const サブエージェントの中の呼び出し: Story = {
  args: { permission: permission({ agent: 'agent-7f3a', description: 'ビルドの結果を調べる' }) },
};

export const プランの承認: Story = {
  args: { permission: permission({ tool: 'ExitPlanMode', title: null, description: null, input: { plan: PLAN }, always: null, plan: PLAN }) },
};

// プランの本文を読めなかった（plan が空の文字列）。承認の 2 つは押せない。計画を続ける・× は使える
export const プランを読めない: Story = {
  args: { permission: permission({ tool: 'ExitPlanMode', title: null, description: null, input: {}, always: null, plan: '' }) },
};

// 答えたが、もう待っていなかった（スマホで先に答えた）
export const 答えられなかった: Story = {
  beforeEach: () => mockApi({ 'permission.reply': () => Promise.resolve(false) }),
};
