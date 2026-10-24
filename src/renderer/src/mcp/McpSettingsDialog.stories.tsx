import type { Meta, StoryObj } from '@storybook/react-vite';
import { normalizeHostPattern } from '@shared/browser-tools';
import type { McpToolGroup } from '@shared/mcp-tools';
import { toolPermissionsOf, type McpEnabled, type ToolPermission } from '@shared/tool-permissions';
import { mockApi } from '../../../../.storybook/mockApi';
import { McpSettingsDialog } from './McpSettingsDialog';

// MCP の設定（メニューの「MCP の設定…」から開く）。入り・切り・確認の選択・許す先の追加と削除は、
// ストーリーの中の値に反映される（main の代わりに返事を決めている）

const noop = () => {};
const ALL_ON: McpEnabled = { browser: true, sessions: true, checklist: true, walkthrough: true, terminal: true };

function registry(initial: { enabled?: Partial<McpEnabled>; permissions?: Record<string, ToolPermission>; hosts?: string[] }) {
  let enabled: McpEnabled = { ...ALL_ON, ...initial.enabled };
  let permissions = initial.permissions ?? {};
  let hosts = initial.hosts ?? [];
  mockApi({
    'mcpSettings.get': () => Promise.resolve({ enabled, permissions }),
    'mcpSettings.setEnabled': (server, on) => {
      enabled = { ...enabled, [server as McpToolGroup]: on as boolean };
      return Promise.resolve(enabled);
    },
    'mcpSettings.setPermission': (toolId, permission) => {
      permissions = toolPermissionsOf({ ...permissions, [toolId as string]: permission });
      return Promise.resolve(permissions);
    },
    'browser.hosts': () => Promise.resolve(hosts),
    'browser.setHosts': (next) => {
      const list = next as string[];
      const bad = list.filter((h) => !normalizeHostPattern(h));
      // main の失敗は「Error invoking remote method '…': Error: <本文>」の形で届く
      if (bad.length > 0) return Promise.reject(new Error(`Error invoking remote method 'browser:hosts-set': Error: 書き方が違います: ${bad.join('、')}`));
      hosts = [...new Set(list.map((h) => normalizeHostPattern(h)!))];
      return Promise.resolve(hosts);
    },
  });
}

const meta = {
  title: 'MCP/MCP の設定',
  component: McpSettingsDialog,
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
} satisfies Meta<typeof McpSettingsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// どれも既定のまま
export const 既定のまま: Story = { beforeEach: () => registry({}) };

// いくつかを既定から変え、ターミナルを切った。許す先も足してある。変えた欄は枠の色が変わり、切った MCP の行は薄くなって選べない
export const 変えたもの: Story = {
  beforeEach: () =>
    registry({
      enabled: { terminal: false },
      permissions: {
        'mcp__tanacode-browser__screenshot': 'ask',
        'mcp__tanacode-sessions__start_session': 'allow',
        'mcp__tanacode-terminal__type_in_terminal': 'allow',
      },
      hosts: ['myapp.test', '*.staging.example.test'],
    }),
};
