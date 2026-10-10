import { useCallback, useState } from 'react';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';

// ソース管理の変更の見せ方。list: ファイルの一覧 / tree: フォルダごとのツリー
export type ScmView = 'list' | 'tree';

const STORAGE_KEY = 'tanacode.scmView';

function load(): ScmView {
  return readSharedPref(STORAGE_KEY) === 'tree' ? 'tree' : 'list';
}

// 見せ方は次回起動時も保つ。どのプロファイルの画面でも同じにする（sharedPrefs）
export function useScmView(): [ScmView, (view: ScmView) => void] {
  const [view, setView] = useState<ScmView>(load);
  const change = useCallback((next: ScmView) => {
    setView(next);
    writeSharedPref(STORAGE_KEY, next);
  }, []);
  useSharedPrefChange(STORAGE_KEY, () => setView(load()));
  return [view, change];
}
