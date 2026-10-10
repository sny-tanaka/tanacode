import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry } from '@shared/ipc';
import type { FileKnowledge } from '@shared/knowledge';
import type { FileChange } from '@shared/ipc';
import { t } from '@shared/i18n';
import type { GitMark } from '../scm/useGitState';
import { DisclosureIcon } from '../icons';

type Props = {
  sessionId: string;
  root: string;
  rootName: string;
  activePath: string | null;
  // このブランチで変わったファイル（基点 ↔ 作業ツリー）
  changes: Record<string, FileChange>;
  // このセッションで Claude が読んだ・書いたファイル（行頭の点）
  knowledge: Record<string, FileKnowledge>;
  // git の状態（ファイル名の色）。Claude Code の変更マーク（右端の文字）とは別に出す
  gitMarks: Record<string, GitMark>;
  onOpenFile: (path: string) => void;
};

// App はチャットのイベントなどで頻繁に描き直されるので、props が変わったときだけ描き直す
export const Explorer = memo(function Explorer({ sessionId, root, rootName, activePath, changes, knowledge, gitMarks, onOpenFile }: Props) {
  const [children, setChildren] = useState(new Map<string, DirEntry[]>());
  const [expanded, setExpanded] = useState(new Set<string>(['']));
  const childrenRef = useRef(children);
  childrenRef.current = children;

  const load = useCallback(
    async (dir: string) => {
      const entries = await window.tanacode.workspace.listDir(sessionId, dir).catch(() => null);
      setChildren((prev) => {
        const next = new Map(prev);
        if (entries) next.set(dir, entries);
        else next.delete(dir);
        return next;
      });
    },
    [sessionId],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  // ファイルの追加・削除を反映するため、変更があった場所の親フォルダを読み直す
  useEffect(
    () =>
      window.tanacode.workspace.onFilesChanged((payload) => {
        if (payload.root !== root) return;
        const dirs = new Set<string>();
        for (const path of payload.paths) {
          dirs.add(parentOf(path));
          dirs.add(path);
        }
        dirs.forEach((dir) => {
          if (childrenRef.current.has(dir)) void load(dir);
        });
      }),
    [root, load],
  );

  // 開いたファイルがツリーで見えるよう、親フォルダを展開する
  useEffect(() => {
    // 絶対パスはフォルダの外のファイル（ツリーには無い）
    if (!activePath || activePath.startsWith('/')) return;
    const parts = activePath.split('/').slice(0, -1);
    const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    setExpanded((prev) => (ancestors.every((dir) => prev.has(dir)) ? prev : new Set([...prev, ...ancestors])));
    ancestors.forEach((dir) => {
      if (!childrenRef.current.has(dir)) void load(dir);
    });
  }, [activePath, load]);

  // 変更のあるファイルを含むフォルダ
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of Object.keys(changes)) {
      for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) dirs.add(dir);
    }
    return dirs;
  }, [changes]);

  // git の変更のあるファイルを含むフォルダ（行ごとに全部の変更を調べ直さないよう、先に集めておく）
  const gitDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of Object.keys(gitMarks)) {
      for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) dirs.add(dir);
    }
    return dirs;
  }, [gitMarks]);

  const toggle = (dir: string) => {
    const willOpen = !expanded.has(dir);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(dir);
      else next.delete(dir);
      return next;
    });
    if (willOpen && !children.has(dir)) void load(dir);
  };

  const renderDir = (dir: string, depth: number): React.ReactNode =>
    children.get(dir)?.map((entry) => {
      const change = entry.isDir ? undefined : changes[entry.path];
      return (
        <div key={entry.path}>
          <div
            className={`tree-row${entry.path === activePath ? ' active' : ''}${entry.isDir ? ' dir' : ''}`}
            style={{ paddingLeft: 10 + depth * 12 }}
            onClick={() => (entry.isDir ? toggle(entry.path) : onOpenFile(entry.path))}
            title={entry.path}
          >
            <span className="tree-chevron">
              {entry.isDir ? <DisclosureIcon open={expanded.has(entry.path)} /> : knowledge[entry.path] && <KnowledgeDot state={knowledge[entry.path]} />}
            </span>
            <span className={`tree-label${gitMark(entry, gitMarks)}`}>{entry.name}</span>
            {entry.isDir && gitDirs.has(entry.path) && <span className="tree-git-dot" title={t('explorer.tree.gitChangesInside')} />}
            <span className="tree-fill" />
            {change && (
              <span className="tree-mark" title={change.kind === 'added' ? t('explorer.tree.addedInBranch') : t('explorer.tree.modifiedInBranch')}>
                {change.kind === 'added' ? 'A' : 'M'}
              </span>
            )}
            {entry.isDir && changedDirs.has(entry.path) && <span className="tree-dir-mark" />}
          </div>
          {entry.isDir && expanded.has(entry.path) && renderDir(entry.path, depth + 1)}
        </div>
      );
    });

  return (
    <div className="tree">
        <div className="tree-row dir" style={{ paddingLeft: 10 }} onClick={() => toggle('')}>
          <span className="tree-chevron">
            <DisclosureIcon open={expanded.has('')} />
          </span>
          <span className="tree-label">{rootName}</span>
          <span className="tree-fill" />
        </div>
        {expanded.has('') && renderDir('', 1)}
    </div>
  );
});

function KnowledgeDot({ state }: { state: FileKnowledge }) {
  return <span className={`tree-know ${state}`} title={t(`explorer.knowledge.${state}`)} />;
}

// 名前の色を変えるのはファイルだけ。フォルダは名前の右に点を出す（gitDirs）
function gitMark(entry: DirEntry, marks: Record<string, GitMark>): string {
  return !entry.isDir && marks[entry.path] ? ` git-${marks[entry.path]}` : '';
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
