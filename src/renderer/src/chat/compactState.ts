import { useMemo } from 'react';
import type { SessionSummary } from '@shared/ipc';
import type { ChatState } from './chatState';

// 最適化圧縮を始められるか（ヘッダーのボタン）。待機中（答えを待っている要求が無い）で、会話があるとき
export function useCanCompact(session: SessionSummary | null, chat: ChatState): boolean {
  // 入力欄に打つたびに描き直されるので、会話が変わったときだけ探す
  const hasConversation = useMemo(() => chat.items.some((i) => i.kind === 'user' || i.kind === 'text'), [chat.items]);
  if (!session) return false;
  const live = !session.archived && chat.status !== 'exited' && chat.status !== 'not-started';
  return live && chat.status === 'idle' && hasConversation;
}
