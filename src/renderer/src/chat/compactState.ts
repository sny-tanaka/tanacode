import { useMemo } from 'react';
import type { SessionSummary } from '@shared/ipc';
import type { ScreenInfo } from '@shared/screen';
import type { ChatState } from './chatState';

// 圧縮（/compact）を送れるか・圧縮中か。ヘッダーの「圧縮」と、サイドパネルの「コンテキスト」の「この選び方で圧縮」で使う
export function useCompactState(session: SessionSummary | null, chat: ChatState, screen: ScreenInfo | null): { canCompact: boolean; compacting: boolean } {
  // 入力欄に打つたびに描き直されるので、会話が変わったときだけ探す
  const lastUser = useMemo(() => chat.items.findLast((i) => i.kind === 'user'), [chat.items]);
  if (!session) return { canCompact: false, compacting: false };
  const live = !session.archived && chat.status !== 'exited' && chat.status !== 'not-started';
  const menu = live && screen?.state.kind === 'menu';
  const rewinding = live && screen?.state.kind === 'rewind';
  // /compact は発言として会話ログに残り、圧縮が終わるまで作業中になる（指示を添えたものも）
  const compacting = chat.status === 'running' && !!lastUser && /^\/compact(\s|$)/.test(lastUser.text);
  const canCompact = live && chat.status === 'idle' && !menu && !rewinding && !!lastUser;
  return { canCompact, compacting };
}
