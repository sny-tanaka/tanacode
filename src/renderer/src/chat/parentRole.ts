import { useEffect, useState } from 'react';
import { PARENT_INSTRUCTIONS_FILE } from '@shared/project-instructions';

// 「親にする」で読ませる TANACODE_PARENT.md のパス（無ければ null。調べ終えるまでは undefined）。
// find: main に聞く（セッションなら sessions.parentInstructions、新規セッションの画面ならフォルダの folders.parentInstructions）。key が変わったとき・
// そのファイルが変わったとき（エクスプローラーの見張りの知らせ）・ウインドウに戻ったとき（見張っていない元のリポジトリに置いたときなど）に調べ直す
export function useParentInstructions(key: string | null, find: (key: string) => Promise<string | null>): string | null | undefined {
  const [path, setPath] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setPath(undefined);
    if (!key) return;
    let alive = true;
    const check = () => {
      void find(key).then(
        (found) => alive && setPath(found ?? null),
        () => alive && setPath(null),
      );
    };
    check();
    const offFiles = window.tanacode.workspace.onFilesChanged(({ paths }) => {
      if (paths.some((p) => p.split('/').pop() === PARENT_INSTRUCTIONS_FILE)) check();
    });
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      offFiles();
      window.removeEventListener('focus', check);
    };
    // find は呼ぶたびに作り直されても、同じ key なら同じものを聞く
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return path;
}
