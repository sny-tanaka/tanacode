import type { Meta, StoryObj } from '@storybook/react-vite';
import { normalizeHostPattern } from '@shared/browser-tools';
import { cleanLinks, isItemLink, normalizeSite, type CredentialLink } from '@shared/credential-links';
import type { McpToolGroup } from '@shared/mcp-tools';
import { toolPermissionsOf, type McpEnabled, type ToolPermission } from '@shared/tool-permissions';
import { mockApi } from '../../../../.storybook/mockApi';
import { McpSettingsDialog } from './McpSettingsDialog';

// MCP の設定（メニューの「MCP の設定…」から開く）。入り・切り・確認の選択・許す先とサイトごとの 1Password のリンクの追加と削除は、
// ストーリーの中の値に反映される（main の代わりに返事を決めている）

const noop = () => {};
const ALL_ON: McpEnabled = { browser: true, sessions: true, checklist: true, walkthrough: true, terminal: true };

function registry(initial: { enabled?: Partial<McpEnabled>; permissions?: Record<string, ToolPermission>; parentAskRules?: boolean; hosts?: string[]; links?: CredentialLink[] }) {
  let enabled: McpEnabled = { ...ALL_ON, ...initial.enabled };
  let permissions = initial.permissions ?? {};
  let parentAskRules = initial.parentAskRules ?? false;
  let hosts = initial.hosts ?? [];
  let links = initial.links ?? [];
  mockApi({
    'mcpSettings.get': () => Promise.resolve({ enabled, permissions, parentAskRules, problem: null }),
    'mcpSettings.setEnabled': (server, on) => {
      enabled = { ...enabled, [server as McpToolGroup]: on as boolean };
      return Promise.resolve(enabled);
    },
    'mcpSettings.setPermission': (toolId, permission) => {
      permissions = toolPermissionsOf({ ...permissions, [toolId as string]: permission });
      return Promise.resolve(permissions);
    },
    'mcpSettings.setParentAskRules': (on) => {
      parentAskRules = on as boolean;
      return Promise.resolve(parentAskRules);
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
    'browser.credentialLinks': () => Promise.resolve(links),
    'browser.setCredentialLinks': (next) => {
      const list = next as CredentialLink[];
      const bad = list.find((l) => !normalizeSite(l.site) || !isItemLink(l.link));
      if (bad) return Promise.reject(new Error(`Error invoking remote method 'browser:credential-links-set': Error: 書き方が違います: ${bad.site}`));
      links = cleanLinks(list);
      return Promise.resolve(links);
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

// いくつかを既定から変え、ターミナルを切った。許す先も足し、ask の規則で出た子の確認も親に許させている。変えた欄は枠の色が変わり、切った MCP の行は薄くなって選べない
export const 変えたもの: Story = {
  beforeEach: () =>
    registry({
      enabled: { terminal: false },
      permissions: {
        'mcp__tanacode-browser__screenshot': 'ask',
        'mcp__tanacode-sessions__start_session': 'allow',
        'mcp__tanacode-terminal__type_in_terminal': 'allow',
      },
      parentAskRules: true,
      hosts: ['myapp.test', '*.staging.example.test'],
      links: [
        { site: 'myapp.test', link: 'https://start.1password.com/open/i?a=ABCDEFGHIJKLMNOPQRSTUVWXYZ&v=abcdefghijklmnopqrstuvwxyz&i=zyxwvutsrqponmlkjihgfedcba&h=my.1password.com' },
        { site: 'localhost:3000', link: 'https://start.1password.com/open/i?a=ABCDEFGHIJKLMNOPQRSTUVWXYZ&v=abcdefghijklmnopqrstuvwxyz&i=0123456789abcdefghijklmnop&h=my.1password.com' },
      ],
    }),
};
