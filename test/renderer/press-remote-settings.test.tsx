// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSettingsInput, RemoteSettingsState, RemoteStatus } from '@shared/remote-settings';
import { RemoteSettingsDialog, remoteStatusText } from '../../src/renderer/src/remote/RemoteSettingsDialog';
import './dom';
import { mockApi } from './mock-api';

// 遠隔操作の設定のダイアログ（RemoteSettingsDialog。メニューバーの「遠隔操作の設定…」から開く）のボタン・入力を押して、効いたことを確かめる

let api: ReturnType<typeof mockApi>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const stateOf = (publicUrl: string, status: RemoteStatus = { state: 'off' }): RemoteSettingsState => ({ settings: { enabled: false, port: 47413, publicUrl }, status, connections: 0 });

async function open(initial: RemoteSettingsState, set: (input: RemoteSettingsInput) => Promise<RemoteSettingsState> = (input) => Promise.resolve({ ...initial, settings: { ...initial.settings, ...input } })) {
  const onClose = vi.fn();
  api = mockApi({ 'remote.settings': () => Promise.resolve(initial), 'remote.setSettings': set as never });
  api.install();
  render(<RemoteSettingsDialog onClose={onClose} />);
  await screen.findByText('止まっています');
  return onClose;
}

const input = (index: number) => document.querySelectorAll<HTMLInputElement>('.remote-field input')[index];
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('RemoteSettingsDialog', () => {
  it('今の設定が入っていて、変えるまでは保存できない。変えて保存すると、ポートと公開する URL を送って閉じる', async () => {
    const onClose = await open(stateOf(''));
    expect(input(1).value).toBe('47413');
    expect(button('保存').disabled).toBe(true);
    fireEvent.change(input(0), { target: { value: ' https://mac.example.ts.net ' } });
    fireEvent.change(input(1), { target: { value: '50000' } });
    fireEvent.click(button('保存'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.argsOf('remote.setSettings')).toEqual([[{ port: 50000, publicUrl: 'https://mac.example.ts.net' }]]);
  });

  it('保存できなければ、理由を出して閉じない（もう一度押せる）', async () => {
    const onClose = await open(stateOf(''), () => Promise.reject(new Error("Error invoking remote method 'remote:settings-set': Error: ポートは 1024〜65535 の数で決めてください")));
    fireEvent.change(input(1), { target: { value: '80' } });
    fireEvent.click(button('保存'));
    expect(await screen.findByText('遠隔操作の設定を保存できませんでした: ポートは 1024〜65535 の数で決めてください')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(button('保存').disabled).toBe(false);
  });

  it('読めなければ、欄を出さずに理由を出す', async () => {
    api = mockApi({ 'remote.settings': () => Promise.reject(new Error('EACCES')) });
    api.install();
    render(<RemoteSettingsDialog onClose={vi.fn()} />);
    expect(await screen.findByText('遠隔操作の設定を読めませんでした: EACCES')).toBeTruthy();
    expect(document.querySelector('.remote-field')).toBeNull();
  });

  it('取り消し・Escape・外を押すと閉じる', async () => {
    const onClose = await open(stateOf('https://mac.example.ts.net'));
    fireEvent.click(button('キャンセル'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.overlay')!);
    expect(onClose).toHaveBeenCalledTimes(3);
    // ダイアログの中を押しても閉じない（外を押したときだけ閉じる）
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ state: 'off' }, 0, '止まっています'],
    [{ state: 'starting' }, 0, '始めています…'],
    [{ state: 'listening', port: 47413 }, 2, '127.0.0.1:47413 で待ち受けています（つながっているもの 2）'],
    [{ state: 'in-use', port: 47413 }, 0, 'ポート 47413 が使われているため、待ち受けられません'],
    [{ state: 'failed', message: 'x' }, 0, '待ち受けられませんでした'],
  ] as const)('待ち受けの様子の文: %j', (status, connections, text) => {
    expect(remoteStatusText(status, connections)).toBe(text);
  });
});
