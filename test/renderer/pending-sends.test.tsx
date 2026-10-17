// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatState, SessionStatus } from '../../src/renderer/src/chat/chatState';
import { usePendingSends } from '../../src/renderer/src/chat/pendingSends';
import { mockApi } from './mock-api';

// Claude Code が受け付けるまで発言を預かる（usePendingSends）。送れなかった発言を黙って消さない

let api: ReturnType<typeof mockApi>;
// sessions.submit を失敗させるか（main が「Claude Code が終了しました」などで断ったとき）
let failing: boolean;
beforeEach(() => {
  failing = false;
  api = mockApi({ 'sessions.submit': () => (failing ? Promise.reject(new Error('Claude Code が終了しました')) : Promise.resolve()) });
  api.install();
});

// status のセッションの画面（預かりが読むのは status だけ）
const render = (status: SessionStatus) =>
  renderHook(({ s }: { s: SessionStatus }) => usePendingSends(() => ({ status: s }) as ChatState), { initialProps: { s: status } });
const submits = () => api.argsOf('sessions.submit');

describe('usePendingSends', () => {
  it('受け付けるセッションにはすぐ送り、起動中のものは預かって、受け付けるようになったらまとめて送る', async () => {
    const { result, rerender } = render('starting');
    act(() => result.current.send('s1', 'はじめ', ['/a.png']));
    act(() => result.current.send('s1', 'つづき', [], ['札']));
    expect(submits()).toEqual([]);
    expect(result.current.pendingOf('s1')).toEqual({ text: 'はじめ\n\nつづき', attachments: ['/a.png'], pastes: ['札'] });
    await act(async () => rerender({ s: 'idle' }));
    expect(submits()).toEqual([['s1', 'はじめ\n\nつづき', ['/a.png'], ['札']]]);
    expect(result.current.pendingOf('s1')).toBeNull();
    await act(async () => result.current.send('s1', 'すぐ', []));
    expect(submits()).toHaveLength(2);
  });

  it('送れなかった発言（起動し直せなかったなど）は、預かりに戻す。受け付ける状態のままでは送り直さず、止まってから受け付けるようになったら送る', async () => {
    failing = true;
    const { result, rerender } = render('idle');
    await act(async () => result.current.send('s1', '再起動のあとも', [], ['札']));
    expect(submits()).toHaveLength(1);
    expect(result.current.pendingOf('s1')).toEqual({ text: '再起動のあとも', attachments: [], pastes: ['札'] });
    // 受け付ける状態のまま描き直しても、失敗を繰り返さない
    await act(async () => rerender({ s: 'idle' }));
    expect(submits()).toHaveLength(1);
    // 止まった（「再開したら送ります」）→ 再開して受け付けるようになったら送る
    failing = false;
    await act(async () => rerender({ s: 'exited' }));
    expect(submits()).toHaveLength(1);
    await act(async () => rerender({ s: 'idle' }));
    expect(submits()).toEqual([
      ['s1', '再起動のあとも', [], ['札']],
      ['s1', '再起動のあとも', [], ['札']],
    ]);
    expect(result.current.pendingOf('s1')).toBeNull();
  });

  it('送れなかった発言は、そのあと預かった発言より前にまとめる。取り下げると、まとめたものを返す', async () => {
    failing = true;
    const { result, rerender } = render('idle');
    await act(async () => result.current.send('s1', '先に送ったもの', []));
    await act(async () => rerender({ s: 'exited' }));
    act(() => result.current.send('s1', '止まってから打ったもの', []));
    expect(result.current.pendingOf('s1')?.text).toBe('先に送ったもの\n\n止まってから打ったもの');
    act(() => expect(result.current.take('s1')?.text).toBe('先に送ったもの\n\n止まってから打ったもの'));
    expect(result.current.pendingOf('s1')).toBeNull();
  });
});
