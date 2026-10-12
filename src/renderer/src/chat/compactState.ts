import { useMemo } from 'react';
import type { SessionSummary } from '@shared/ipc';
import type { ScreenInfo } from '@shared/screen';
import type { ChatState } from './chatState';

// 最適化圧縮を始められるか（ヘッダーのボタン）。待機中で、確認の画面が出ておらず、会話があるとき
export function useCanCompact(session: SessionSummary | null, chat: ChatState, screen: ScreenInfo | null): boolean {
  // 入力欄に打つたびに描き直されるので、会話が変わったときだけ探す
  const hasConversation = useMemo(() => chat.items.some((i) => i.kind === 'user' || i.kind === 'text'), [chat.items]);
  if (!session) return false;
  const live = !session.archived && chat.status !== 'exited' && chat.status !== 'not-started';
  const menu = live && screen?.state.kind === 'menu';
  const rewinding = live && screen?.state.kind === 'rewind';
  return live && chat.status === 'idle' && !menu && !rewinding && hasConversation;
}
