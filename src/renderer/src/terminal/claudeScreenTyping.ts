import { useSyncExternalStore } from 'react';

// 人が Claude Code の画面（ターミナルパネルのタブ）で打っているセッション。画面にフォーカスがある間と、離れてから LEAVE_MS の間。
// そのあいだ Claude Code の入力欄にある文字は、人が打っている途中のものなので、チャットの入力欄に移さない（useTakeClaudeDraft）

// 画面を離れてから、打ち終えたとみなすまで。Enter で送った直後に離れても、送った文字が入力欄から消えた画面が届くのを待つ
export const LEAVE_MS = 500;

const typing = new Set<string>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

// 画面にフォーカスが来た
export function enterClaudeScreen(sessionId: string): void {
  clearTimeout(leaving.get(sessionId));
  leaving.delete(sessionId);
  if (typing.has(sessionId)) return;
  typing.add(sessionId);
  emit();
}

// 画面（element）からフォーカスが離れた・画面を隠した。LEAVE_MS たって、まだ画面にフォーカスが戻っていなければ、打ち終えたとみなす。
// ウィンドウごと離れたとき（ほかのアプリに切り替えた）は、フォーカスが画面に残ったままで、戻ればそのまま続きを打てるので、打っている途中のままにする
export function leaveClaudeScreen(sessionId: string, element: HTMLElement): void {
  if (!typing.has(sessionId) || leaving.has(sessionId)) return;
  const timer = setTimeout(() => {
    leaving.delete(sessionId);
    if (!element.hidden && element.contains(document.activeElement)) return;
    typing.delete(sessionId);
    emit();
  }, LEAVE_MS);
  leaving.set(sessionId, timer);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTypingInClaudeScreen(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => typing.has(sessionId));
}
