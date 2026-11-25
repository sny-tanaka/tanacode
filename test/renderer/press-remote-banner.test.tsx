// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteBanner } from '../../src/renderer/src/layout/RemoteBanner';
import './dom';
import { mockApi } from './mock-api';

// 上の帯の「遠隔操作中」（RemoteBanner）を押して、効いたことを確かめる

afterEach(() => cleanup());

describe('RemoteBanner', () => {
  it('つながっている間だけ、端末の名前を出す。「切断」で全部を切ると消える。知らせで出し直す', async () => {
    const api = mockApi({
      'remote.connections': () => Promise.resolve([{ registrationId: 'r1', name: '私用の iPhone', count: 1 }, { registrationId: 'r2', name: '', count: 2 }]),
      'remote.disconnectAll': () => Promise.resolve([]),
    });
    api.install();
    render(<RemoteBanner />);
    expect(await screen.findByText('遠隔操作中（私用の iPhone・名前の無い端末）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '切断' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(api.argsOf('remote.disconnectAll')).toEqual([[]]);
    act(() => api.emit('remote.onConnectionsChanged', [{ registrationId: 'r1', name: 'iPad', count: 1 }]));
    expect(screen.getByText('遠隔操作中（iPad）')).toBeTruthy();
  });

  it('一覧を読めなければ、何も出さない', async () => {
    const api = mockApi({ 'remote.connections': () => Promise.reject(new Error('no')) });
    api.install();
    const { container } = render(<RemoteBanner />);
    await act(async () => {});
    expect(container.innerHTML).toBe('');
  });
});
