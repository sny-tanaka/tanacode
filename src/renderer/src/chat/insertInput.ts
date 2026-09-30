import { useEffect, useRef } from 'react';
import { stripControlChars } from './sanitize';

// ほかのパネル（ターミナル・プレビューなど）から、セッションの入力欄に文章と添付（画像のパス）を差し込む
const EVENT = 'tanacode:insert-input';
type Detail = { sessionId: string; text: string; attachments: string[] };

export function insertIntoChat(sessionId: string, text: string, attachments: string[] = []): void {
  // ページやターミナルの出力には ESC などが混じりうる。入力欄では見えないので、入れる前に取り除く
  const detail = { sessionId, text: stripControlChars(text), attachments };
  window.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail }));
}

export function useInsertInput(sessionId: string, onInsert: (text: string, attachments: string[]) => void): void {
  const handler = useRef(onInsert);
  handler.current = onInsert;
  useEffect(() => {
    const listener = (e: Event) => {
      const { detail } = e as CustomEvent<Detail>;
      if (detail.sessionId === sessionId) handler.current(detail.text, detail.attachments);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [sessionId]);
}
