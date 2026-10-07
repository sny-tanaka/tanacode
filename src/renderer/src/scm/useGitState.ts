import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitState } from '@shared/ipc';

const POLL_MS = 5000;

// 選択中のセッションのフォルダの git の状態。ファイルの変更・ウィンドウのフォーカス・一定間隔で読み直す
export function useGitState(sessionId: string | null, root: string | null): { state: GitState | null; refresh: () => void } {
  const [state, setState] = useState<GitState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // いま見ているビュー。読み直しの返事が来るまでにビューが変わっていたら、前のビューの結果なので入れない
  const current = useRef(sessionId);
  current.current = sessionId;

  // 5 秒ごとに読み直すので、変わっていなければ入れ替えない（入れ替えると App 全体とエディタの差分表示が作り直される）
  const update = useCallback((next: GitState) => setState((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)), []);
  const refresh = useCallback(() => {
    if (!sessionId) return;
    const apply = (next: GitState) => {
      if (current.current === sessionId) update(next);
    };
    void window.tanacode.git.state(sessionId).then(apply, () => apply({ isRepo: false }));
  }, [sessionId, update]);

  useEffect(() => {
    setState(null);
    refresh();
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 300);
    };
    const offFiles = window.tanacode.workspace.onFilesChanged((p) => p.root === root && later());
    const interval = setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      offFiles();
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh, root]);

  return { state, refresh };
}

// エクスプローラーに出す git の状態（ファイル名の色）
export type GitMark = 'modified' | 'added' | 'untracked' | 'deleted' | 'conflict';

export function gitMarks(state: GitState | null): Record<string, GitMark> {
  if (!state?.isRepo) return {};
  const marks: Record<string, GitMark> = {};
  for (const e of state.entries) {
    const code = `${e.index}${e.worktree}`;
    marks[e.path] = code.includes('U') || code === 'AA' || code === 'DD'
      ? 'conflict'
      : e.index === '?'
        ? 'untracked'
        : code.includes('D')
          ? 'deleted'
          : e.index === 'A'
            ? 'added'
            : 'modified';
  }
  return marks;
}
