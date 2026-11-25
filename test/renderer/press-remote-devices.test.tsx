// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDevicesState } from '@shared/remote-settings';
import { RemoteDevices } from '../../src/renderer/src/remote/RemoteDevices';
import './dom';
import { mockApi } from './mock-api';

// 遠隔操作で登録した端末と、端末の登録の受付（RemoteDevices。遠隔操作の設定のダイアログの中）のボタン・入力を押して、効いたことを確かめる

let api: ReturnType<typeof mockApi>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const none: RemoteDevicesState = { devices: [], pairing: null, problem: null };
const device = { id: 'd1', name: 'iPhone', createdAt: Date.UTC(2026, 10, 25, 1), lastUsedAt: null };
const pairing = (pending: { requestId: string; name: string }[] = []): RemoteDevicesState => ({
  devices: [],
  pairing: { code: '12345678', url: 'https://mac.example.ts.net/#pair=12345678', until: Date.now() + 600_000, pending },
  problem: null,
});

async function open(initial: RemoteDevicesState, responses: Record<string, (...args: never[]) => unknown> = {}) {
  api = mockApi({ 'remote.devices': () => Promise.resolve(initial), ...responses });
  api.install();
  render(<RemoteDevices />);
  await screen.findByText('登録した端末', { selector: '.remote-field-label' });
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('RemoteDevices', () => {
  it('登録した端末が無ければそう出し、「端末を追加」で受付を始め、QR とコードを出す', async () => {
    await open(none, { 'remote.startPairing': () => Promise.resolve(pairing()) });
    expect(screen.getByText('まだ登録した端末はありません。')).toBeTruthy();
    fireEvent.click(button('端末を追加'));
    expect(await screen.findByText('12345678')).toBeTruthy();
    await waitFor(() => expect(screen.getByAltText('スマホで読む QR').getAttribute('src')).toMatch(/^data:image\/png;base64,/));
    expect(api.argsOf('remote.startPairing')).toEqual([[]]);
  });

  it('始められなければ、理由を出す', async () => {
    await open(none, { 'remote.startPairing': () => Promise.reject(new Error('遠隔操作が待ち受けていません')) });
    fireEvent.click(button('端末を追加'));
    expect(await screen.findByText('遠隔操作が待ち受けていません')).toBeTruthy();
  });

  it('承認を待つ頼みは、6 桁を打つまで承認できない。打って承認すると数字を送る。違えば理由を出す', async () => {
    await open(pairing([{ requestId: 'q1', name: 'iPhone' }]), {
      'remote.approvePairing': () => Promise.resolve(false),
    });
    expect(screen.getByText('「iPhone」が登録を待っています')).toBeTruthy();
    expect(button('承認する').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('スマホに出た数字'), { target: { value: '123456' } });
    fireEvent.click(button('承認する'));
    expect(await screen.findByText(/数字が違います/)).toBeTruthy();
    expect(api.argsOf('remote.approvePairing')).toEqual([['q1', '123456']]);
  });

  it('断る・受付をやめる', async () => {
    await open(pairing([{ requestId: 'q1', name: '' }]), {
      'remote.rejectPairing': () => Promise.resolve(pairing()),
      'remote.cancelPairing': () => Promise.resolve(none),
    });
    expect(screen.getByText('「名前の無い端末」が登録を待っています')).toBeTruthy();
    fireEvent.click(button('断る'));
    await waitFor(() => expect(api.argsOf('remote.rejectPairing')).toEqual([['q1']]));
    fireEvent.click(button('登録の受付をやめる'));
    expect(await screen.findByRole('button', { name: '端末を追加' })).toBeTruthy();
  });

  it('登録した端末を、確かめてから取り消す（断ったら何もしない）', async () => {
    await open({ ...none, devices: [device] }, { 'remote.removeDevice': () => Promise.resolve(none) });
    expect(screen.getByText('iPhone')).toBeTruthy();
    expect(screen.getByText(/最後に使った まだ使っていない/)).toBeTruthy();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(button('取り消す'));
    expect(api.argsOf('remote.removeDevice')).toEqual([]);
    fireEvent.click(button('取り消す'));
    expect(await screen.findByText('まだ登録した端末はありません。')).toBeTruthy();
    expect(confirm).toHaveBeenCalledWith('「iPhone」の登録を取り消しますか？');
  });

  it('一覧が変わった知らせで描き直す。古いファイルに戻されていたら、止めている理由を出す', async () => {
    await open(none);
    act(() => api.emit('remote.onDevicesChanged', { ...none, devices: [{ ...device, lastUsedAt: Date.now() }], problem: 'rolled-back' }));
    expect(screen.getByText(/前のものに戻されていた/)).toBeTruthy();
    expect(screen.getByText('iPhone')).toBeTruthy();
  });

  it('一覧を読めないときは、確かめてから全部を消してやり直す（断ったら何もしない）', async () => {
    await open({ ...none, problem: 'unreadable' }, { 'remote.resetDevices': () => Promise.resolve(none) });
    expect(screen.getByText(/一覧を読めないため/)).toBeTruthy();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(button('登録を全部消して、やり直す'));
    expect(api.argsOf('remote.resetDevices')).toEqual([]);
    fireEvent.click(button('登録を全部消して、やり直す'));
    await waitFor(() => expect(screen.queryByText(/一覧を読めないため/)).toBeNull());
    expect(api.argsOf('remote.resetDevices')).toEqual([[]]);
    expect(confirm).toHaveBeenLastCalledWith('登録した端末を全部消して、空の一覧から始め直しますか？\nスマホは、もう一度登録し直します。');
  });

  it('読めなければ、理由だけを出す', async () => {
    api = mockApi({ 'remote.devices': () => Promise.reject(new Error('EACCES')) });
    api.install();
    render(<RemoteDevices />);
    expect(await screen.findByText('EACCES')).toBeTruthy();
  });
});
