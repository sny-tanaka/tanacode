import { Fragment, memo, useEffect, useState } from 'react';
import type { BranchChanges, FileChange, GitAction, GitBranches, GitEntry, GitState } from '@shared/ipc';
import { buildTree, filesInTreeOrder, visibleRows } from '@shared/scm-tree';
import { CommentList } from '../review/CommentList';
import type { ReviewComment } from '../review/LineComments';
import { Busy } from '../layout/Busy';
import {
  AddIcon,
  BranchIcon,
  ChevronDownIcon,
  CommitIcon,
  DefaultBranchIcon,
  DisclosureIcon,
  FetchIcon,
  IconButton,
  ListViewIcon,
  MinusIcon,
  PullIcon,
  PushIcon,
  TreeViewIcon,
  UndoIcon,
  WalkthroughIcon,
  type IconComponent,
} from '../icons';
import type { ScmView } from './scmView';

type Props = {
  sessionId: string;
  state: GitState | null;
  // 変更の見せ方（ファイルの一覧 / フォルダごとのツリー）。ステージ済みの変更・変更・ブランチの変更のすべてに効く
  view: ScmView;
  onViewChange: (view: ScmView) => void;
  onRefresh: () => void;
  onOpenDiff: (path: string, staged: boolean) => void;
  // ブランチの変更（基点 ↔ 作業ツリー）の差分を開く。activeBranchPath は開いているもの
  onOpenBranchDiff: (path: string) => void;
  activeBranchPath: string | null;
  comments: ReviewComment[];
  onShowComment: (comment: ReviewComment) => void;
  onRemoveComment: (id: string) => void;
  // 「ブランチの変更」の「Claude にウォークスルーしてもらう」（セッションを見ているときだけ）
  onWalkthrough?: () => void;
};

// VSCode のソース管理のように、変更の確認・ステージ・コミット・プッシュ・プル・ブランチの切り替えをする。
// 先頭の「ブランチの変更」は、ローカルだけのプルリクエストのように、コミット済みも含めたブランチ全体の変更を出す
// App はチャットのイベントなどで頻繁に描き直されるので、props が変わったときだけ描き直す
export const ScmPanel = memo(function ScmPanel({
  sessionId,
  state,
  view,
  onViewChange,
  onRefresh,
  onOpenDiff,
  onOpenBranchDiff,
  activeBranchPath,
  comments,
  onShowComment,
  onRemoveComment,
  onWalkthrough,
}: Props) {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchMenu, setBranchMenu] = useState<GitBranches | null>(null);

  // amend を選んだら直前のコミットメッセージを入れる
  useEffect(() => {
    if (amend && !message) void window.tanacode.git.lastCommitMessage(sessionId).then(setMessage);
  }, [amend]);

  const run = async (action: GitAction, label: string) => {
    setBusy(label);
    setError(null);
    const err = await window.tanacode.git.run(sessionId, action);
    setBusy(null);
    if (err) setError(err);
    onRefresh();
    return !err;
  };

  if (!state)
    return (
      <div className="scm-empty">
        <Busy>読み込み中…</Busy>
      </div>
    );
  if (!state.isRepo) return <div className="scm-empty">このフォルダは git リポジトリではありません</div>;

  const staged = state.entries.filter((e) => e.index !== ' ' && e.index !== '?');
  const changes = state.entries.filter((e) => e.worktree !== ' ' || e.index === '?');
  const commit = async () => {
    if (staged.length === 0 && !amend) {
      setError('コミットする変更がステージされていません');
      return;
    }
    if (await run({ kind: 'commit', message, amend }, 'コミット中…')) {
      setMessage('');
      setAmend(false);
    }
  };

  return (
    <div className="scm-panel">
      <div className="scm-branch-row">
        <button
          className="scm-branch"
          onClick={() =>
            branchMenu ? setBranchMenu(null) : void window.tanacode.git.branches(sessionId).then(setBranchMenu)
          }
          title="ブランチを切り替える"
        >
          <span className="scm-branch-icon">
            <BranchIcon size={14} />
          </span>
          {state.branch ?? '(detached)'}
          <span className="tree-chevron">
            <ChevronDownIcon size={12} />
          </span>
        </button>
        <div className="spacer" />
        {/* 押すと切り替わる先のアイコンと名前を出す（VS Code と同じ） */}
        <IconButton
          icon={view === 'tree' ? ListViewIcon : TreeViewIcon}
          label={view === 'tree' ? '一覧で表示' : 'ツリーで表示'}
          onClick={() => onViewChange(view === 'tree' ? 'list' : 'tree')}
        />
        <button className="scm-sync" disabled={!!busy} onClick={() => void run({ kind: 'pull' }, 'プル中…')} data-tip={state.upstream ? `${state.upstream} からプル` : 'プル'} aria-label="プル">
          <PullIcon size={14} />
          {state.behind || ''}
        </button>
        <button className="scm-sync" disabled={!!busy || state.empty} onClick={() => void run({ kind: 'push' }, 'プッシュ中…')} data-tip={state.upstream ? `${state.upstream} へプッシュ` : 'origin にプッシュ（上流を設定）'} aria-label="プッシュ">
          <PushIcon size={14} />
          {state.ahead || ''}
        </button>
        <IconButton icon={FetchIcon} label="フェッチ" disabled={!!busy} onClick={() => void run({ kind: 'fetch' }, 'フェッチ中…')} />
      </div>
      {branchMenu && (
        <BranchMenu
          branches={branchMenu}
          current={state.branch}
          onPick={(branch, mode) => {
            setBranchMenu(null);
            void run({ kind: 'checkout', branch, mode }, '切り替え中…');
          }}
          onSwitchDefault={() => {
            setBranchMenu(null);
            void run({ kind: 'switch-default' }, '最新のデフォルトブランチへ切り替え中…');
          }}
          onClose={() => setBranchMenu(null)}
        />
      )}

      <div className="scm-commit">
        <textarea
          value={message}
          rows={2}
          placeholder={`メッセージ（⌘Enter でコミット · ${state.branch ?? 'HEAD'}）`}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <div className="scm-commit-row">
          <label className="scm-amend">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
            直前のコミットを修正
          </label>
          <IconButton primary icon={CommitIcon} label="コミット" tip={amend ? '直前のコミットを修正（⌘Enter）' : 'コミット（⌘Enter）'} disabled={!!busy} onClick={() => void commit()} />
        </div>
      </div>
      {(busy || error) && <div className={`scm-message${error ? ' error' : ''}`}>{error ?? <Busy>{busy}</Busy>}</div>}

      <div className="scm-lists">
        {state.branchChanges && (
          <BranchSection changes={state.branchChanges} view={view} activePath={activeBranchPath} onOpen={onOpenBranchDiff} onWalkthrough={onWalkthrough} />
        )}
        <Section
          title="ステージ済みの変更"
          entries={staged}
          view={view}
          staged
          onOpen={(e) => onOpenDiff(e.path, true)}
          actions={[{ icon: MinusIcon, title: 'ステージを取り消す', run: (paths) => void run({ kind: 'unstage', paths }, '取り消し中…') }]}
        />
        <Section
          title="変更"
          entries={changes}
          view={view}
          staged={false}
          onOpen={(e) => onOpenDiff(e.path, false)}
          actions={[
            {
              icon: UndoIcon,
              title: '変更を破棄',
              danger: true,
              run: (paths) => {
                const what = paths.length === 1 ? paths[0] : `${paths.length} 件のファイル`;
                if (window.confirm(`${what} の変更を破棄しますか？（未追跡のファイルは削除されます。元に戻せません）`)) {
                  void run({ kind: 'discard', paths }, '破棄中…');
                }
              },
            },
            { icon: AddIcon, title: 'ステージする', run: (paths) => void run({ kind: 'stage', paths }, 'ステージ中…') },
          ]}
        />
        <CommentList comments={comments} onShow={onShowComment} onRemove={onRemoveComment} />
      </div>
    </div>
  );
});

const KIND_LABEL = { added: '新規', modified: '変更', deleted: '削除' } as const;
const KIND_CODE = { added: 'A', modified: 'M', deleted: 'D' } as const;

// 並べる順（一覧はパス順、ツリーは見えている順）。差分の「前へ / 次へ」もこの順で移る
export function branchPaths(changes: BranchChanges | null, view: ScmView): string[] {
  if (!changes) return [];
  const paths = Object.keys(changes.files).sort((a, b) => a.localeCompare(b));
  return view === 'tree' ? filesInTreeOrder(buildTree(paths.map((path) => ({ path })))).map((item) => item.path) : paths;
}

// ツリーの行の左の余白。フォルダは矢印から、ファイルはフォルダの名前（矢印 12px とすき間 6px のあと）に合わせて 1 段ずつ右に下げる
const TREE_INDENT = 12;
const dirPadding = (depth: number) => 10 + depth * TREE_INDENT;
const filePadding = (depth: number) => 28 + depth * TREE_INDENT;

// 変更の行を、一覧（ファイルを並べるだけ）かツリー（フォルダごと）で出す。
// ツリーでは、フォルダの行を押すと畳める。フォルダの行の操作は、フォルダの下のすべてのファイルに効く。
// renderFile の depth は、一覧では null、ツリーではフォルダの深さ（ルートの直下が 0）
function ChangeRows<T extends { path: string }>({
  items,
  view,
  actions,
  renderFile,
}: {
  items: T[];
  view: ScmView;
  actions?: Action[];
  renderFile: (item: T, depth: number | null) => React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  if (view === 'list') return items.map((item) => <Fragment key={item.path}>{renderFile(item, null)}</Fragment>);
  const toggle = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });
  return visibleRows(buildTree(items), collapsed).map(({ node, depth }) =>
    node.kind === 'file' ? (
      <Fragment key={`f:${node.path}`}>{renderFile(node.item, depth)}</Fragment>
    ) : (
      <div key={`d:${node.path}`} className="scm-row scm-dir-row reveal-host" style={{ paddingLeft: dirPadding(depth) }} onClick={() => toggle(node.path)} title={node.path}>
        <span className="tree-chevron">
          <DisclosureIcon open={!collapsed.has(node.path)} />
        </span>
        <span className="scm-dir-name">{node.name}</span>
        {actions && (
          <span className="scm-actions">
            {actions.map((a) => (
              <IconButton
                key={a.title}
                reveal
                size="sm"
                icon={a.icon}
                danger={a.danger}
                label={`${a.title}（フォルダ内すべて）`}
                onClick={(e) => {
                  e.stopPropagation();
                  a.run(node.items.map((x) => x.path));
                }}
              />
            ))}
          </span>
        )}
      </div>
    ),
  );
}

function BranchSection({
  changes,
  view,
  activePath,
  onOpen,
  onWalkthrough,
}: {
  changes: BranchChanges;
  view: ScmView;
  activePath: string | null;
  onOpen: (path: string) => void;
  onWalkthrough?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const paths = branchPaths(changes, 'list');
  const total = paths.reduce(
    (sum, p) => ({ added: sum.added + changes.files[p].added, removed: sum.removed + changes.files[p].removed }),
    { added: 0, removed: 0 },
  );
  const { base } = changes;
  const from =
    base.kind === 'branch' ? `${base.ref} から分岐したところ（${base.mergeBase.slice(0, 7)}）から` : `${base.ref} にまだ無い変更（未プッシュのコミットと作業中の変更）`;
  return (
    <div className="scm-section">
      <div className="scm-section-head" onClick={() => setOpen((v) => !v)} title={from}>
        <span className="tree-chevron">
          <DisclosureIcon open={open} />
        </span>
        <span className="scm-section-title">ブランチの変更</span>
        <span className="scm-count">{paths.length}</span>
      </div>
      {open && (
        <>
          <div className="scm-branch-base">
            <span>{base.kind === 'branch' ? `${base.ref} から` : `${base.ref} から（未プッシュ・作業中）`}</span>
            {paths.length > 0 && (
              <>
                <span className="diff-add">+{total.added}</span>
                <span className="diff-del">−{total.removed}</span>
              </>
            )}
            {paths.length > 0 && onWalkthrough && (
              <IconButton
                size="sm"
                icon={WalkthroughIcon}
                label="Claude にウォークスルーしてもらう"
                tip={'Claude にウォークスルーしてもらう\nエディタでコードを示しながら、このブランチの変更を説明します'}
                className="scm-branch-walk"
                onClick={onWalkthrough}
              />
            )}
          </div>
          {paths.length === 0 && <div className="scm-none">変更はありません</div>}
          <ChangeRows
            items={paths.map((path) => ({ path }))}
            view={view}
            renderFile={({ path }, depth) => (
              <BranchRow path={path} change={changes.files[path]} active={path === activePath} depth={depth} onOpen={onOpen} />
            )}
          />
        </>
      )}
    </div>
  );
}

// depth: ツリーでのフォルダの深さ（一覧では null。名前の右にフォルダのパスを出す）
function BranchRow({
  path,
  change,
  active,
  depth,
  onOpen,
}: {
  path: string;
  change: FileChange;
  active: boolean;
  depth: number | null;
  onOpen: (path: string) => void;
}) {
  return (
    <div
      className={`scm-row${active ? ' active' : ''}`}
      style={depth === null ? undefined : { paddingLeft: filePadding(depth) }}
      onClick={() => onOpen(path)}
      title={`${path}（${KIND_LABEL[change.kind]}）`}
    >
      <span className={`scm-name${change.kind === 'deleted' ? ' deleted' : ''}`}>{path.split('/').pop()}</span>
      {depth === null && <span className="scm-dir">{path.split('/').slice(0, -1).join('/')}</span>}
      {change.binary ? (
        <span className="review-count">バイナリ</span>
      ) : (
        <span className="review-count">
          <span className="diff-add">+{change.added}</span>
          <span className="diff-del">−{change.removed}</span>
        </span>
      )}
      <span className={`scm-code code-${KIND_CODE[change.kind]}`}>{KIND_CODE[change.kind]}</span>
    </div>
  );
}

// icon: ボタンの絵。title: ボタンの名前。danger: 元に戻せない操作（hover で赤くする）
type Action = { icon: IconComponent; title: string; danger?: boolean; run: (paths: string[]) => void };

function Section({
  title,
  entries,
  view,
  staged,
  actions,
  onOpen,
}: {
  title: string;
  entries: GitEntry[];
  view: ScmView;
  staged: boolean;
  actions: Action[];
  onOpen: (entry: GitEntry) => void;
}) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0 && staged) return null;
  return (
    <div className="scm-section">
      <div className="scm-section-head reveal-host" onClick={() => setOpen((v) => !v)}>
        <span className="tree-chevron">
          <DisclosureIcon open={open} />
        </span>
        <span className="scm-section-title">{title}</span>
        <span className="scm-count">{entries.length}</span>
        <span className="scm-actions">
          {entries.length > 0 &&
            actions.map((a) => (
              <IconButton
                key={a.title}
                reveal
                size="sm"
                icon={a.icon}
                danger={a.danger}
                label={`すべて${a.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  a.run(entries.map((x) => x.path));
                }}
              />
            ))}
        </span>
      </div>
      {open && entries.length === 0 && <div className="scm-none">変更はありません</div>}
      {open && (
        <ChangeRows
          items={entries}
          view={view}
          actions={actions}
          renderFile={(entry, depth) => {
            const code = staged ? entry.index : entry.index === '?' ? 'U' : entry.worktree;
            return (
              <div
                className="scm-row reveal-host"
                style={depth === null ? undefined : { paddingLeft: filePadding(depth) }}
                onClick={() => onOpen(entry)}
                title={entry.from ? `${entry.from} → ${entry.path}` : entry.path}
              >
                <span className="scm-name">{entry.path.split('/').pop()}</span>
                {depth === null && <span className="scm-dir">{entry.path.split('/').slice(0, -1).join('/')}</span>}
                <span className="scm-actions">
                  {actions.map((a) => (
                    <IconButton
                      key={a.title}
                      reveal
                      size="sm"
                      icon={a.icon}
                      danger={a.danger}
                      label={a.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        a.run([entry.path]);
                      }}
                    />
                  ))}
                </span>
                <span className={`scm-code code-${code}`}>{code}</span>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

function BranchMenu({
  branches,
  current,
  onPick,
  onSwitchDefault,
  onClose,
}: {
  branches: GitBranches;
  current: string | null;
  onPick: (branch: string, mode: 'local' | 'remote' | 'create') => void;
  onSwitchDefault: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const match = (b: string) => b.toLowerCase().includes(q.toLowerCase());
  const local = branches.local.filter(match);
  // 同じ名前のローカルブランチがあるリモートブランチは出さない
  const remote = branches.remote.filter((b) => match(b) && !branches.local.includes(b.replace(/^[^/]+\//, '')));
  const canCreate = q && !branches.local.includes(q) && !/\s/.test(q);
  return (
    <div className="scm-branch-menu">
      <input
        autoFocus
        value={query}
        placeholder="ブランチを探す・新しい名前"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            if (local[0]) onPick(local[0], 'local');
            else if (canCreate) onPick(q, 'create');
          }
        }}
      />
      <div className="scm-branch-list">
        {!q && branches.defaultBranch && (
          <button
            className="scm-branch-default"
            onClick={onSwitchDefault}
            title={`フェッチしてから ${branches.defaultBranch} に切り替え、リモートの最新まで進める`}
          >
            <DefaultBranchIcon size={14} />
            最新のデフォルトブランチへ切り替える
            <span className="scm-branch-note">{branches.defaultBranch}</span>
          </button>
        )}
        {canCreate && (
          <button onClick={() => onPick(q, 'create')}>
            <AddIcon size={14} />
            新しいブランチ「{q}」を作って切り替える
          </button>
        )}
        {local.map((b) => (
          <button key={b} className={b === current ? 'current' : ''} onClick={() => b !== current && onPick(b, 'local')}>
            {b}
            {b === current && <span className="scm-branch-note">現在</span>}
          </button>
        ))}
        {remote.map((b) => (
          <button key={b} onClick={() => onPick(b, 'remote')}>
            {b}
            <span className="scm-branch-note">リモート</span>
          </button>
        ))}
      </div>
    </div>
  );
}
