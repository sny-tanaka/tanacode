import { useEffect, useRef } from 'react';

// チャットなどから、セッションのターミナルパネルでコマンドを実行する（新しいシェルのタブで動かす）
const EVENT = 'tanacode:run-in-terminal';
type Detail = { sessionId: string; command: string };

export function runInTerminal(sessionId: string, command: string): void {
  window.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail: { sessionId, command } }));
}

export function useRunInTerminal(onRun: (sessionId: string, command: string) => void): void {
  const handler = useRef(onRun);
  handler.current = onRun;
  useEffect(() => {
    const listener = (e: Event) => {
      const { detail } = e as CustomEvent<Detail>;
      handler.current(detail.sessionId, detail.command);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}
