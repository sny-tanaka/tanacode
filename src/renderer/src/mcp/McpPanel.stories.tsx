import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { McpServer } from '@shared/mcp-status';
import { McpPanel } from './McpPanel';

const tool = (name: string, notes: { readOnly?: boolean; destructive?: boolean } = {}) => ({ name, readOnly: notes.readOnly ?? false, destructive: notes.destructive ?? false });

const server = (name: string, patch: Partial<McpServer> = {}): McpServer => ({
  name,
  status: 'connected',
  scope: 'tanacode',
  serverName: name,
  version: null,
  transport: 'stdio',
  error: null,
  tools: [],
  ...patch,
});

const servers: McpServer[] = [
  server('broken-server', { status: 'failed', scope: 'project', error: 'MCP error -32000: Connection closed (spawn my-server ENOENT)' }),
  server('claude.ai Gmail', { status: 'needs-auth', scope: 'claudeai', transport: 'claudeai-proxy', serverName: null }),
  server('tanacode-browser', { tools: [tool('navigate'), tool('screenshot', { readOnly: true }), tool('click'), tool('get_console_logs', { readOnly: true })] }),
  server('tanacode-checklist', { tools: [tool('card_add'), tool('card_check'), tool('checklist_overview', { readOnly: true })] }),
  server('claude.ai Slack', {
    scope: 'claudeai',
    serverName: 'Slack MCP',
    version: '1.0.0',
    transport: 'claudeai-proxy',
    tools: [tool('slack_send_message'), tool('slack_read_channel', { readOnly: true }), tool('slack_update_canvas', { destructive: true })],
  }),
  server('github', { scope: 'user', transport: 'http', serverName: 'GitHub MCP Server', version: '0.4.2', tools: [tool('get_issue', { readOnly: true }), tool('create_pull_request')] }),
  server('playwright', { status: 'pending', scope: 'project', serverName: null }),
  server('old-server', { status: 'disabled', scope: 'local', serverName: null }),
];

const meta = {
  title: 'MCP/サーバーの一覧',
  parameters: { width: 340, background: '--bg-chrome' },
} satisfies Meta;

export default meta;

function Frame({ children }: { children: ReactNode }) {
  return <div style={{ height: 640, display: 'flex', flexDirection: 'column' }}>{children}</div>;
}

const noop = () => {};

export const 一覧: StoryObj = {
  render: () => (
    <Frame>
      <McpPanel mcp={{ state: 'ready', servers }} loading={false} onReload={noop} />
    </Frame>
  ),
};

// サイドパネルをいちばん狭くしたとき（中身の幅 175px）
export const 狭い幅: StoryObj = {
  parameters: { width: 175 },
  render: () => (
    <Frame>
      <McpPanel mcp={{ state: 'ready', servers }} loading={false} onReload={noop} />
    </Frame>
  ),
};

export const 更新中: StoryObj = {
  render: () => (
    <Frame>
      <McpPanel mcp={{ state: 'ready', servers: servers.slice(2, 4) }} loading onReload={noop} />
    </Frame>
  ),
};

export const 登録なし: StoryObj = {
  render: () => (
    <Frame>
      <McpPanel mcp={{ state: 'ready', servers: [] }} loading={false} onReload={noop} />
    </Frame>
  ),
};

export const 動いていない: StoryObj = {
  render: () => (
    <Frame>
      <McpPanel mcp={{ state: 'stopped' }} loading={false} onReload={noop} />
    </Frame>
  ),
};

export const ターミナルモード: StoryObj = {
  render: () => (
    <Frame>
      <McpPanel mcp={{ state: 'terminal' }} loading={false} onReload={noop} />
    </Frame>
  ),
};

export const 聞けなかった: StoryObj = {
  render: () => (
    <Frame>
      <McpPanel mcp={{ state: 'failed', message: 'mcp_status: timeout' }} loading={false} onReload={noop} />
    </Frame>
  ),
};
