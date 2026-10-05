import { useEffect, useState } from 'react';
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
