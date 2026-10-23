// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSessionValues } from '../../src/renderer/src/sessionValues';

// セッションごとの値（useSessionValues）。一覧から消えたセッションの値を捨てる

type Props = { selectedId: string | null; listed: ReadonlySet<string> | null };

function setup(initial: Props) {
  return renderHook(({ selectedId, listed }: Props) => useSessionValues<string | undefined, null>(selectedId, listed, null), { initialProps: initial });
}

describe('useSessionValues', () => {
  it('一覧から消えた（削除・アーカイブした）セッションの値を捨てる', () => {
    const hook = setup({ selectedId: 'a', listed: new Set(['a', 'b']) });
    act(() => {
      hook.result.current.update('a', () => 'A');
      hook.result.current.update('b', () => 'B');
    });
    hook.rerender({ selectedId: 'a', listed: new Set(['a']) });
    expect(hook.result.current.peek('b')).toBeUndefined();
    expect(hook.result.current.valueOf('b')).toBeNull();
    expect(hook.result.current.peek('a')).toBe('A');
  });

  it('選んでいる間は一覧から消えても捨てず、ほかを選んだら捨てる', () => {
    const hook = setup({ selectedId: 'a', listed: new Set(['a', 'b']) });
    act(() => hook.result.current.update('a', () => 'A'));
    hook.rerender({ selectedId: 'a', listed: new Set(['b']) });
    expect(hook.result.current.valueOf('a')).toBe('A');
    hook.rerender({ selectedId: 'b', listed: new Set(['b']) });
    expect(hook.result.current.peek('a')).toBeUndefined();
  });

  it('一覧を読む前と、一覧に載る前に値が届いた作ったばかりのセッションの値は捨てない', () => {
    const hook = setup({ selectedId: null, listed: null });
    act(() => hook.result.current.update('a', () => 'A'));
    hook.rerender({ selectedId: null, listed: new Set(['b']) });
    expect(hook.result.current.peek('a')).toBe('A');
    act(() => hook.result.current.update('c', () => 'C'));
    hook.rerender({ selectedId: null, listed: new Set(['a', 'b']) });
    expect(hook.result.current.peek('c')).toBe('C');
  });

  it('undefined を返したら値を捨てる', () => {
    const hook = setup({ selectedId: 'a', listed: new Set(['a']) });
    act(() => hook.result.current.update('a', () => 'A'));
    act(() => hook.result.current.update('a', () => undefined));
    // 値が undefined のまま残っていれば valueOf は undefined を返す。捨てていれば empty（null）
    expect(hook.result.current.valueOf('a')).toBeNull();
  });
});
