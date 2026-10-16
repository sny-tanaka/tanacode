import { useCallback, useEffect, useRef, useState } from 'react';
import { submitToClaude } from './ChatInput';
import { acceptsInput, type ChatState } from './chatState';

// Claude Code の起動が終わるのを待っている発言（新規セッションの最初の発言や、再起動の直後に送ったもの）
// pastes: 入力欄に貼り付けた長い文（札）
export type PendingSend = { text: string; attachments: string[]; pastes: string[] };

// 起動中に送るものは、Claude Code が受け付けられるようになるまで預かってから送る（預かっている間は取り下げられる）。選んでいないセッションのものも送る。
// 送ったあとの「送信中」「順番待ち」は、main が送った uuid で追って知らせる（chat.unsent）
export function usePendingSends(chatOf: (sessionId: string | null) => ChatState): {
  pendingOf: (sessionId: string) => PendingSend | null;
  send: (sessionId: string, text: string, attachments: string[], pastes?: string[]) => void;
  // 預かっている発言を取り下げて返す
  take: (sessionId: string) => PendingSend | null;
  drop: (sessionId: string) => void;
} {
  const [pending, setPending] = useState<Record<string, PendingSend>>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const chatOfRef = useRef(chatOf);
  chatOfRef.current = chatOf;

  const submit = useCallback((sessionId: string, text: string, attachments: string[], pastes: string[]) => {
    void submitToClaude(sessionId, text, attachments, pastes);
  }, []);

  const drop = useCallback((sessionId: string) => {
    setPending((prev) => {
      if (!(sessionId in prev)) return prev;
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const send = useCallback((sessionId: string, text: string, attachments: string[], pastes: string[] = []) => {
    if (!pendingRef.current[sessionId] && acceptsInput(chatOfRef.current(sessionId).status)) {
      submit(sessionId, text, attachments, pastes);
      return;
    }
    // 起動を待つ間に続けて送ったものは、ひとつの発言にまとめる
    setPending((prev) => {
      const before = prev[sessionId];
      const next = before
        ? { text: [before.text, text].filter((t) => t.trim()).join('\n\n'), attachments: [...before.attachments, ...attachments], pastes: [...before.pastes, ...pastes] }
        : { text, attachments, pastes };
      return { ...prev, [sessionId]: next };
    });
  }, [submit]);

  const take = useCallback(
    (sessionId: string) => {
      const item = pendingRef.current[sessionId] ?? null;
      drop(sessionId);
      return item;
    },
    [drop],
  );

  useEffect(() => {
    for (const [sessionId, item] of Object.entries(pending)) {
      if (!acceptsInput(chatOf(sessionId).status)) continue;
      drop(sessionId);
      submit(sessionId, item.text, item.attachments, item.pastes);
    }
  }, [pending, chatOf, drop, submit]);

  const pendingOf = useCallback((sessionId: string) => pending[sessionId] ?? null, [pending]);
  return { pendingOf, send, take, drop };
}
