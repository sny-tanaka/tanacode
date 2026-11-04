import { describe, expect, it } from 'vitest';
import { mcpServersOf } from '../src/shared/mcp-status';

// Claude Code の制御の要求 mcp_status の返事（2.1.316 で実測した形を縮めたもの）を、サイドパネルの「MCP」の行にする
describe('mcpServersOf', () => {
  it('名前・状態・scope・サーバーの名乗り・つなぎ方・ツールと注記を読む', () => {
    const servers = mcpServersOf({
      mcpServers: [
        {
          name: 'claude.ai Slack',
          status: 'connected',
          serverInfo: { name: 'Slack MCP', version: '1.0.0' },
          config: { type: 'claudeai-proxy', url: 'https://mcp.slack.com/mcp' },
          transport: 'claudeai-proxy',
          scope: 'claudeai',
          tools: [
            { name: 'slack_read_channel', annotations: { readOnly: true, openWorld: true } },
            { name: 'slack_update_canvas', annotations: { destructive: true } },
            { name: 'slack_send_message' },
          ],
        },
      ],
    });
    expect(servers).toEqual([
      {
        name: 'claude.ai Slack',
        status: 'connected',
        scope: 'claudeai',
        serverName: 'Slack MCP',
        version: '1.0.0',
        transport: 'claudeai-proxy',
        error: null,
        tools: [
          { name: 'slack_read_channel', readOnly: true, destructive: false },
          { name: 'slack_update_canvas', readOnly: false, destructive: true },
          { name: 'slack_send_message', readOnly: false, destructive: false },
        ],
      },
    ]);
  });

  it('tanacode が足したサーバーは、scope に関わらず tanacode にする', () => {
    const [server] = mcpServersOf({ mcpServers: [{ name: 'tanacode-browser', status: 'connected', scope: 'dynamic', tools: [] }] });
    expect(server?.scope).toBe('tanacode');
  });

  it('問題のあるもの（要認証・失敗）を先に、次に tanacode、ほかは名前の順に並べる', () => {
    const names = mcpServersOf({
      mcpServers: [
        { name: 'b-user', status: 'connected', scope: 'user' },
        { name: 'a-user', status: 'connected', scope: 'user' },
        { name: 'tanacode-checklist', status: 'connected', scope: 'dynamic' },
        { name: 'gmail', status: 'needs-auth', scope: 'claudeai' },
        { name: 'off', status: 'disabled', scope: 'project' },
        { name: 'broken', status: 'failed', scope: 'project', error: 'spawn ENOENT' },
      ],
    }).map((s) => s.name);
    expect(names).toEqual(['broken', 'gmail', 'tanacode-checklist', 'a-user', 'b-user', 'off']);
  });

  it('形の違う返事・名前の無い項目は捨てる。つなぎ方は transport が無ければ config.type', () => {
    expect(mcpServersOf(null)).toEqual([]);
    expect(mcpServersOf({ mcpServers: 'x' })).toEqual([]);
    const servers = mcpServersOf({ mcpServers: [{ status: 'connected' }, 1, { name: 'x', config: { type: 'stdio' }, tools: [{}, { name: 'go' }] }] });
    expect(servers).toEqual([{ name: 'x', status: 'pending', scope: 'unknown', serverName: null, version: null, transport: 'stdio', error: null, tools: [{ name: 'go', readOnly: false, destructive: false }] }]);
  });
});
