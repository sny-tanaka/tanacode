import type { Meta, StoryObj } from '@storybook/react-vite';
import { toolPermissionsOf, type ToolPermission } from '@shared/tool-permissions';
import { mockApi } from '../../../../.storybook/mockApi';
import { ToolPermissionsDialog } from './ToolPermissionsDialog';

// Claude のツールの許可（メニューの「MCP → Claude のツールの許可…」から開く）。
// 選ぶと、ストーリーの中の値に反映される（main の代わりに返事を決めている）

const noop = () => {};

function registry(initial: Record<string, ToolPermission>) {
  let permissions = initial;
  mockApi({
    'toolPermissions.get': () => Promise.resolve(permissions),
    'toolPermissions.set': (toolId, permission) => {
      permissions = toolPermissionsOf({ ...permissions, [toolId as string]: permission });
      return Promise.resolve(permissions);
    },
  });
}

const meta = {
  title: 'MCP/Claude のツールの許可',
  component: ToolPermissionsDialog,
  parameters: { bare: true },
  args: { onClose: noop },
  // ダイアログの後ろに、アプリの地の色を敷く
  decorators: [
    (Story) => (
      <div style={{ minHeight: '100vh', background: 'var(--bg-panel)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ToolPermissionsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// どれも既定のまま
export const 既定のまま: Story = { beforeEach: () => registry({}) };

// いくつかを既定から変えた（スクリーンショットは毎回確認・クリックとセッションを始めるは常に許可）。変えた欄は枠の色が変わる
export const 既定から変えたもの: Story = {
  beforeEach: () =>
    registry({
      'mcp__tanacode-browser__screenshot': 'ask',
      'mcp__tanacode-browser__click': 'allow',
      'mcp__tanacode-sessions__start_session': 'allow',
    }),
};
