// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTakeClaudeDraft } from '../../src/renderer/src/chat/claudeDraft';
import { enterClaudeScreen, LEAVE_MS, leaveClaudeScreen } from '../../src/renderer/src/terminal/claudeScreenTyping';
import { mockApi } from './mock-api';

// Claude Code の入力欄に残った文字（書きかけ）を、チャットの入力欄に移す（useTakeClaudeDraft）。
// ターミナルモードで Claude Code の画面を出している間は移さず、隠したら（チャットに戻したら）移す（claudeScreenTyping）

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi();
  api.install();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

// セッション id ごとに、Claude Code の入力欄の文字（draft）を変えながら、移された文字と pty に書いたものを控える
function track(sessionId: string, initial = '') {
  const taken: string[] = [];
  const hook = renderHook(({ draft }) => useTakeClaudeDraft(sessionId, draft, (text) => taken.push(text)), { initialProps: { draft: initial } });
  return { taken, set: (draft: string) => hook.rerender({ draft }), writes: () => api.argsOf('pty.write') };
}

describe('チャットの入力欄に移す', () => {
  it('巻き戻し・中断で戻った文字は移し、Claude Code の入力欄は行の数より 1 つ多い Ctrl+U で消す', () => {
    const t = track('s1');
    t.set('戻した発言');
    expect(t.taken).toEqual(['戻した発言']);
    expect(t.writes()).toEqual([['s1', '\x15\x15']]);
    // 消える前に画面が描き直されても、同じ文字は 2 度移さない
    t.set('戻した発言');
    expect(t.taken).toEqual(['戻した発言']);
    // 消えたら忘れ、同じ発言がまた戻れば移す。複数行も
    t.set('');
    t.set('1 行目\n2 行目');
    t.set('');
    t.set('戻した発言');
    expect(t.taken).toEqual(['戻した発言', '1 行目\n2 行目', '戻した発言']);
    expect(t.writes().slice(1)).toEqual([
      ['s1', '\x15\x15\x15'],
      ['s1', '\x15\x15'],
    ]);
  });

  it('Claude Code の画面を出している間は移さない。Enter で送って消えれば、何も移さない', () => {
    enterClaudeScreen('s2');
    const t = track('s2');
    for (const typed of ['t', 'ty', 'typ', 'typed-f', 'typed-from-xterm']) t.set(typed);
    // しばらく手を止めても（エディタなど、ほかの場所を触っている間も）移さない
    act(() => vi.advanceTimersByTime(60_000));
    expect(t.taken).toEqual([]);
    t.set('');
    leaveClaudeScreen('s2');
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(t.taken).toEqual([]);
    expect(t.writes()).toEqual([]);
  });

  it('打ちかけたまま画面を隠したら（チャットに戻したら）、少し待ってから移す（Enter の直後に隠したなら、書きかけが消えるのを待つ）', () => {
    enterClaudeScreen('s3');
    const t = track('s3', '打ちかけ');
    leaveClaudeScreen('s3');
    act(() => vi.advanceTimersByTime(LEAVE_MS - 1));
    expect(t.taken).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(t.taken).toEqual(['打ちかけ']);
    expect(t.writes()).toEqual([['s3', '\x15\x15']]);
  });

  it('隠してもすぐに出し直せば、移さない', () => {
    enterClaudeScreen('s4');
    const t = track('s4', '打ちかけ');
    leaveClaudeScreen('s4');
    act(() => vi.advanceTimersByTime(LEAVE_MS / 2));
    enterClaudeScreen('s4');
    act(() => vi.advanceTimersByTime(LEAVE_MS * 2));
    expect(t.taken).toEqual([]);
    // 続けて 2 度隠しても、待つのは最初に隠したときから
    leaveClaudeScreen('s4');
    act(() => vi.advanceTimersByTime(LEAVE_MS / 2));
    leaveClaudeScreen('s4');
    act(() => vi.advanceTimersByTime(LEAVE_MS / 2));
    expect(t.taken).toEqual(['打ちかけ']);
  });

  it('ほかのセッションの画面を出していても、このセッションの書きかけは移す', () => {
    enterClaudeScreen('other');
    const t = track('s6');
    t.set('戻した発言');
    expect(t.taken).toEqual(['戻した発言']);
  });
});
