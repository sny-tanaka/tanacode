// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CHAT, type ChatState } from '../../src/renderer/src/chat/chatState';
import { useOptimizedCompact } from '../../src/renderer/src/chat/optimizedCompact';
import './dom';
import { mockApi } from './mock-api';

// 最適化圧縮（useOptimizedCompact）。main が返した指示の文を添えて /compact を送るか、送らずにわけを出すか

let alerts: string[];
let statuses: Record<string, ChatState['status']>;
let resolveOptimize: (value: string) => void;
let rejectOptimize: (error: Error) => void;
beforeEach(() => {
  mockApi({
    'context.optimize': () =>
      new Promise<string>((resolve, reject) => {
        resolveOptimize = resolve;
        rejectOptimize = reject;
      }),
  }).install();
  alerts = [];
  statuses = { s1: 'idle', s2: 'idle' };
  vi.spyOn(window, 'alert').mockImplementation((message) => void alerts.push(String(message)));
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const send = vi.fn();
  const chatOf = (id: string | null): ChatState => ({ ...EMPTY_CHAT, status: id ? statuses[id] : 'not-started' });
  const hook = renderHook(() => useOptimizedCompact(chatOf, send));
  return { send, hook };
}

describe('useOptimizedCompact', () => {
  it('選んでいる間は途中の印を出し、返った指示の文を添えて、頼んだセッションに /compact を送る', async () => {
    const { send, hook } = setup();
    act(() => hook.result.current.run('s1'));
    expect(hook.result.current.optimizing('s1')).toBe(true);
    expect(hook.result.current.optimizing('s2')).toBe(false);
    await act(async () => resolveOptimize('`a.ts` の内容は詳しく残す。'));
    expect(send).toHaveBeenCalledWith('s1', '/compact `a.ts` の内容は詳しく残す。', []);
    expect(hook.result.current.optimizing('s1')).toBe(false);
    expect(alerts).toEqual([]);
  });

  it('指示の文が空なら、/compact だけを送る', async () => {
    const { send, hook } = setup();
    act(() => hook.result.current.run('s1'));
    await act(async () => resolveOptimize(''));
    expect(send).toHaveBeenCalledWith('s1', '/compact', []);
  });

  it('選んでいる間に作業が始まったら、送らずにわけを出す', async () => {
    const { send, hook } = setup();
    act(() => hook.result.current.run('s1'));
    statuses.s1 = 'running';
    await act(async () => resolveOptimize('`a.ts` の内容は詳しく残す。'));
    expect(send).not.toHaveBeenCalled();
    expect(alerts).toEqual(['Claude が作業を始めたので、最適化圧縮を取りやめました']);
    expect(hook.result.current.optimizing('s1')).toBe(false);
  });

  it('失敗したら、IPC の前置きを外したわけを出す', async () => {
    const { send, hook } = setup();
    act(() => hook.result.current.run('s1'));
    await act(async () => rejectOptimize(new Error("Error invoking remote method 'context:optimize': Error: Not logged in")));
    expect(send).not.toHaveBeenCalled();
    expect(alerts).toEqual(['最適化圧縮ができませんでした: Not logged in']);
    expect(hook.result.current.optimizing('s1')).toBe(false);
  });
});
