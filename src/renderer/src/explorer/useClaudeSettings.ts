import { useEffect, useState } from 'react';
import type { ClaudeSettingsFile } from '@shared/ipc';

const NONE: ClaudeSettingsFile[] = [];

// id（セッションか、新規セッションの画面のフォルダ）で Claude Code が読み込む設定ファイル。ファイルを足した・消したことに気づけるよう、
// フォルダの .claude の中が変わったときと、窓に戻ったとき（ホームの設定は監視していない）に読み直す。
// settingsFile: セッションで選んでいる登録した設定ファイル（変えたら読み直す）
export function useClaudeSettings(id: string | null, cwd: string | null, settingsFile: string | null): ClaudeSettingsFile[] {
  const [files, setFiles] = useState(NONE);
  useEffect(() => {
    if (!id) {
      setFiles(NONE);
      return;
    }
    let alive = true;
    const load = () =>
      void window.tanacode.workspace
        .claudeSettings(id)
        .then((next) => alive && setFiles((prev) => (sameFiles(prev, next) ? prev : next)))
        .catch(() => {});
    load();
    const off = window.tanacode.workspace.onFilesChanged(({ root, paths }) => {
      if (root === cwd && paths.some((path) => path === '.claude' || path.startsWith('.claude/'))) load();
    });
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      off();
      window.removeEventListener('focus', load);
    };
  }, [id, cwd, settingsFile]);
  return files;
}

function sameFiles(a: ClaudeSettingsFile[], b: ClaudeSettingsFile[]): boolean {
  return a.length === b.length && a.every((file, i) => file.path === b[i].path && file.scope === b[i].scope);
}
