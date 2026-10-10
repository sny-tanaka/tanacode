import { useCallback, useState } from 'react';

const STORAGE_KEY = 'tanacode.terminalMode';

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

// ターミナルモード（Claude Code ペインに、チャットの代わりに Claude Code そのものの画面を出す）にしているか。
// どのセッションにも効き、次回起動時も保つ（このマシンだけの表示設定なので localStorage に置く）
export function useTerminalMode(): [boolean, (on: boolean | ((prev: boolean) => boolean)) => void] {
  const [on, setOn] = useState(load);
  const change = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setOn((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      try {
        localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
      } catch {
        // 保存できなくても今の表示には影響しない
      }
      return value;
    });
  }, []);
  return [on, change];
}
