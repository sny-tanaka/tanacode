// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { permissionToolDefaults, toolPermissionsOf, type ToolPermission } from '@shared/tool-permissions';
import { ToolPermissionsDialog } from '../../src/renderer/src/mcp/ToolPermissionsDialog';
import './dom';
import { mockApi } from './mock-api';

// Claude のツールの許可のダイアログ（ToolPermissionsDialog。メニューの「MCP → Claude のツールの許可…」から開く）の選択・ボタンを押して、効いたことを確かめる

let api: ReturnType<typeof mockApi>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function open(saved: Record<string, ToolPermission> = {}, set?: (toolId: string, permission: ToolPermission) => Promise<Record<string, ToolPermission>>) {
  let current = saved;
  const onClose = vi.fn();
  api = mockApi({
    'toolPermissions.get': () => Promise.resolve(current),
    'toolPermissions.set': (set ??
      ((toolId: string, permission: ToolPermission) => {
        current = toolPermissionsOf({ ...current, [toolId]: permission });
        return Promise.resolve(current);
      })) as never,
  });
  api.install();
  render(<ToolPermissionsDialog onClose={onClose} />);
  await screen.findByLabelText('スクリーンショット の許可');
  return onClose;
}

const select = (label: string) => screen.getByLabelText(`${label} の許可`) as HTMLSelectElement;
const optionTexts = (label: string) => [...select(label).options].map((o) => o.textContent);

describe('ToolPermissionsDialog', () => {
  it('MCP ごとに全部のツールを並べ、既定のほうに「（既定）」を付ける', async () => {
    await open();
    expect(screen.getAllByRole('combobox')).toHaveLength(permissionToolDefaults().size);
    for (const name of ['アプリ内ブラウザ', 'セッション', 'チェックリスト', 'ウォークスルー', 'ターミナル']) expect(screen.getByRole('region', { name })).toBeTruthy();
    expect(optionTexts('スクリーンショット')).toEqual(['毎回確認', '常に許可（既定）']);
    expect(select('スクリーンショット').value).toBe('allow');
    expect(optionTexts('打ち込む')).toEqual(['毎回確認（既定）', '常に許可']);
    expect(select('打ち込む').value).toBe('ask');
    // ツール名・一行の説明・種類・既定の扱い・子に出さないこと
    const row = select('打ち込む').closest('.tool-permission-row') as HTMLElement;
    expect(within(row).getByText('type_in_terminal')).toBeTruthy();
    expect(within(row).getByText('人のターミナルに打ち込む')).toBeTruthy();
    expect(within(row).getByText('操作する')).toBeTruthy();
    expect(within(row).getByText('既定のままなら、権限モードによらず毎回確認します。')).toBeTruthy();
    expect(within(row).getByText('子セッションには出しません')).toBeTruthy();
    // 外に書き込むツール
    expect(within(select('PR に載せる').closest('.tool-permission-row') as HTMLElement).getByText('外に書き込む')).toBeTruthy();
  });

  it('選んだらすぐ保存し、既定から変えたものに印を付ける', async () => {
    await open({ 'mcp__tanacode-sessions__start_session': 'allow' });
    expect(select('セッションを始める').value).toBe('allow');
    expect(select('セッションを始める').closest('.tool-permission-row')!.classList.contains('changed')).toBe(true);
    fireEvent.change(select('クリック'), { target: { value: 'allow' } });
    await waitFor(() => expect(select('クリック').value).toBe('allow'));
    expect(api.calls.filter((c) => c.name === 'toolPermissions.set').map((c) => c.args)).toEqual([['mcp__tanacode-browser__click', 'allow']]);
    expect(select('クリック').closest('.tool-permission-row')!.classList.contains('changed')).toBe(true);
    // 既定に戻すと、印が消える
    fireEvent.change(select('クリック'), { target: { value: 'ask' } });
    await waitFor(() => expect(select('クリック').closest('.tool-permission-row')!.classList.contains('changed')).toBe(false));
  });

  it('保存できなかったら、理由を出して、選んだものを元に戻す', async () => {
    await open({}, () => Promise.reject(new Error("Error invoking remote method 'tool-permissions:set': Error: 書けません")));
    fireEvent.change(select('クリック'), { target: { value: 'allow' } });
    expect(await screen.findByText('書けません')).toBeTruthy();
    expect(select('クリック').value).toBe('ask');
  });

  it('読めなかったら、選ぶ欄を出さずに理由を出す', async () => {
    api = mockApi({ 'toolPermissions.get': () => Promise.reject(new Error('読めません')) });
    api.install();
    render(<ToolPermissionsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('読めません')).toBeTruthy();
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('閉じるボタン・Escape・外側を押すと閉じる。中を押しても閉じない', async () => {
    const onClose = await open();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
