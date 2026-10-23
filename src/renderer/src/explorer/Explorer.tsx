import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry } from '@shared/ipc';
import type { FileKnowledge } from '@shared/knowledge';
import type { FileChange } from '@shared/ipc';
import { t } from '@shared/i18n';
import type { GitMark } from '../scm/useGitState';
import { CloseIcon, DisclosureIcon, IconButton } from '../icons';
import { errorMessage } from '../errorMessage';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

// ファイル操作（名前の変更・ゴミ箱）に合わせて、開いているタブを直すもの（App）。path はツリーの行のパス（そのものと、その中のファイル）
export type ExplorerFileOps = {
  // 名前を変える前に、保存していない変更を保存する（人に確かめる）。やめた・保存できなかったら false
  beforeRename(path: string): Promise<boolean>;
  // 名前を変えた。タブのパスを差し替える
  renamed(from: string, to: string): void;
  // 保存していない変更のあるタブがあるか（ゴミ箱に入れる前の確認の文を変える）
  hasUnsaved(path: string): boolean;
  // ゴミ箱に入れた。保存していない変更の無いタブを閉じる（あるタブは、開いたまま残す）
  trashed(path: string): void;
};

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
  // ファイル操作。無ければ、右クリックのメニューにはパスのコピーと Finder で表示だけを出す（アーカイブしたセッション）
  fileOps?: ExplorerFileOps;
};

// 右クリックした行。path はツリーの行のパス（フォルダそのものの行は base）
type MenuState = { base: string; path: string; isDir: boolean; isRoot: boolean; x: number; y: number };
// ツリーの行の中で名前を入れているもの（新規作成は dir の中に行を足し、名前の変更は path の行で入れる）
type EditState = { base: string; kind: 'file' | 'dir'; dir: string } | { base: string; kind: 'rename'; path: string };

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
  fileOps,
}: Props) {
  // メニューと名前を入れる行は、ツリーをまたいで一度に 1 つだけ
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const shared = { fileOps, menu, onMenu: setMenu, onCloseMenu: closeMenu, editing, onEdit: setEditing };
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
        {...shared}
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
          {...shared}
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
  // 右クリックのメニューと、名前を入れている行（どのツリーのものかは base で分ける）
  menu: MenuState | null;
  onMenu: (menu: MenuState) => void;
  onCloseMenu: () => void;
  editing: EditState | null;
  onEdit: (editing: EditState | null) => void;
};

// 1 つのフォルダのツリー。フォルダのパス（base からのもの）を鍵に、開いたフォルダの中身だけを読む
function RootTree({
  sessionId,
  root,
  base,
  name,
  activePath,
  changes,
  knowledge,
  gitMarks,
  onOpenFile,
  onRemove,
  fileOps,
  menu: anyMenu,
  onMenu,
  onCloseMenu,
  editing: anyEditing,
  onEdit,
}: RootProps) {
  const [children, setChildren] = useState(new Map<string, DirEntry[]>());
  const [expanded, setExpanded] = useState(new Set<string>([base]));
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const menu = anyMenu?.base === base ? anyMenu : null;
  const editing = anyEditing?.base === base ? anyEditing : null;
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

  // 行のパスの絶対パスと、このツリーのフォルダからの相対パス
  const absOf = (path: string) => (base ? path : path ? `${root}/${path}` : root);
  const relOf = (path: string) => (base ? path.slice(base.length + 1) : path);

  const openMenu = (e: React.MouseEvent, target: Pick<MenuState, 'path' | 'isDir' | 'isRoot'>) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu({ ...target, base, x: e.clientX, y: e.clientY });
  };

  // 新規作成は、フォルダの中（ファイルの行なら、入っているフォルダ）に名前を入れる行を出す。フォルダは開いておく
  const startCreate = (kind: 'file' | 'dir', dir: string) => {
    setExpanded((prev) => (prev.has(dir) ? prev : new Set([...prev, dir])));
    if (!children.has(dir)) void load(dir);
    onEdit({ base, kind, dir });
  };

  const trash = async (path: string) => {
    if (!fileOps) return;
    const message = fileOps.hasUnsaved(path) ? 'explorer.confirm.trashUnsaved' : 'explorer.confirm.trash';
    if (!window.confirm(t(message, { name: baseName(path) }))) return;
    try {
      await window.tanacode.workspace.trashEntry(sessionId, path);
    } catch (error) {
      window.alert(errorMessage(error));
      return;
    }
    void load(parentOf(path));
    fileOps.trashed(path);
  };

  // 入れた名前で作る・変える。できなかったら理由を返す（名前を入れる欄に出す）
  const commitEdit = async (value: string): Promise<string | null> => {
    if (!editing || !fileOps) return null;
    try {
      if (editing.kind === 'rename') {
        const from = editing.path;
        if (!(await fileOps.beforeRename(from))) {
          onEdit(null);
          return null;
        }
        const to = await window.tanacode.workspace.renameEntry(sessionId, from, value);
        onEdit(null);
        // 開いていたフォルダの名前を変えたら、中の開き具合も新しいパスに移す
        const moved = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
        setExpanded((prev) => new Set([...prev].map(moved)));
        setChildren((prev) => new Map([...prev].filter(([dir]) => dir !== from && !dir.startsWith(`${from}/`))));
        void load(parentOf(from));
        if (expanded.has(from)) void load(to);
        fileOps.renamed(from, to);
      } else {
        const path = await window.tanacode.workspace.createEntry(sessionId, editing.dir, value, editing.kind);
        onEdit(null);
        await load(editing.dir);
        if (editing.kind === 'file') onOpenFile(path);
      }
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  };

  const menuItems = (target: MenuState): ContextMenuItem[] => {
    const dir = target.isDir ? target.path : parentOf(target.path);
    const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
    return [
      ...(fileOps
        ? [
            { label: t('explorer.menu.newFile'), onSelect: () => startCreate('file', dir) },
            { label: t('explorer.menu.newFolder'), onSelect: () => startCreate('dir', dir) },
            'separator' as const,
          ]
        : []),
      // フォルダそのもの（ツリーのいちばん上の行）は、名前を変えたりゴミ箱に入れたりしない
      ...(fileOps && !target.isRoot
        ? [
            { label: t('explorer.menu.rename'), onSelect: () => onEdit({ base, kind: 'rename', path: target.path }) },
            { label: t('explorer.menu.trash'), onSelect: () => void trash(target.path), danger: true },
            'separator' as const,
          ]
        : []),
      { label: t('explorer.menu.copyPath'), onSelect: () => copy(absOf(target.path)) },
      ...(target.isRoot ? [] : [{ label: t('explorer.menu.copyRelativePath'), onSelect: () => copy(relOf(target.path)) }]),
      'separator',
      { label: t('explorer.menu.reveal'), onSelect: () => void window.tanacode.workspace.revealFile(sessionId, absOf(target.path)).catch(() => {}) },
    ];
  };

  const nameInput = (initial: string, isDir: boolean) => (
    <NameInput initial={initial} isDir={isDir} onCommit={commitEdit} onCancel={() => onEdit(null)} />
  );

  const renderDir = (dir: string, depth: number): React.ReactNode => (
    <>
      {editing && editing.kind !== 'rename' && editing.dir === dir && (
        <div className="tree-row editing" style={{ paddingLeft: 10 + depth * 12 }}>
          <span className="tree-chevron">{editing.kind === 'dir' && <DisclosureIcon open={false} />}</span>
          {nameInput('', editing.kind === 'dir')}
        </div>
      )}
      {children.get(dir)?.map((entry) => {
        const change = entry.isDir ? undefined : changes[entry.path];
        const renaming = editing?.kind === 'rename' && editing.path === entry.path;
        return (
          <div key={entry.path}>
            <div
              className={`tree-row${entry.path === activePath ? ' active' : ''}${entry.isDir ? ' dir' : ''}${menu?.path === entry.path ? ' menu-target' : ''}`}
              style={{ paddingLeft: 10 + depth * 12 }}
              onClick={() => {
                if (renaming) return;
                if (entry.isDir) toggle(entry.path);
                else onOpenFile(entry.path);
              }}
              onContextMenu={(e) => openMenu(e, { path: entry.path, isDir: entry.isDir, isRoot: false })}
              title={entry.path}
            >
              <span className="tree-chevron">
                {entry.isDir ? <DisclosureIcon open={expanded.has(entry.path)} /> : knowledge[entry.path] && <KnowledgeDot state={knowledge[entry.path]} />}
              </span>
              {renaming ? nameInput(entry.name, entry.isDir) : <span className={`tree-label${gitMark(entry, gitMarks)}`}>{entry.name}</span>}
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
      })}
    </>
  );

  return (
    <>
      <div
        className={`tree-row dir${onRemove ? ' reveal-host' : ''}${menu?.isRoot ? ' menu-target' : ''}`}
        style={{ paddingLeft: 10 }}
        onClick={() => toggle(base)}
        onContextMenu={(e) => openMenu(e, { path: base, isDir: true, isRoot: true })}
        title={base || undefined}
      >
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
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={onCloseMenu} />}
    </>
  );
}

// ツリーの行の中で名前を入れる欄。Enter で決め、Esc でやめる。ほかを押して離れたときも決める（空か、元の名前のままならやめる）。
// 決められなかったら、理由を欄の下に出して入れ直させる（離れたときは、理由を知らせてやめる）
function NameInput({
  initial,
  isDir,
  onCommit,
  onCancel,
}: {
  initial: string;
  isDir: boolean;
  onCommit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  // 決めている間と、決めた・やめたあと（欄が消えるときの blur で、もう一度決めないように）
  const done = useRef(false);

  // ファイルの名前を変えるときは、拡張子の前までを選んでおく
  useEffect(() => {
    const input = ref.current!;
    input.focus();
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, !isDir && dot > 0 ? dot : initial.length);
  }, [initial, isDir]);

  const commit = async (leaving: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (!name || name === initial) return onCancel();
    const failure = await onCommit(name);
    if (!failure) return;
    if (leaving) {
      window.alert(failure);
      return onCancel();
    }
    done.current = false;
    setError(failure);
  };

  return (
    <span className="tree-input-wrap" onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className={`tree-input${error ? ' invalid' : ''}`}
        value={value}
        spellCheck={false}
        aria-invalid={!!error}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            done.current = true;
            onCancel();
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commit(false);
        }}
        onBlur={() => void commit(true)}
      />
      {error && <span className="tree-input-error">{error}</span>}
    </span>
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
