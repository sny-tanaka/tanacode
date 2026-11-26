// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogoutButton, STOP_PUSH_MS } from '../../src/renderer/src/remote/LogoutButton';
import './dom';
import { mockApi } from './mock-api';

// スマホの画面のログアウト（Issue #464）。確かめてから遠隔サーバーに頼み、届かなくてもログインの画面へ戻す

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LogoutButton', () => {
  it('通知を止めるのが返ってこなくても（つながっていない）、時間で打ち切ってログアウトする', async () => {
    vi.useFakeTimers();
    try {
      mockApi({ 'remote.pushUnsubscribe': () => new Promise(() => {}) }).install();
      vi.stubGlobal('PushManager', class {});
      vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration: () => new Promise(() => {}) } });
      const fetch = vi.fn(() => Promise.resolve(new Response('{}')));
      vi.stubGlobal('fetch', fetch);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const done = vi.fn();
      render(<LogoutButton done={done} />);
      fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STOP_PUSH_MS * 2);
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('確かめて「OK」なら、この端末への通知を止め、ログアウトを頼んでからログインの画面へ戻す。「キャンセル」なら何もしない', async () => {
    const api = mockApi({ 'remote.pushUnsubscribe': () => Promise.resolve() });
    api.install();
    const unsubscribe = vi.fn(async () => true);
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ unsubscribe }) } }) } });
    vi.stubGlobal('PushManager', class {});
    const fetch = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetch);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const done = vi.fn();
    render(<LogoutButton done={done} />);
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ログアウト' })));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith('/api/logout', { method: 'POST', credentials: 'same-origin' });
    expect(api.argsOf('remote.pushUnsubscribe')).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('頼みが届かなくても・通知を止められなくても、ログインの画面へ戻す（通知の口の無いブラウザでも）', async () => {
    mockApi({ 'remote.pushUnsubscribe': () => Promise.reject(new Error('切れた')) }).install();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const done = vi.fn();
    render(<LogoutButton done={done} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
      await Promise.resolve();
    });
    expect(done).toHaveBeenCalledTimes(1);
  });
});
