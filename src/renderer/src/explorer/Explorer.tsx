import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry } from '@shared/ipc';
import type { FileKnowledge } from '@shared/knowledge';
import type { FileChange } from '@shared/ipc';
import { t } from '@shared/i18n';
import type { GitMark } from '../scm/useGitState';
import { CloseIcon, DisclosureIcon, IconButton } from '../icons';

type Props = {
  sessionId: string;
  root: string;
  rootName: string;
  activePath: string | null;
  // このブランチで変わったファイル（基点 ↔ 作業ツリー）
  changes: Record<string, FileChange>;
  // このセッションで Claude が読んだ・書いたファイル（行頭の点）。追加したフォルダの中のものは絶対パス
  knowledge: Record<string, FileKnowledge>;
  // git の状態（ファイル名の色）。Claude Code の変更マーク（右端の文字）とは別に出す
  gitMarks: Record<string, GitMark>;
  onOpenFile: (path: string) => void;
  // ワークスペースに追加したフォルダ（絶対パス）。root の下に、1 つずつツリーを並べる
  folders?: string[];
  // 追加したフォルダを外す。無ければ外すボタンを出さない（アーカイブしたセッション）
  onRemoveFolder?: (folder: string) => void;
};

const NO_FOLDERS: string[] = [];
const NO_CHANGES: Record<string, FileChange> = {};
const NO_MARKS: Record<string, GitMark> = {};

// App はチャットのイベントなどで頻繁に描き直されるので、props が変わったときだけ描き直す
export const Explorer = memo(function Explorer({
  sessionId,
  root,
  rootName,
  activePath,
  changes,
  knowledge,
  gitMarks,
  onOpenFile,
  folders = NO_FOLDERS,
  onRemoveFolder,
}: Props) {
  return (
    <div className="tree">
      <RootTree
        sessionId={sessionId}
        root={root}
        base=""
        name={rootName}
        activePath={activePath}
        changes={changes}
        knowledge={knowledge}
        gitMarks={gitMarks}
        onOpenFile={onOpenFile}
      />
      {/* 追加したフォルダの git の状態と、ブランチの変更は出さない（ソース管理は、セッションのフォルダのリポジトリだけを扱う） */}
      {folders.map((folder) => (
        <RootTree
          key={folder}
          sessionId={sessionId}
          root={folder}
          base={folder}
          name={baseName(folder)}
          activePath={activePath}
          changes={NO_CHANGES}
          knowledge={knowledge}
          gitMarks={NO_MARKS}
          onOpenFile={onOpenFile}
          onRemove={onRemoveFolder && (() => onRemoveFolder(folder))}
        />
      ))}
    </div>
  );
});

type RootProps = Omit<Props, 'rootName' | 'folders' | 'onRemoveFolder'> & {
  // ツリーの行のパスの頭。セッションのフォルダは ''（相対パス）、追加したフォルダは、そのフォルダの絶対パス（行も絶対パスで持つ）
  base: string;
  name: string;
  onRemove?: () => void;
};

// 1 つのフォルダのツリー。フォルダのパス（base からのもの）を鍵に、開いたフォルダの中身だけを読む
function RootTree({ sessionId, root, base, name, activePath, changes, knowledge, gitMarks, onOpenFile, onRemove }: RootProps) {
  const [children, setChildren] = useState(new Map<string, DirEntry[]>());
  const [expanded, setExpanded] = useState(new Set<string>([base]));
  const childrenRef = useRef(children);
  childrenRef.current = children;
  // root からの相対パスを、ツリーの行のパスにする
  const pathOf = useCallback((rel: string) => (base ? `${base}/${rel}` : rel), [base]);

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
    void load(base);
  }, [load, base]);

  // ファイルの追加・削除を反映するため、変更があった場所の親フォルダを読み直す
  useEffect(
    () =>
      window.tanacode.workspace.onFilesChanged((payload) => {
        if (payload.root !== root) return;
        const dirs = new Set<string>();
        for (const rel of payload.paths) {
          const path = pathOf(rel);
          dirs.add(parentOf(path));
          dirs.add(path);
        }
        dirs.forEach((dir) => {
          if (childrenRef.current.has(dir)) void load(dir);
        });
      }),
    [root, pathOf, load],
  );

  // 開いたファイルがツリーで見えるよう、親フォルダを展開する
  useEffect(() => {
    if (!activePath) return;
    // セッションのフォルダのツリーでは、絶対パスはフォルダの外のファイル。追加したフォルダのツリーでは、その中の絶対パスだけ
    if (base ? !activePath.startsWith(`${base}/`) : activePath.startsWith('/')) return;
    const parts = (base ? activePath.slice(base.length + 1) : activePath).split('/').slice(0, -1);
    const ancestors = parts.map((_, i) => pathOf(parts.slice(0, i + 1).join('/')));
    setExpanded((prev) => (ancestors.every((dir) => prev.has(dir)) ? prev : new Set([...prev, ...ancestors])));
    ancestors.forEach((dir) => {
      if (!childrenRef.current.has(dir)) void load(dir);
    });
  }, [activePath, base, pathOf, load]);

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
    <>
      <div className={`tree-row dir${onRemove ? ' reveal-host' : ''}`} style={{ paddingLeft: 10 }} onClick={() => toggle(base)} title={base || undefined}>
        <span className="tree-chevron">
          <DisclosureIcon open={expanded.has(base)} />
        </span>
        <span className="tree-label">{name}</span>
        <span className="tree-fill" />
        {onRemove && (
          <IconButton
            reveal
            size="sm"
            icon={CloseIcon}
            label={t('explorer.tree.removeFolder')}
            tip={t('explorer.tree.removeFolderTip')}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          />
        )}
      </div>
      {expanded.has(base) && renderDir(base, 1)}
    </>
  );
}

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

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
