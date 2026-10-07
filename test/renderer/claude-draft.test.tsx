// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTakeClaudeDraft } from '../../src/renderer/src/chat/claudeDraft';
import { enterClaudeScreen, LEAVE_MS, leaveClaudeScreen } from '../../src/renderer/src/terminal/claudeScreenTyping';
import { mockApi } from './mock-api';

// Claude Code の入力欄に残った文字（書きかけ）を、チャットの入力欄に移す（useTakeClaudeDraft）。
// 人が Claude Code の画面（ターミナル）で打っている途中の文字は移さず、画面を離れたら移す（claudeScreenTyping）

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

// Claude Code の画面の代わり（ClaudeScreen の .terminal-instance と、その中の xterm の入力欄）
function screenElement() {
  const element = document.createElement('div');
  const textarea = document.createElement('textarea');
  element.appendChild(textarea);
  document.body.appendChild(element);
  return { element, textarea };
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

  it('Claude Code の画面で打っている途中の文字は移さない。Enter で送って消えれば、何も移さない', () => {
    const { element, textarea } = screenElement();
    textarea.focus();
    enterClaudeScreen('s2');
    const t = track('s2');
    for (const typed of ['t', 'ty', 'typ', 'typed-f', 'typed-from-xterm']) t.set(typed);
    // しばらく手を止めても（考えている間も）移さない
    act(() => vi.advanceTimersByTime(60_000));
    t.set('');
    textarea.blur();
    leaveClaudeScreen('s2', element);
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(t.taken).toEqual([]);
    expect(t.writes()).toEqual([]);
  });

  it('打ちかけたまま画面を離れたら、少し待ってから移す（Enter の直後に離れたなら、書きかけが消えるのを待つ）', () => {
    const { element, textarea } = screenElement();
    textarea.focus();
    enterClaudeScreen('s3');
    const t = track('s3', '打ちかけ');
    // チャットの入力欄などに移った
    const chat = document.createElement('textarea');
    document.body.appendChild(chat);
    chat.focus();
    leaveClaudeScreen('s3', element);
    act(() => vi.advanceTimersByTime(LEAVE_MS - 1));
    expect(t.taken).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(t.taken).toEqual(['打ちかけ']);
    expect(t.writes()).toEqual([['s3', '\x15\x15']]);
  });

  it('離れてもすぐに画面へ戻れば、打っている途中のまま', () => {
    const { element, textarea } = screenElement();
    textarea.focus();
    enterClaudeScreen('s4');
    const t = track('s4', '打ちかけ');
    textarea.blur();
    leaveClaudeScreen('s4', element);
    act(() => vi.advanceTimersByTime(LEAVE_MS / 2));
    textarea.focus();
    enterClaudeScreen('s4');
    act(() => vi.advanceTimersByTime(LEAVE_MS * 2));
    expect(t.taken).toEqual([]);
  });

  it('ウィンドウごと離れた（フォーカスが画面に残っている）ときは移さない。画面を隠したら移す', () => {
    const { element, textarea } = screenElement();
    textarea.focus();
    enterClaudeScreen('s5');
    const t = track('s5', '打ちかけ');
    // ほかのアプリに切り替えると、フォーカスは画面に残ったまま、離れたと知らせが来る
    leaveClaudeScreen('s5', element);
    act(() => vi.advanceTimersByTime(LEAVE_MS * 2));
    expect(t.taken).toEqual([]);
    // パネルを閉じた・別のタブにした
    element.hidden = true;
    leaveClaudeScreen('s5', element);
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(t.taken).toEqual(['打ちかけ']);
  });

  it('ほかのセッションの画面で打っていても、このセッションの書きかけは移す', () => {
    enterClaudeScreen('other');
    const t = track('s6');
    t.set('戻した発言');
    expect(t.taken).toEqual(['戻した発言']);
  });
});
