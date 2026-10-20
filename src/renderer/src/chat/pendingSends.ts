import { useCallback, useEffect, useRef, useState } from 'react';
import { submitToClaude } from './ChatInput';
import { acceptsInput, type ChatState } from './chatState';

// Claude Code の起動が終わるのを待っている発言（新規セッションの最初の発言や、再起動の直後に送ったもの）
// pastes: 入力欄に貼り付けた長い文（札）/ asParent: 新規セッションの画面の「親として始める」（main が TANACODE_PARENT.md を付けて送る）
export type PendingSend = { text: string; attachments: string[]; pastes: string[]; asParent?: boolean };

// セッションごとの預かり。failed: 送ったが送れなかったもの（送った順）/ typed: 起動を待つ間に送ったもの。
// 送るときは failed を先にまとめる（送れなかったものは、いつも、預かっている間に送ったものより前に送ったもの）
type Held = { failed: PendingSend | null; typed: PendingSend | null };

// 続けて預かったものを、ひとつの発言にまとめる（どれかが「親として始める」なら、まとめたものも）
function join(before: PendingSend | null, next: PendingSend | null): PendingSend | null {
  if (!before || !next) return before ?? next;
  return {
    text: [before.text, next.text].filter((t) => t.trim()).join('\n\n'),
    attachments: [...before.attachments, ...next.attachments],
    pastes: [...before.pastes, ...next.pastes],
    ...(before.asParent || next.asParent ? { asParent: true } : {}),
  };
}

// 起動中に送るものは、Claude Code が受け付けられるようになるまで預かってから送る（預かっている間は取り下げられる）。選んでいないセッションのものも送る。
// 送ったあとの「送信中」「順番待ち」は、main が送った uuid で追って知らせる（chat.unsent）。
// 送れなかったもの（再起動の途中に送ったが起動し直せなかった・受け付ける前に終わったなど）は、黙って消さずに預かりに戻す（止まっていれば、
// 「再開」で起動したら送る）。受け付ける状態のまま戻ったものは、すぐ送り直して失敗を繰り返さないよう、いったん受け付けない状態になるまで送らない
export function usePendingSends(chatOf: (sessionId: string | null) => ChatState): {
  pendingOf: (sessionId: string) => PendingSend | null;
  send: (sessionId: string, text: string, attachments: string[], pastes?: string[], asParent?: boolean) => void;
  // 預かっている発言を取り下げて返す
  take: (sessionId: string) => PendingSend | null;
  drop: (sessionId: string) => void;
} {
  const [pending, setPending] = useState<Record<string, Held>>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const chatOfRef = useRef(chatOf);
  chatOfRef.current = chatOf;
  // 送れなかったものを戻したあと、まだ受け付けない状態になっていないセッション（送り直さない）
  const held = useRef(new Set<string>());

  const submit = useCallback((sessionId: string, text: string, attachments: string[], pastes: string[], asParent = false) => {
    submitToClaude(sessionId, text, attachments, pastes, asParent ? { asParent } : undefined).catch(() => {
      held.current.add(sessionId);
      setPending((prev) => {
        const before = prev[sessionId] ?? { failed: null, typed: null };
        return { ...prev, [sessionId]: { ...before, failed: join(before.failed, { text, attachments, pastes, ...(asParent ? { asParent } : {}) }) } };
      });
    });
  }, []);

  const drop = useCallback((sessionId: string) => {
    held.current.delete(sessionId);
    setPending((prev) => {
      if (!(sessionId in prev)) return prev;
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const send = useCallback((sessionId: string, text: string, attachments: string[], pastes: string[] = [], asParent = false) => {
    if (!pendingRef.current[sessionId] && acceptsInput(chatOfRef.current(sessionId).status)) {
      submit(sessionId, text, attachments, pastes, asParent);
      return;
    }
    // 起動を待つ間に続けて送ったものは、ひとつの発言にまとめる
    setPending((prev) => {
      const before = prev[sessionId] ?? { failed: null, typed: null };
      return { ...prev, [sessionId]: { ...before, typed: join(before.typed, { text, attachments, pastes, ...(asParent ? { asParent } : {}) }) } };
    });
  }, [submit]);

  const take = useCallback(
    (sessionId: string) => {
      const item = pendingRef.current[sessionId];
      drop(sessionId);
      return item ? join(item.failed, item.typed) : null;
    },
    [drop],
  );

  useEffect(() => {
    for (const [sessionId, item] of Object.entries(pending)) {
      if (!acceptsInput(chatOf(sessionId).status)) {
        held.current.delete(sessionId);
        continue;
      }
      if (held.current.has(sessionId)) continue;
      const merged = join(item.failed, item.typed);
      drop(sessionId);
      if (merged) submit(sessionId, merged.text, merged.attachments, merged.pastes, merged.asParent);
    }
  }, [pending, chatOf, drop, submit]);

  const pendingOf = useCallback((sessionId: string) => {
    const item = pending[sessionId];
    return item ? join(item.failed, item.typed) : null;
  }, [pending]);
  return { pendingOf, send, take, drop };
}
