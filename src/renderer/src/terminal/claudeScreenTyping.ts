import { useSyncExternalStore } from 'react';

// Claude Code の画面（ターミナルモード）を出しているセッション。出している間と、隠してから LEAVE_MS の間。
// そのあいだ Claude Code の入力欄にある文字は、人が画面で打っているものなので、チャットの入力欄に移さない（useTakeClaudeDraft）。
// フォーカスでは見分けない。画面を出したままエディタなどを触っている間に移すと、書きかけが画面から消え、見えていないチャットの入力欄に入ってしまう

// 画面を隠してから、打ち終えたとみなすまで。Enter で送った直後に隠しても、送った文字が入力欄から消えた画面が届くのを待つ
export const LEAVE_MS = 500;

const typing = new Set<string>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

// 画面を出した
export function enterClaudeScreen(sessionId: string): void {
  clearTimeout(leaving.get(sessionId));
  leaving.delete(sessionId);
  if (typing.has(sessionId)) return;
  typing.add(sessionId);
  emit();
}

// 画面を隠した（チャットに戻した・ほかのセッションへ移った）。LEAVE_MS たって、まだ出し直していなければ、打ち終えたとみなす
export function leaveClaudeScreen(sessionId: string): void {
  if (!typing.has(sessionId) || leaving.has(sessionId)) return;
  const timer = setTimeout(() => {
    leaving.delete(sessionId);
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
