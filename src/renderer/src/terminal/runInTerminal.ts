import { useEffect, useRef } from 'react';

// チャットなどから、セッションのターミナルパネルでコマンドを実行する（新しいシェルのタブで動かす）。
// sessionId が null なら、今見ているもの（セッションか、新規セッションの画面のフォルダ）のターミナルで。実行できたら true
const EVENT = 'tanacode:run-in-terminal';
type Detail = { sessionId: string | null; command: string; handled: boolean };

export function runInTerminal(sessionId: string | null, command: string): boolean {
  const detail: Detail = { sessionId, command, handled: false };
  window.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail }));
  return detail.handled;
}

// onRun: 実行したら true を返す
export function useRunInTerminal(onRun: (sessionId: string | null, command: string) => boolean): void {
  const handler = useRef(onRun);
  handler.current = onRun;
  useEffect(() => {
    const listener = (e: Event) => {
      const { detail } = e as CustomEvent<Detail>;
      if (handler.current(detail.sessionId, detail.command)) detail.handled = true;
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}
