import { useEffect, useRef, useState } from 'react';
import type { ScheduledMessage } from '@shared/scheduled';

const NONE: ScheduledMessage[] = [];

// 予約したメッセージ（すべてのセッションの分）。main が保存していて、変わるたびに知らせてくる
export function useScheduledMessages(): ScheduledMessage[] {
  const [messages, setMessages] = useState<ScheduledMessage[]>(NONE);
  useEffect(() => {
    let changed = false;
    const off = window.tanacode.scheduled.onChanged((list) => {
      changed = true;
      setMessages(list);
    });
    // 読み終える前に知らせが届いたら、そちらが新しい
    void window.tanacode.scheduled.list().then((list) => {
      if (!changed && list) setMessages(list);
    });
    return off;
  }, []);
  return messages;
}

// セッションの予約を、時刻の早い順に
export function scheduledOf(messages: ScheduledMessage[], sessionId: string): ScheduledMessage[] {
  return messages.filter((m) => m.sessionId === sessionId).sort((a, b) => a.at - b.at);
}

// 人の対応が要る予約（送れなかった・時刻に送れなかった）
export function needsAttention(message: ScheduledMessage): boolean {
  return message.state === 'missed' || message.state === 'failed';
}

// 予約の文の書き直し。書いている文は、予約の id ごとに持つ（ほかのセッションへ移って戻っても続けられるように）
export type ScheduledEdit = { sessionId: string; original: string; text: string };

// 書き直している間に一覧から消えた予約（時刻になって送った・取り消した）。sessionId のセッションの分だけを見る
// （ほかのセッションの予約は、そのセッションを開いている間の messages に入っていないので、消えたとは決められない）
export function lostEdits(edits: Record<string, ScheduledEdit>, sessionId: string, messages: ScheduledMessage[]): string[] {
  return Object.keys(edits).filter((id) => edits[id]!.sessionId === sessionId && !messages.some((m) => m.id === id));
}

// 予約の文の書き直し（チャットの末尾の予約の枠の中）。messages は開いているセッションの予約。
// 書き直している間に送られた・取り消された予約は、書いた文を捨てないよう onLost に渡す（変えていなければ渡さない）
export function useScheduledEdits(sessionId: string, messages: ScheduledMessage[], onLost: (text: string) => void) {
  const [edits, setEdits] = useState<Record<string, ScheduledEdit>>({});
  // 保存の返事を受けたときの、最新の書き直し
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const onLostRef = useRef(onLost);
  onLostRef.current = onLost;
  useEffect(() => {
    const lost = lostEdits(edits, sessionId, messages);
    if (lost.length === 0) return;
    setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !lost.includes(id))));
    for (const id of lost) {
      const edit = edits[id]!;
      if (edit.text.trim() && edit.text !== edit.original) onLostRef.current(edit.text);
    }
  }, [edits, sessionId, messages]);
  const drop = (id: string) =>
    setEdits((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  return {
    // 書き直している文（書き直していなければ undefined）
    draftOf: (id: string): string | undefined => edits[id]?.text,
    start: (message: ScheduledMessage) =>
      setEdits((prev) => ({ ...prev, [message.id]: { sessionId: message.sessionId, original: message.text, text: message.text } })),
    change: (id: string, text: string) => setEdits((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], text } } : prev)),
    discard: drop,
    // 保存する。断られたら（送っている途中など）、書いた文は残したまま、理由を投げる。
    // 返事の前に予約が一覧から消えていたら（もう送った・取り消した）、書いた文はもう onLost に渡してあるので、重ねて知らせない
    save: async (id: string): Promise<void> => {
      const edit = edits[id];
      if (!edit) return;
      try {
        await window.tanacode.scheduled.edit(id, edit.text);
      } catch (error) {
        if (editsRef.current[id]) throw error;
        return;
      }
      drop(id);
    },
  };
}
