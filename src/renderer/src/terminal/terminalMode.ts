import { useCallback, useState } from 'react';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';

const STORAGE_KEY = 'tanacode.terminalMode';

function load(): boolean {
  return readSharedPref(STORAGE_KEY) === 'on';
}

// ターミナルモード（Claude Code ペインに、チャットの代わりに Claude Code そのものの画面を出す）にしているか。
// どのセッションにも効き、次回起動時も保つ。どのプロファイルの画面でも同じにする（sharedPrefs）
export function useTerminalMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(load);
  const change = useCallback((next: boolean) => {
    setOn(next);
    writeSharedPref(STORAGE_KEY, next ? 'on' : 'off');
  }, []);
  useSharedPrefChange(STORAGE_KEY, () => setOn(load()));
  return [on, change];
}
