import { useCallback, useEffect, useState } from 'react';
import { parseHiddenFolders, type HiddenFolders } from '@shared/recent-folders';

// 最近のフォルダから外したフォルダ（このマシンだけの好みなので localStorage に置く）
const KEY = 'tanacode.hiddenFolders';

function load(): HiddenFolders {
  try {
    return parseHiddenFolders(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

// 外したフォルダと、外す関数。外した時刻を覚え、それより新しいセッションができたら、フォルダは最近のフォルダに戻る
export function useHiddenFolders(): [HiddenFolders, (dir: string) => void] {
  const [hidden, setHidden] = useState<HiddenFolders>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(hidden));
    } catch {
      // 覚えられなくても、この起動の間は外れたまま
    }
  }, [hidden]);

  const hide = useCallback((dir: string) => {
    const at = Date.now();
    setHidden((prev) => ({ ...prev, [dir]: at }));
  }, []);

  return [hidden, hide];
}
