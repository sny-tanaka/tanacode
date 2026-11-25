// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { MobileBar } from '../../src/renderer/src/mobile/MobileBar';
import { MobileTabs, MobileWaiting } from '../../src/renderer/src/mobile/MobileTabs';
import { useMobileLayout } from '../../src/renderer/src/mobile/useMobileLayout';
import { setRemoteConnected, setRemoteMode } from '../../src/renderer/src/remote/mode';
import { MobileKeys } from '../../src/renderer/src/terminal/MobileKeys';
import { withCtrl } from '../../src/renderer/src/terminal/TerminalPanel';
import './dom';

// スマホの画面の配置（上の帯・下のタブ・答え待ちの帯・ターミナルの補助キー）を押して、効いたことを確かめる

afterEach(() => {
  cleanup();
  setRemoteMode(false);
  setRemoteConnected(true);
  vi.unstubAllGlobals();
});

const session = { id: 's1', title: 'README を直す' } as SessionSummary;

describe('MobileBar', () => {
  it('セッションの名前と、ほかの答え待ちの数を出す。ボタンで引き出しを開く。つながっていないときはそう出す', () => {
    const open = vi.fn();
    const view = render(<MobileBar session={session} waiting={2} onOpenSessions={open} />);
    expect(screen.getByText('README を直す')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Mac とつながっています');
    act(() => setRemoteConnected(false));
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Mac につなぎ直しています');
    view.rerender(<MobileBar session={{ ...session, title: '' }} waiting={0} onOpenSessions={open} />);
    expect(screen.getByText('名前の無いセッション')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    view.rerender(<MobileBar session={null} waiting={0} onOpenSessions={open} />);
    expect(screen.getByText('セッションを選んでください')).toBeTruthy();
  });
});

describe('MobileTabs・MobileWaiting', () => {
  it('タブを押すと切り替える。答え待ちの帯は、待ちがあるときだけ出し、押すとそのセッションへ', () => {
    const change = vi.fn();
    render(<MobileTabs tab="chat" onChange={change} />);
    expect(screen.getByRole('tab', { name: 'チャット' }).getAttribute('aria-selected')).toBe('true');
    for (const name of ['パネル', 'エディタ', 'ターミナル']) fireEvent.click(screen.getByRole('tab', { name }));
    expect(change.mock.calls).toEqual([['panel'], ['editor'], ['terminal']]);
    const show = vi.fn();
    const view = render(<MobileWaiting count={0} onShow={show} />);
    expect(view.container.innerHTML).toBe('');
    view.rerender(<MobileWaiting count={3} onShow={show} />);
    fireEvent.click(screen.getByRole('button', { name: 'ほかの 3 件が答えを待っています' }));
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('MobileKeys・withCtrl', () => {
  it('補助キーは、その文字を送る。Ctrl の入り・切りを伝える。1 行の入力欄は、書いた文に Enter を付けて送る', () => {
    const write = vi.fn();
    const onCtrl = vi.fn();
    const view = render(<MobileKeys write={write} ctrl={false} onCtrl={onCtrl} />);
    for (const name of ['Esc', 'Tab', '←', '↑', '↓', '→', '|', '~', '/', '-', '^C']) fireEvent.click(screen.getByRole('button', { name }));
    expect(write.mock.calls.map((c) => c[0])).toEqual(['\x1b', '\t', '\x1b[D', '\x1b[A', '\x1b[B', '\x1b[C', '|', '~', '/', '-', '\x03']);
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    expect(onCtrl).toHaveBeenLastCalledWith(true);
    view.rerender(<MobileKeys write={write} ctrl onCtrl={onCtrl} />);
    expect(screen.getByRole('button', { name: 'Ctrl' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    expect(onCtrl).toHaveBeenLastCalledWith(false);
    write.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '1 行で入力' }));
    fireEvent.change(screen.getByPlaceholderText('コマンドを入力'), { target: { value: 'ls -la' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(write).toHaveBeenCalledWith('ls -la\r');
    expect((screen.getByPlaceholderText('コマンドを入力') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '1 行で入力' }));
    expect(screen.queryByPlaceholderText('コマンドを入力')).toBeNull();
  });

  it('Ctrl を付けるのは 1 文字の a〜z と @ [ \\ ] ^ _ だけ', () => {
    expect([withCtrl('c'), withCtrl('C'), withCtrl('['), withCtrl('1'), withCtrl('ab')]).toEqual(['\x03', '\x03', '\x1b', '1', 'ab']);
  });
});

describe('useMobileLayout', () => {
  const media = (matches: boolean) => {
    const listeners: (() => void)[] = [];
    const query = { matches, addEventListener: (_: string, fn: () => void) => listeners.push(fn), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', () => query);
    return { query, fire: (next: boolean) => ((query.matches = next), listeners.forEach((fn) => fn())) };
  };

  it('スマホの画面で、幅が狭いときだけスマホの配置にする。Mac の画面では、狭くてもしない', () => {
    media(true);
    expect(renderHook(() => useMobileLayout()).result.current).toBe(false);
    setRemoteMode(true);
    const m = media(false);
    const { result, unmount } = renderHook(() => useMobileLayout());
    expect(result.current).toBe(false);
    act(() => m.fire(true));
    expect(result.current).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--app-height')).toMatch(/px$/);
    unmount();
    expect(m.query.removeEventListener).toHaveBeenCalled();
  });
});
