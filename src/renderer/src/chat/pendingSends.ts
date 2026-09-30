import { useCallback, useEffect, useRef, useState } from 'react';
import { submitToClaude } from './ChatInput';
import { acceptsInput, arrivedCount as arrived, type ChatState } from './chatState';

const NO_SENDING: PendingSend[] = [];

// Claude Code の起動が終わるのを待っている発言（新規セッションの最初の発言や、再起動の直後に送ったもの）
export type PendingSend = { text: string; attachments: string[] };

// 送ったが、まだ会話ログに発言（または順番待ち）として出ていないもの。出るまで、チャットに仮に出しておく。
// expected: 発言と順番待ちの数がこの数に達したら、会話ログに出た
type Sending = PendingSend & { expected: number; at: number };

// 仮に出しておく上限。hooks で止められたときなど、発言として書かれないこともある
const SENDING_TIMEOUT_MS = 30_000;


// 起動中に送った文字は Claude Code が取りこぼす（スラッシュコマンドは入力欄に打たれたまま送信されない）ので、
// 入力を受け付けられるようになるまで預かってから送る。選んでいないセッションのものも送る
export function usePendingSends(chatOf: (sessionId: string | null) => ChatState): {
  pendingOf: (sessionId: string) => PendingSend | null;
  // 送ったが、まだ会話ログに出ていない発言
  sendingOf: (sessionId: string) => PendingSend[];
  send: (sessionId: string, text: string, attachments: string[]) => void;
  // 預かっている発言を取り下げて返す
  take: (sessionId: string) => PendingSend | null;
  drop: (sessionId: string) => void;
} {
  const [pending, setPending] = useState<Record<string, PendingSend>>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const chatOfRef = useRef(chatOf);
  chatOfRef.current = chatOf;
  const [sending, setSending] = useState<Record<string, Sending[]>>({});

  const submit = useCallback((sessionId: string, text: string, attachments: string[]) => {
    void submitToClaude(sessionId, text, attachments);
    // スラッシュコマンドは発言として残らないものが多いので、仮には出さない
    if (text.trimStart().startsWith('/')) return;
    const chat = chatOfRef.current(sessionId);
    setSending((prev) => {
      const list = prev[sessionId] ?? [];
      const item = { text, attachments, expected: arrived(chat) + list.length + 1, at: Date.now() };
      return { ...prev, [sessionId]: [...list, item] };
    });
  }, []);

  const drop = useCallback((sessionId: string) => {
    setPending((prev) => {
      if (!(sessionId in prev)) return prev;
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const send = useCallback((sessionId: string, text: string, attachments: string[]) => {
    if (!pendingRef.current[sessionId] && acceptsInput(chatOfRef.current(sessionId).status)) {
      submit(sessionId, text, attachments);
      return;
    }
    // 起動を待つ間に続けて送ったものは、ひとつの発言にまとめる
    setPending((prev) => {
      const before = prev[sessionId];
      const next = before
        ? { text: [before.text, text].filter((t) => t.trim()).join('\n\n'), attachments: [...before.attachments, ...attachments] }
        : { text, attachments };
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
      submit(sessionId, item.text, item.attachments);
    }
  }, [pending, chatOf, drop, submit]);

  // 会話ログに出たもの・時間切れのものを外す
  useEffect(() => {
    const now = Date.now();
    let next: Record<string, Sending[]> | null = null;
    let nextExpiry = Infinity;
    for (const [sessionId, list] of Object.entries(sending)) {
      const chat = chatOf(sessionId);
      const count = arrived(chat);
      const kept = acceptsInput(chat.status) ? list.filter((s) => count < s.expected && now - s.at < SENDING_TIMEOUT_MS) : [];
      if (kept.length !== list.length) next = { ...(next ?? sending), [sessionId]: kept };
      for (const s of kept) nextExpiry = Math.min(nextExpiry, s.at + SENDING_TIMEOUT_MS);
    }
    if (next) {
      setSending(next);
      return;
    }
    if (nextExpiry === Infinity) return;
    const timer = setTimeout(() => setSending((prev) => ({ ...prev })), nextExpiry - now);
    return () => clearTimeout(timer);
  }, [sending, chatOf]);

  const pendingOf = useCallback((sessionId: string) => pending[sessionId] ?? null, [pending]);
  const sendingOf = useCallback((sessionId: string) => sending[sessionId] ?? NO_SENDING, [sending]);
  return { pendingOf, sendingOf, send, take, drop };
}
