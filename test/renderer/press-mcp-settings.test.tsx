// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpToolGroup } from '@shared/mcp-tools';
import { permissionToolDefaults, toolPermissionsOf, type McpEnabled, type ToolPermission } from '@shared/tool-permissions';
import { McpSettingsDialog } from '../../src/renderer/src/mcp/McpSettingsDialog';
import './dom';
import { mockApi } from './mock-api';

// MCP の設定のダイアログ（McpSettingsDialog。メニューの「MCP の設定…」から開く）のスイッチ・選ぶ欄・許す先の入力とボタンを押して、効いたことを確かめる

let api: ReturnType<typeof mockApi>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ALL_ON: McpEnabled = { browser: true, sessions: true, checklist: true, walkthrough: true, terminal: true };

type Overrides = {
  enabled?: Partial<McpEnabled>;
  permissions?: Record<string, ToolPermission>;
  hosts?: string[];
  setEnabled?: (server: McpToolGroup, on: boolean) => Promise<McpEnabled>;
  setPermission?: (toolId: string, permission: ToolPermission) => Promise<Record<string, ToolPermission>>;
  setHosts?: (hosts: string[]) => Promise<string[]>;
};

async function open(o: Overrides = {}) {
  let enabled: McpEnabled = { ...ALL_ON, ...o.enabled };
  let permissions = o.permissions ?? {};
  const onClose = vi.fn();
  api = mockApi({
    'mcpSettings.get': () => Promise.resolve({ enabled, permissions }),
    'mcpSettings.setEnabled': (o.setEnabled ??
      ((server: McpToolGroup, on: boolean) => {
        enabled = { ...enabled, [server]: on };
        return Promise.resolve(enabled);
      })) as never,
    'mcpSettings.setPermission': (o.setPermission ??
      ((toolId: string, permission: ToolPermission) => {
        permissions = toolPermissionsOf({ ...permissions, [toolId]: permission });
        return Promise.resolve(permissions);
      })) as never,
    'browser.hosts': () => Promise.resolve(o.hosts ?? []),
    'browser.setHosts': (o.setHosts ?? ((next: string[]) => Promise.resolve(next))) as never,
  });
  api.install();
  render(<McpSettingsDialog onClose={onClose} />);
  await screen.findByLabelText('screenshot の確認');
  return onClose;
}

const select = (tool: string) => screen.getByLabelText(`${tool} の確認`) as HTMLSelectElement;
const optionTexts = (tool: string) => [...select(tool).options].map((o) => o.textContent);
const row = (tool: string) => select(tool).closest('tr') as HTMLElement;
const toggle = (server: string) => screen.getByRole('switch', { name: `${server} を Claude に使わせる` });
const button = (label: string) => screen.getByLabelText(label) as HTMLButtonElement;

describe('McpSettingsDialog: ツールの表', () => {
  it('MCP ごとに、MCP名・説明・確認の 3 列の表で全部のツールを並べ、既定のほうに「（既定）」を付ける', async () => {
    await open();
    expect(screen.getAllByRole('combobox')).toHaveLength(permissionToolDefaults().size);
    for (const name of ['アプリ内ブラウザ', 'セッション', 'チェックリスト', 'ウォークスルー', 'ターミナル']) expect(screen.getByRole('region', { name })).toBeTruthy();
    const sessions = screen.getByRole('region', { name: 'セッション' });
    expect(within(sessions).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['MCP名', '説明', '確認']);
    // 列: ツール名そのもの・一文の説明・選ぶ欄
    expect(within(row('start_session')).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'start_session',
      '子セッションか、独立したセッションを始める（利用枠を使う）子セッションには出しません',
      '毎回確認（既定）常に許可',
    ]);
    expect(optionTexts('screenshot')).toEqual(['毎回確認', '常に許可（既定）']);
    expect(select('screenshot').value).toBe('allow');
    expect(optionTexts('click')).toEqual(['毎回確認', '常に許可（既定）']);
    expect(select('type_in_terminal').value).toBe('ask');
    expect(select('post_walkthrough').value).toBe('ask');
    // 開く・JavaScript の実行は、説明にどの場合に効くかを含める
    expect(within(row('navigate')).getByText(/許す先の外のページを開く/)).toBeTruthy();
    expect(within(row('evaluate')).getByText(/localhost 以外のページで JavaScript を実行する/)).toBeTruthy();
  });

  it('確認を選んだらすぐ保存し、既定から変えたものに印を付ける。既定に戻すと印が消える', async () => {
    await open({ permissions: { 'mcp__tanacode-sessions__start_session': 'allow' } });
    expect(select('start_session').value).toBe('allow');
    expect(row('start_session').classList.contains('changed')).toBe(true);
    fireEvent.change(select('click'), { target: { value: 'ask' } });
    await waitFor(() => expect(select('click').value).toBe('ask'));
    expect(api.argsOf('mcpSettings.setPermission')).toEqual([['mcp__tanacode-browser__click', 'ask']]);
    expect(row('click').classList.contains('changed')).toBe(true);
    fireEvent.change(select('click'), { target: { value: 'allow' } });
    await waitFor(() => expect(row('click').classList.contains('changed')).toBe(false));
  });

  it('確認を保存できなかったら、理由を出して、選んだものを元に戻す', async () => {
    await open({ setPermission: () => Promise.reject(new Error("Error invoking remote method 'tool-permissions:set': Error: 書けません")) });
    fireEvent.change(select('click'), { target: { value: 'ask' } });
    expect(await screen.findByText('書けません')).toBeTruthy();
    expect(select('click').value).toBe('allow');
  });

  it('読めなかったら、スイッチも選ぶ欄も出さずに理由を出す', async () => {
    api = mockApi({ 'mcpSettings.get': () => Promise.reject(new Error('読めません')) });
    api.install();
    render(<McpSettingsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('読めません')).toBeTruthy();
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });
});

describe('McpSettingsDialog: 入り・切り', () => {
  it('見出しのスイッチで切ると保存し、その MCP のツールの行を薄くして選べなくする（選んだ値は保つ）。入れ直すと選べる', async () => {
    await open({ permissions: { 'mcp__tanacode-terminal__type_in_terminal': 'allow' } });
    const terminal = screen.getByRole('region', { name: 'ターミナル' });
    expect(toggle('ターミナル').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle('ターミナル'));
    await waitFor(() => expect(toggle('ターミナル').getAttribute('aria-checked')).toBe('false'));
    expect(api.argsOf('mcpSettings.setEnabled')).toEqual([['terminal', false]]);
    expect(terminal.classList.contains('off')).toBe(true);
    expect(within(terminal).getByText('切っています。入れ直すと、確認の選択はそのまま使います。')).toBeTruthy();
    expect(select('type_in_terminal').disabled).toBe(true);
    expect(select('type_in_terminal').value).toBe('allow');
    // ほかの MCP は選べるまま
    expect(select('click').disabled).toBe(false);
    fireEvent.click(toggle('ターミナル'));
    await waitFor(() => expect(select('type_in_terminal').disabled).toBe(false));
    expect(api.argsOf('mcpSettings.setEnabled')).toEqual([['terminal', false], ['terminal', true]]);
  });

  it('切ってある MCP は、開いたときから薄い', async () => {
    await open({ enabled: { checklist: false } });
    expect(toggle('チェックリスト').getAttribute('aria-checked')).toBe('false');
    expect(select('card_add').disabled).toBe(true);
  });

  it('入り・切りを保存できなかったら、理由を出して、スイッチは保存した値のまま', async () => {
    await open({ setEnabled: () => Promise.reject(new Error("Error invoking remote method 'mcp-settings:set-enabled': Error: 保存できません")) });
    fireEvent.click(toggle('セッション'));
    expect(await screen.findByText('保存できません')).toBeTruthy();
    expect(toggle('セッション').getAttribute('aria-checked')).toBe('true');
  });
});

describe('McpSettingsDialog: Claude に許す先', () => {
  const input = () => screen.getByLabelText('足す先') as HTMLInputElement;
  const add = (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.submit(input().closest('form')!);
  };

  it('アプリ内ブラウザの見出しの下に出す。既定の先と足した先を並べる', async () => {
    await open({ hosts: ['myapp.test'] });
    const hosts = within(screen.getByRole('region', { name: 'アプリ内ブラウザ' })).getByRole('group', { name: 'Claude に許す先' });
    expect(within(hosts).getByText('localhost')).toBeTruthy();
    expect(await within(hosts).findByText('myapp.test')).toBeTruthy();
  });

  it('打った先を書き方をそろえて足し、入力欄を空にする。空のあいだは「追加」を押せない', async () => {
    await open({ hosts: ['myapp.test'] });
    await screen.findByText('myapp.test');
    expect(button('追加').disabled).toBe(true);
    fireEvent.change(input(), { target: { value: 'http://Example.TEST:8080/path' } });
    expect(button('追加').disabled).toBe(false);
    fireEvent.click(button('追加'));
    await waitFor(() => expect(input().value).toBe(''));
    expect(api.argsOf('browser.setHosts')).toEqual([[['myapp.test', 'example.test']]]);
    expect(screen.getByText('example.test')).toBeTruthy();
  });

  it('書き方の違う先は足さずに理由を出す。既定の先・足してある先は保存せずに入力欄を空にする', async () => {
    await open({ hosts: ['myapp.test'] });
    await screen.findByText('myapp.test');
    add('*');
    expect(screen.getByText('書き方が違います: *（例: example.test・*.example.test・192.168.0.10）')).toBeTruthy();
    expect(input().value).toBe('*');
    add('localhost');
    await waitFor(() => expect(input().value).toBe(''));
    expect(screen.queryByText(/書き方が違います/)).toBeNull();
    add('MyApp.test');
    await waitFor(() => expect(input().value).toBe(''));
    add('');
    expect(screen.getByText('書き方が違います: （空）（例: example.test・*.example.test・192.168.0.10）')).toBeTruthy();
    expect(api.argsOf('browser.setHosts')).toEqual([]);
  });

  it('保存に失敗したら理由を出し、打った先は入力欄に残す', async () => {
    await open({ setHosts: () => Promise.reject(new Error("Error invoking remote method 'browser:hosts-set': Error: 保存できません")) });
    await act(async () => {});
    add('example.test');
    expect(await screen.findByText('保存できません')).toBeTruthy();
    expect(input().value).toBe('example.test');
  });

  it('削除を押すと、その先だけを除いて保存し、Esc で閉じられるようダイアログにフォーカスを戻す', async () => {
    await open({ hosts: ['myapp.test', '*.staging.example.test'] });
    await screen.findByText('myapp.test');
    const rows = screen.getAllByLabelText('削除');
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]);
    await waitFor(() => expect(screen.queryByText('myapp.test')).toBeNull());
    expect(api.argsOf('browser.setHosts')).toEqual([[['*.staging.example.test']]]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog')));
  });
});

describe('McpSettingsDialog: 閉じる', () => {
  it('閉じるボタン・Escape・外側を押すと閉じる。中を押しても、変換中の Esc でも閉じない', async () => {
    const onClose = await open();
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(button('閉じる'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
