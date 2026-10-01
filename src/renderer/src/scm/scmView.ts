import { useCallback, useState } from 'react';

// ソース管理の変更の見せ方。list: ファイルの一覧 / tree: フォルダごとのツリー
export type ScmView = 'list' | 'tree';

const STORAGE_KEY = 'tanacode.scmView';

function load(): ScmView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'tree' ? 'tree' : 'list';
  } catch {
    return 'list';
  }
}

// 見せ方は次回起動時も保つ（このマシンだけの表示設定なので localStorage に置く）
export function useScmView(): [ScmView, (view: ScmView) => void] {
  const [view, setView] = useState<ScmView>(load);
  const change = useCallback((next: ScmView) => {
    setView(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 保存できなくても今の表示には影響しない
    }
  }, []);
  return [view, change];
}
