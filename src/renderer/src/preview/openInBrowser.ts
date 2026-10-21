import { useEffect, useRef } from 'react';

// ターミナルのリンクなどから、セッションのアプリ内ブラウザの新しいタブで URL を開く（runInTerminal と同じ形。画面の中だけで受け渡す）。
// sessionId が null なら、今見ているもの（セッションか、新規セッションの画面のフォルダ）のブラウザで。開けたら true
// （ブラウザが無い・http(s) でないなど、開けなければ false。呼び出し側がふだんのブラウザで開く）
const EVENT = 'tanacode:open-in-browser';
type Detail = { sessionId: string | null; url: string; handled: boolean };

export function openInBrowser(sessionId: string | null, url: string): boolean {
  const detail: Detail = { sessionId, url, handled: false };
  window.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail }));
  return detail.handled;
}

// onOpen: 開いたら true を返す
export function useOpenInBrowser(onOpen: (sessionId: string | null, url: string) => boolean): void {
  const handler = useRef(onOpen);
  handler.current = onOpen;
  useEffect(() => {
    const listener = (e: Event) => {
      const { detail } = e as CustomEvent<Detail>;
      if (handler.current(detail.sessionId, detail.url)) detail.handled = true;
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}
