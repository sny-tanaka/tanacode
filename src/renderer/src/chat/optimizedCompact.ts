import { useCallback, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import { errorMessage } from '../errorMessage';
import type { ChatState } from './chatState';

// 最適化圧縮。main で Haiku に残すもの・捨てるものを選ばせ、返った指示の文を添えて /compact を送る。
// 選んでいる間（10 秒ほど）にセッションを切り替えても、そのセッションに送る
export function useOptimizedCompact(
  chatOf: (sessionId: string | null) => ChatState,
  send: (sessionId: string, text: string, attachments: string[]) => void,
): { optimizing: (sessionId: string) => boolean; run: (sessionId: string) => void } {
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const chatOfRef = useRef(chatOf);
  chatOfRef.current = chatOf;

  const run = useCallback(
    (sessionId: string) => {
      setRunning((prev) => new Set(prev).add(sessionId));
      window.tanacode.context
        .optimize(sessionId)
        .then((instructions) => {
          // 選んでいる間に作業が始まったら送らない（作業の途中に /compact を打ち込むことになる）
          if (chatOfRef.current(sessionId).status !== 'idle') return window.alert(t('chat.pane.optimizeCancelled'));
          // どれも Haiku が決めかねたときは、指示を添えない
          send(sessionId, instructions ? `/compact ${instructions}` : '/compact', []);
        })
        .catch((error: unknown) => window.alert(t('chat.pane.optimizeFailed', { error: errorMessage(error) })))
        .finally(() =>
          setRunning((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
          }),
        );
    },
    [send],
  );
  const optimizing = useCallback((sessionId: string) => running.has(sessionId), [running]);
  return { optimizing, run };
}
