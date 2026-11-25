// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogoutButton } from '../../src/renderer/src/remote/LogoutButton';
import './dom';

// スマホの画面のログアウト（Issue #464）。確かめてから遠隔サーバーに頼み、届かなくてもログインの画面へ戻す

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LogoutButton', () => {
  it('確かめて「OK」なら、ログアウトを頼んでからログインの画面へ戻す。「キャンセル」なら何もしない', async () => {
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
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('頼みが届かなくても、ログインの画面へ戻す', async () => {
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
