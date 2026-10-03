import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchChanges, FileChange, FileContent, NewSessionOptions, SessionSummary, WorkspaceInfo } from '@shared/ipc';
import type { TaskRef } from '@shared/task';
import { ClaudePane } from './chat/ClaudePane';
import { errorMessage } from './errorMessage';
import { chatFromEvents, useSessionChats, type ChatState } from './chat/chatState';
import { usePendingSends } from './chat/pendingSends';
import { SettingsFilesDialog } from './chat/SettingsFilesDialog';
import { closeSettingsFilesDialog, useSettingsFilesDialogOpen } from './chat/settingsFiles';
import { useSessionSubagents } from './chat/useSessionSubagents';
import { EditorPane, type OpenFile, type RevealRequest } from './editor/EditorPane';
import { languageFor, languageLabel } from './editor/monaco';
import { Explorer } from './explorer/Explorer';
import type { ReviewComment } from './review/LineComments';
import { DiffPane } from './scm/DiffPane';
import { branchPaths, ScmPanel } from './scm/ScmPanel';
import { useScmView, type ScmView } from './scm/scmView';
import { gitMarks, useGitState } from './scm/useGitState';
import { QuickOpen } from './search/QuickOpen';
import { SearchPanel } from './search/SearchPanel';
import { useSessionScreens } from './screen/useSessionScreens';
import { useSessionWorkflows } from './workflow/useSessionWorkflows';
import { ImportDialog } from './sessions/ImportDialog';
import { NewSessionPane } from './sessions/NewSessionPane';
import { Sidebar } from './sessions/Sidebar';
import { WorktreeDialog } from './sessions/WorktreeDialog';
import { useSessions } from './sessions/useSessions';
import { StatusBar } from './StatusBar';
import { useClaudeVersion } from './system/ClaudeVersion';
import { useSessionKnowledge } from './knowledge/useSessionKnowledge';
import { useSessionStatusLine } from './statusline/useSessionStatusLine';
import { Resizer, useColumnWidths, type Column } from './layout/columns';
import { BranchIcon, FilesIcon, SearchIcon, TasksIcon } from './layout/icons';
import { TaskPane } from './tasks/TaskPane';
import { TaskListPanel } from './tasks/TaskListPanel';
import { useStopTask } from './tasks/useStopTask';
import { buildTasks, taskKey, useSessionBash, type TaskEntry } from './tasks/taskList';
import { TerminalPanel, type TerminalView } from './terminal/TerminalPanel';
import { BrowserHostsDialog } from './preview/BrowserHostsDialog';
import { PreviewPane } from './preview/PreviewPane';
import { TitleBar } from './layout/TitleBar';
import { useAppUpdate } from './layout/AppUpdate';
import { TooltipLayer } from './layout/Tooltip';
import { useNotifications } from './notifications/useNotifications';
import { setCursor } from './editor/cursorStore';

type EditorState = { files: OpenFile[]; activePath: string | null; reveal: RevealRequest | null };
const EMPTY_EDITOR: EditorState = { files: [], activePath: null, reveal: null };
const NO_COMMENTS: ReviewComment[] = [];
const NO_CHANGES: Record<string, FileChange> = {};

type SidePanel = 'files' | 'search' | 'scm' | 'tasks';
// サイドパネルの切り替え（左端に縦に並べるアイコン）
const SIDE_PANELS: { id: SidePanel; label: string; title: string; Icon: () => React.JSX.Element }[] = [
  { id: 'files', label: 'エクスプローラー', title: 'エクスプローラー', Icon: FilesIcon },
  { id: 'search', label: '検索', title: '検索（⌘⇧F）', Icon: SearchIcon },
  { id: 'scm', label: 'ソース管理', title: 'ソース管理（git）。ブランチの変更を見て、行にコメントを付けて Claude に返す', Icon: BranchIcon },
  { id: 'tasks', label: 'タスク', title: 'タスク（サブエージェント・ワークフロー・バックグラウンドの Bash）', Icon: TasksIcon },
];

let revealSeq = 0;

// エディタの代わりに出す差分。ステージ済み・未ステージの変更か、ブランチの変更（基点 ↔ 作業ツリー）
type DiffView = { source: 'scm'; path: string; staged: boolean } | { source: 'branch'; path: string };
// エディタの場所に出すもの。差分か、タスク（サブエージェントなど）の中身
type CenterView = DiffView | { source: 'task'; ref: TaskRef } | { source: 'preview' };

function withFile(files: OpenFile[], path: string, content: FileContent): OpenFile[] {
  return files.some((f) => f.path === path)
    ? files.map((f) => (f.path === path ? { path, content } : f))
    : [...files, { path, content }];
}

export function App() {
  const sessions = useSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // セッションごとの値は全セッションの分を持つが、App を描き直すのは選択中のセッションの値が変わったときだけ
  const { chatOf, load } = useSessionChats(selectedId);
  const pendingSends = usePendingSends(chatOf);
  const { screenOf, load: loadScreen } = useSessionScreens(selectedId);
  const { workflowsOf, load: loadWorkflows } = useSessionWorkflows(selectedId);
  const { subagentsOf, load: loadSubagents } = useSessionSubagents(selectedId);
  const { bashOf, load: loadBash } = useSessionBash(selectedId);
  const { knowledgeOf, load: loadKnowledge } = useSessionKnowledge(selectedId);
  const { statusLineOf, load: loadStatusLine } = useSessionStatusLine(selectedId);
  const columns = useColumnWidths();
  const [notifications, setNotifications] = useNotifications();
  const claudeVersion = useClaudeVersion();
  const appUpdate = useAppUpdate();
  const resizer = (column: Column) => (
    <Resizer
      width={columns.widths[column]}
      onResize={(w) => columns.resize(column, w)}
      onReset={() => columns.reset(column)}
      onEnd={columns.save}
    />
  );
  // 新規セッションの画面を出している。back: キャンセルで戻るセッション / cwd: 最初に選んでおくフォルダ
  const [composing, setComposing] = useState<{ back: string | null; cwd: string | null } | null>(null);
  // 新規セッションの画面で選んでいるフォルダを、右パネルとエディタで開いたもの（id はセッションの id と同じように使える）
  const [draft, setDraft] = useState<{ id: string; cwd: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<Record<string, WorkspaceInfo>>({});
  // エディタのタブはフォルダ単位。同じフォルダのセッション間では共有する
  const [editors, setEditors] = useState<Record<string, EditorState>>({});
  // エディタの下のターミナルパネル（シェル / Claude Code の生の画面）
  const [terminal, setTerminal] = useState<{ open: boolean; view: TerminalView }>({ open: false, view: 'shell' });
  const showClaudeScreen = useCallback(() => setTerminal({ open: true, view: 'claude' }), []);
  const showShell = useCallback(() => setTerminal({ open: true, view: 'shell' }), []);
  // 左から 3 番目のペイン
  const [sidePanel, setSidePanel] = useState<SidePanel>('files');
  const [diffView, setDiffView] = useState<CenterView | null>(null);
  // アプリ内ブラウザで Claude に許す先のダイアログ（メニューから開く）
  const [browserHostsOpen, setBrowserHostsOpen] = useState(false);
  // セッションごとの、コードに付けた Claude へのコメント（次の送信で一緒に送る）
  const [comments, setComments] = useState<Record<string, ReviewComment[]>>({});
  const [quickOpen, setQuickOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  // worktree のセッションをアーカイブ・一覧から削除するときの確認（worktree を残すか消すか）
  const [worktreeDialog, setWorktreeDialog] = useState<{ id: string; action: 'archive' | 'remove' } | null>(null);
  // 設定ファイルの管理ダイアログ（チャットの入力欄の下と新規セッションの画面の選択欄から開く）
  const settingsFilesOpen = useSettingsFilesDialogOpen();
  // アーカイブ済みセッションのチャット（再開せずに会話ログから作る）
  const [archivedChats, setArchivedChats] = useState<Record<string, ChatState>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;
  const liveChat = chatOf(selectedId);
  const chat = selected?.archived && liveChat.status === 'not-started' ? (archivedChats[selected.id] ?? liveChat) : liveChat;
  // 右パネル・エディタで扱うもの。選んでいるセッションか、新規セッションの画面で選んでいるフォルダ
  const viewId = selected?.id ?? draft?.id ?? null;
  const cwd = selected?.cwd ?? draft?.cwd ?? null;
  const editor = (cwd && editors[cwd]) || EMPTY_EDITOR;
  const workspace = viewId ? workspaces[viewId] : undefined;
  // 選択中のセッションのタスク。ほかのセッションのタスクが動いても、ここは変わらない（stableRuns で参照が保たれる）
  const subagents = subagentsOf(selectedId);
  const workflows = workflowsOf(selectedId);
  const bashTasks = bashOf(selectedId);
  const tasks = useMemo(() => buildTasks(chat.items, subagents, workflows, bashTasks), [chat.items, subagents, workflows, bashTasks]);
  const activeTaskKey = diffView?.source === 'task' ? taskKey(diffView.ref) : null;
  // 入力欄の上に出すのは実行中のものだけ。終わったものはサイドパネルの「タスク」で見る
  const { stopping: stoppingTasks, stop: stopTask } = useStopTask(selectedId);
  const trayTasks = useMemo(() => tasks.filter((t) => t.state === 'running'), [tasks]);
  // 実行中を先に、それぞれ新しい順
  const allTasks = useMemo(() => [...tasks].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running')), [tasks]);
  // タスクを開いたら、サイドパネルも「タスク」にして、一覧でそのタスクを選んだ状態にする（どこから開いても同じ）
  const openTask = useCallback((ref: TaskRef) => {
    setDiffView({ source: 'task', ref });
    setSidePanel('tasks');
  }, []);
  // 新規セッションの画面で付けたコメントは、最初の指示と一緒に送る
  const sessionComments = (viewId && comments[viewId]) || NO_COMMENTS;
  const setSessionComments = useCallback(
    (update: (list: ReviewComment[]) => ReviewComment[]) => {
      if (viewId) setComments((prev) => ({ ...prev, [viewId]: update(prev[viewId] ?? []) }));
    },
    [viewId],
  );
  const addComment = useCallback((c: ReviewComment) => setSessionComments((list) => [...list, c]), [setSessionComments]);
  const removeComment = useCallback((id: string) => setSessionComments((list) => list.filter((c) => c.id !== id)), [setSessionComments]);
  const git = useGitState(viewId, cwd);
  const [scmView, setScmView] = useScmView();
  // このブランチの基点から作業ツリーまでの変更（エディタ・エクスプローラーの印と、ソース管理の「ブランチの変更」）
  const branchChanges = git.state?.isRepo ? git.state.branchChanges : null;
  const changes = branchChanges?.files ?? NO_CHANGES;
  const marks = useMemo(() => gitMarks(git.state), [git.state]);
  const gitCount = git.state?.isRepo ? git.state.entries.length : 0;
  const editorsRef = useRef(editors);
  editorsRef.current = editors;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const initialized = useRef(false);
  useEffect(() => {
    if (!sessions || initialized.current) return;
    initialized.current = true;
    sessions.filter((s) => s.running).forEach((s) => load(s.id));
    const first = sessions.find((s) => !s.archived)?.id ?? null;
    setSelectedId(first);
    // アクティブなセッションが無ければ、新規セッションの画面から始める
    if (!first) setComposing({ back: null, cwd: sessions[0]?.worktree?.root ?? sessions[0]?.cwd ?? null });
  }, [sessions, load]);

  const select = useCallback((id: string | null) => {
    setComposing(null);
    setSelectedId(id);
  }, []);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // 新規セッションの画面を出す。フォルダは画面の中で選ぶ（見ていたセッションのフォルダを選んでおく）
  const startComposing = useCallback(() => {
    const list = sessionsRef.current ?? [];
    const back = selectedIdRef.current;
    // worktree のセッションなら、元のフォルダ（worktree の中で、また worktree を作らないように）
    const folderOf = (s: SessionSummary | undefined) => s?.worktree?.root ?? s?.cwd;
    const cwd = folderOf(list.find((s) => s.id === back)) ?? folderOf(list[0]) ?? null;
    setComposing((prev) => prev ?? { back, cwd });
    setSelectedId(null);
  }, []);

  const changeComposingCwd = useCallback((dir: string) => setComposing((prev) => (prev ? { ...prev, cwd: dir } : prev)), []);

  // 新規セッションの画面で選んでいるフォルダを開く。フォルダを変えたり画面を閉じたりしたら閉じる
  const composingCwd = composing?.cwd ?? null;
  useEffect(() => {
    if (!composingCwd) return;
    let alive = true;
    let id: string | null = null;
    window.tanacode.folders.open(composingCwd).then(
      (opened) => {
        if (!alive) return window.tanacode.folders.close(opened);
        id = opened;
        setDraft({ id: opened, cwd: composingCwd });
      },
      () => {},
    );
    return () => {
      alive = false;
      if (id) window.tanacode.folders.close(id);
      setDraft(null);
    };
  }, [composingCwd]);

  useEffect(() => window.tanacode.sessions.onSelect(select), [select]);
  useEffect(() => window.tanacode.sessions.onNew(startComposing), [startComposing]);

  useEffect(() => {
    window.tanacode.sessions.focus(selectedId);
    if (selectedId) {
      loadScreen(selectedId);
      loadWorkflows(selectedId);
      loadSubagents(selectedId);
      loadBash(selectedId);
      loadKnowledge(selectedId);
      loadStatusLine(selectedId);
    }
  }, [selectedId, loadScreen, loadWorkflows, loadSubagents, loadBash, loadKnowledge, loadStatusLine]);

  // Claude がアプリ内ブラウザを操作し始めたセッション（帯が消えるまで）と、見ていない間に操作したセッション
  const browsing = useRef(new Set<string>());
  const browsedUnseen = useRef(new Set<string>());

  // セッションを切り替えたら、エディタの場所は閉じる。見ていない間に Claude がブラウザを操作したセッションなら、ブラウザを開く
  useEffect(() => setDiffView(viewId && browsedUnseen.current.delete(viewId) ? { source: 'preview' } : null), [viewId]);

  // Claude によるアプリ内ブラウザの操作。そのセッションを見ているときだけ、操作を始めたときにエディタの場所にブラウザを開く
  // （閉じても、続けて操作している間は開き直さない）。見ていないセッションは裏で動かし、戻ったときに開く
  useEffect(() => {
    const offActivity = window.tanacode.browser.onActivity(({ sessionId, active }) => {
      if (!active) {
        browsing.current.delete(sessionId);
        return;
      }
      if (browsing.current.has(sessionId)) return;
      browsing.current.add(sessionId);
      if (sessionId === selectedIdRef.current) setDiffView({ source: 'preview' });
      else browsedUnseen.current.add(sessionId);
    });
    const offHosts = window.tanacode.browser.onHostsOpen(() => setBrowserHostsOpen(true));
    return () => {
      offActivity();
      offHosts();
    };
  }, []);

  // アーカイブしていないセッション（ブラウザのタブを持っておくもの。消した・アーカイブしたセッションのタブは閉じる）
  const liveKey = (sessions ?? []).filter((s) => !s.archived).map((s) => s.id).join(',');
  const liveSessionIds = useMemo(() => (liveKey ? liveKey.split(',') : []), [liveKey]);

  useEffect(() => {
    if (!viewId || workspaces[viewId]) return;
    void window.tanacode.workspace.info(viewId).then((info) => setWorkspaces((prev) => ({ ...prev, [viewId]: info })));
  }, [viewId, workspaces]);

  useEffect(() => {
    // 再開したら古い表示は捨てる（もう一度アーカイブしたときに読み直す）
    if (selected && !selected.archived && archivedChats[selected.id]) {
      setArchivedChats(({ [selected.id]: _, ...rest }) => rest);
      return;
    }
    if (!selected?.archived || archivedChats[selected.id]) return;
    const id = selected.id;
    void window.tanacode.sessions
      .history(id)
      .then((events) => setArchivedChats((prev) => ({ ...prev, [id]: { ...chatFromEvents(events), status: 'not-started' } })));
  }, [selected, archivedChats]);

  // セッションを開く（止まっていれば再開する）。開けなかったら理由を出す（登録した設定ファイルが読めないときなど）。
  // 一覧が更新されるたびに開き直すので、同じ理由は 1 回だけ出す
  const openFailures = useRef(new Map<string, string>());
  const openSession = useCallback((id: string) => {
    void window.tanacode.sessions
      .open(id)
      .then(() => openFailures.current.delete(id))
      .catch((error: unknown) => {
        const message = errorMessage(error);
        if (openFailures.current.get(id) === message) return;
        openFailures.current.set(id, message);
        window.alert(`セッションを開けませんでした: ${message}`);
      });
  }, []);

  // このアプリの起動後にまだ動かしていないセッションは、選んだ時点で再開する
  useEffect(() => {
    if (selected && !selected.archived && !selected.running && chat.status === 'not-started') {
      openSession(selected.id);
    }
  }, [selected, chat.status, openSession]);

  const updateEditor = useCallback((dir: string, fn: (state: EditorState) => EditorState) => {
    setEditors((prev) => ({ ...prev, [dir]: fn(prev[dir] ?? EMPTY_EDITOR) }));
  }, []);

  // line を渡すと、ディスクから読み直したうえでその行を表示する（Claude Code の編集直後に開くため）。
  // エディタの場所に差分・タスク・ブラウザを出していたら閉じて、エディタを見せる
  const openFile = useCallback(
    async (path: string, line?: number) => {
      if (!viewId || !cwd) return;
      setDiffView(null);
      if (!line && editorsRef.current[cwd]?.files.some((f) => f.path === path)) {
        updateEditor(cwd, (s) => ({ ...s, activePath: path }));
        return;
      }
      const content = await window.tanacode.workspace.readFile(viewId, path).catch(() => null);
      if (!content) return;
      updateEditor(cwd, (s) => ({
        files: withFile(s.files, path, content),
        activePath: path,
        reveal: line ? { path, line, seq: ++revealSeq } : s.reveal,
      }));
    },
    [viewId, cwd, updateEditor],
  );

  // フォルダの中のファイルは相対パスで、外のファイル（Claude が送ったものなど）は絶対パスのままエディタで開く
  const openAbsolute = useCallback(
    (absPath: string, line?: number) => {
      if (!cwd) return;
      void openFile(absPath.startsWith(`${cwd}/`) ? absPath.slice(cwd.length + 1) : absPath, line);
    },
    [cwd, openFile],
  );

  const reloadFiles = useCallback(
    (root: string, paths: ReadonlySet<string> | null) => {
      const state = editorsRef.current[root];
      const sessionId = sessionsRef.current?.find((s) => s.cwd === root)?.id ?? (draftRef.current?.cwd === root ? draftRef.current.id : undefined);
      if (!state || !sessionId) return;
      for (const file of state.files) {
        if (paths && !paths.has(file.path)) continue;
        void window.tanacode.workspace
          .readFile(sessionId, file.path)
          .then((content) =>
            updateEditor(root, (s) =>
              s.files.some((f) => f.path === file.path) ? { ...s, files: withFile(s.files, file.path, content) } : s,
            ),
          )
          .catch(() => {});
      }
    },
    [updateEditor],
  );

  // 開いているファイルがディスク上で変わったら読み直す（エディタのタブはフォルダ単位）
  useEffect(
    () => window.tanacode.workspace.onFilesChanged(({ root, paths }) => reloadFiles(root, new Set(paths))),
    [reloadFiles],
  );

  const openBranchDiff = useCallback((path: string) => {
    setSidePanel('scm');
    setDiffView({ source: 'branch', path });
  }, []);

  // コメントを付けた場所を見せる。ブランチの変更にあるファイルなら差分、無ければエディタで開く
  const showComment = useCallback(
    (path: string, line: number) => {
      if (changes[path] && changes[path].kind !== 'deleted') openBranchDiff(path);
      else void openFile(path, line);
    },
    [changes, openBranchDiff, openFile],
  );

  // ⌘P: ファイル名で開く / ⌘⇧F: 全文検索 / ⌃`: ターミナルの開閉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.code === 'Backquote') {
        e.preventDefault();
        setTerminal((t) => (t.open && t.view === 'shell' ? { ...t, open: false } : { open: true, view: 'shell' }));
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || !viewId) return;
      const key = e.key.toLowerCase();
      if (key === 'p' && !e.shiftKey) {
        e.preventDefault();
        setQuickOpen(true);
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault();
        setSidePanel('search');
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [viewId]);

  const closeFile = useCallback(
    (path: string) => {
      if (!cwd) return;
      updateEditor(cwd, (s) => {
        const index = s.files.findIndex((f) => f.path === path);
        const files = s.files.filter((f) => f.path !== path);
        const activePath = path === s.activePath ? (files[Math.min(index, files.length - 1)]?.path ?? null) : s.activePath;
        return { ...s, files, activePath };
      });
    },
    [cwd, updateEditor],
  );

  // 選んだフォルダで Claude Code を起動し、最初の発言は起動が終わるのを待って送る
  const startSession = useCallback(
    async (dir: string, text: string, attachments: string[], options: NewSessionOptions) => {
      const id = await window.tanacode.sessions.create(dir, options);
      pendingSends.send(id, text, attachments);
      select(id);
    },
    [pendingSends.send, select],
  );
  // 最近使ったフォルダ（新しい順）
  // worktree のセッションは、worktree ではなく元のフォルダ
  const recentFolders = useMemo(() => [...new Set((sessions ?? []).map((s) => s.worktree?.root ?? s.cwd))], [sessions]);

  // 子の部品（memo している）に渡す関数。描き直しのたびに作り直すと memo が効かないので固定する
  const statusKey = (sessions ?? []).map((s) => `${s.id}:${chatOf(s.id).status}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statuses = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, chatOf(s.id).status])), [statusKey]);
  const statusOf = useCallback((id: string) => statuses.get(id) ?? 'not-started', [statuses]);
  const openImport = useCallback(() => setImporting(true), []);
  const closeCenter = useCallback(() => setDiffView(null), []);
  // 一覧から消したセッションを見ていたら、ほかのセッションに移る
  const forgetSession = useCallback(
    (id: string) => {
      pendingSends.drop(id);
      if (id === selectedIdRef.current) setSelectedId(sessionsRef.current?.find((s) => s.id !== id && !s.archived)?.id ?? null);
    },
    [pendingSends.drop],
  );
  const removeSession = useCallback(
    (id: string) => {
      // worktree のセッションは、worktree をどうするかを聞いてから
      if (sessionsRef.current?.find((s) => s.id === id)?.worktree) {
        setWorktreeDialog({ id, action: 'remove' });
        return;
      }
      void window.tanacode.sessions.remove(id);
      forgetSession(id);
    },
    [forgetSession],
  );
  const archiveSession = useCallback((id: string) => {
    if (sessionsRef.current?.find((s) => s.id === id)?.worktree) setWorktreeDialog({ id, action: 'archive' });
    else void window.tanacode.sessions.archive(id);
  }, []);
  // 確認のダイアログで選んだとおりに、アーカイブ・一覧から削除する。worktree を消したら、控えや残したブランチを知らせる
  const finishWorktreeDialog = useCallback(
    async (id: string, action: 'archive' | 'remove', removeWorktree: boolean) => {
      const removal =
        action === 'archive'
          ? await window.tanacode.sessions.archive(id, { removeWorktree })
          : await window.tanacode.sessions.remove(id, { removeWorktree });
      if (action === 'remove') forgetSession(id);
      const notes = [
        removal?.backupRef && `未コミットの変更と未追跡のファイルの控えを ${removal.backupRef} に残しました（git show ${removal.backupRef} で見られます）。`,
        removal?.branchKept && `ブランチ ${removal.branch} には、まだどこにも入っていないコミットがあるので残しました。`,
      ].filter(Boolean);
      if (notes.length > 0) window.alert(`worktree を削除しました。\n${notes.join('\n')}`);
    },
    [forgetSession],
  );
  const replaceComments = useCallback((list: ReviewComment[]) => setSessionComments(() => list), [setSessionComments]);
  const showCommentOf = useCallback((c: ReviewComment) => showComment(c.path, c.startLine), [showComment]);
  const toggleClaudeScreen = useCallback(
    () => setTerminal((t) => (t.open && t.view === 'claude' ? { ...t, open: false } : { open: true, view: 'claude' })),
    [],
  );
  const openSelected = useCallback(() => {
    if (selectedIdRef.current) openSession(selectedIdRef.current);
  }, [openSession]);
  const sendToSelected = useCallback(
    (text: string, attachments: string[]) => {
      if (selectedIdRef.current) pendingSends.send(selectedIdRef.current, text, attachments);
    },
    [pendingSends.send],
  );
  const takeSelectedPending = useCallback(
    () => (selectedIdRef.current ? pendingSends.take(selectedIdRef.current) : null),
    [pendingSends.take],
  );
  const openPath = useCallback((path: string, line?: number) => void openFile(path, line), [openFile]);
  const openScmDiff = useCallback((path: string, staged: boolean) => setDiffView({ source: 'scm', path, staged }), []);
  const openTaskEntry = useCallback((t: TaskEntry) => openTask(t.ref), [openTask]);
  const activatePath = useCallback((path: string) => cwd && updateEditor(cwd, (s) => ({ ...s, activePath: path })), [cwd, updateEditor]);
  const saveFile = useCallback(
    async (path: string, text: string) => {
      if (!viewId || !cwd) return;
      await window.tanacode.workspace.writeFile(viewId, path, text);
      updateEditor(cwd, (s) => ({ ...s, files: withFile(s.files, path, { kind: 'text', text }) }));
    },
    [viewId, cwd, updateEditor],
  );

  // タスクは会話のあるセッションだけ。新規セッションの画面ではエクスプローラー・検索・ソース管理だけを出す
  const sidePanels = selected ? SIDE_PANELS : SIDE_PANELS.filter((p) => p.id !== 'tasks');
  const shownPanel = sidePanels.some((p) => p.id === sidePanel) ? sidePanel : 'files';
  const openScm = useCallback(() => setSidePanel('scm'), []);

  const activeFile = editor.files.find((f) => f.path === editor.activePath);
  const language = activeFile?.content.kind === 'text' ? languageLabel(languageFor(activeFile.path)) : null;

  return (
    <div className="app">
      <TooltipLayer />
      <TitleBar notifications={notifications} onNotificationsChange={setNotifications} update={appUpdate} />
      <div
        className="main"
        ref={columns.mainRef}
        style={
          {
            '--w-sessions': `${columns.widths.sessions}px`,
            '--w-claude': `${columns.widths.claude}px`,
            '--w-side': `${columns.widths.side}px`,
          } as React.CSSProperties
        }
      >
        <Sidebar
          sessions={sessions ?? []}
          selectedId={selectedId}
          statusOf={statusOf}
          onSelect={select}
          onCreate={startComposing}
          onImport={openImport}
          onRename={renameSession}
          onRemove={removeSession}
          onArchive={archiveSession}
          onUnarchive={unarchiveSession}
        />
        {resizer('sessions')}
        {composing && (
          <NewSessionPane
            folders={recentFolders}
            cwd={composing.cwd}
            onCwdChange={changeComposingCwd}
            branch={draft && draft.cwd === composing.cwd && git.state ? (git.state.isRepo ? git.state.branch : null) : undefined}
            onOpenScm={openScm}
            comments={sessionComments}
            onCommentsChange={replaceComments}
            onShowComment={showCommentOf}
            onStart={startSession}
            onCancel={composing.back ? () => select(composing.back) : null}
          />
        )}
        {composing && resizer('claude')}
        {selected && (
          <ClaudePane
            session={selected}
            chat={chat}
            screen={screenOf(selected.id)}
            workflows={workflows}
            subagents={subagents}
            bashTasks={bashTasks}
            contextTokens={knowledgeOf(selected.id).contextTokens}
            statusLine={statusLineOf(selected.id)}
            tasks={tasks}
            activeTaskKey={activeTaskKey}
            onOpenTask={openTask}
            onStopTask={stopTask}
            stoppingTasks={stoppingTasks}
            terminalOpen={terminal.open && terminal.view === 'claude'}
            comments={sessionComments}
            onCommentsChange={replaceComments}
            onShowComment={showCommentOf}
            onOpenTerminal={showClaudeScreen}
            onShowShell={showShell}
            onToggleTerminal={toggleClaudeScreen}
            onOpenFile={openAbsolute}
            onResume={openSelected}
            onUnarchive={openSelected}
            onSend={sendToSelected}
            pending={pendingSends.pendingOf(selected.id)}
            sending={pendingSends.sendingOf(selected.id)}
            onTakePending={takeSelectedPending}
          />
        )}
        {selected && resizer('claude')}
        {viewId && cwd && workspace && (
          <aside className="explorer">
            <div className="activity-bar">
              {sidePanels.map(({ id, title, Icon }) => {
                const badge = id === 'scm' ? gitCount : id === 'tasks' ? trayTasks.length : 0;
                return (
                  <button key={id} className={shownPanel === id ? 'on' : ''} onClick={() => setSidePanel(id)} data-tip={title} data-tip-side="right" aria-label={title}>
                    <Icon />
                    {badge > 0 && <span className={`activity-badge${id === 'tasks' ? ' live' : ''}`}>{badge}</span>}
                  </button>
                );
              })}
            </div>
            <div className="side-panel">
              <div className="side-panel-title">{SIDE_PANELS.find((p) => p.id === shownPanel)?.label}</div>
              <div hidden={shownPanel !== 'files'} className="side-body">
                <Explorer
                  key={cwd}
                  sessionId={viewId}
                  root={cwd}
                  rootName={workspace.name}
                  activePath={editor.activePath}
                  changes={changes}
                  knowledge={knowledgeOf(selectedId).files}
                  gitMarks={marks}
                  onOpenFile={openPath}
                />
              </div>
              <div hidden={shownPanel !== 'scm'} className="side-body">
                <ScmPanel
                  key={cwd}
                  sessionId={viewId}
                  state={git.state}
                  view={scmView}
                  onViewChange={setScmView}
                  onRefresh={git.refresh}
                  onOpenDiff={openScmDiff}
                  onOpenBranchDiff={openBranchDiff}
                  activeBranchPath={diffView?.source === 'branch' ? diffView.path : null}
                  comments={sessionComments}
                  onShowComment={showCommentOf}
                  onRemoveComment={removeComment}
                />
              </div>
              {selected && (
                <div hidden={shownPanel !== 'tasks'} className="side-body">
                  <TaskListPanel
                    tasks={allTasks}
                    activeKey={activeTaskKey}
                    onOpen={openTaskEntry}
                    onStop={stopTask}
                    stopping={stoppingTasks}
                    visible={shownPanel === 'tasks'}
                  />
                </div>
              )}
              <div hidden={shownPanel !== 'search'} className="side-body">
                <SearchPanel key={cwd} ref={searchInputRef} sessionId={viewId} onOpen={openPath} />
              </div>
            </div>
          </aside>
        )}
        {viewId && cwd && workspace && resizer('side')}
        {importing && (
          <ImportDialog
            onImport={(s) => void window.tanacode.sessions.import(s).then((id) => setSelectedId(id))}
            onClose={() => setImporting(false)}
          />
        )}
        {settingsFilesOpen && <SettingsFilesDialog onClose={closeSettingsFilesDialog} />}
        {browserHostsOpen && <BrowserHostsDialog onClose={() => setBrowserHostsOpen(false)} />}
        {worktreeDialog && sessions?.some((s) => s.id === worktreeDialog.id && s.worktree) && (
          <WorktreeDialog
            session={sessions.find((s) => s.id === worktreeDialog.id)!}
            action={worktreeDialog.action}
            onConfirm={(removeWorktree) => finishWorktreeDialog(worktreeDialog.id, worktreeDialog.action, removeWorktree)}
            onClose={() => setWorktreeDialog(null)}
          />
        )}
        {quickOpen && viewId && (
          <QuickOpen sessionId={viewId} onOpen={(path) => void openFile(path)} onClose={() => setQuickOpen(false)} />
        )}
        <div className="center">
          {selected && cwd && diffView?.source === 'task' && (
            <TaskView
              sessionId={selected.id}
              view={diffView.ref}
              tasks={tasks}
              subagents={subagents}
              workflows={workflows}
              bash={bashTasks}
              stopping={stoppingTasks}
              onStop={stopTask}
              onClose={() => setDiffView(null)}
              onOpenFile={(absPath, line) => {
                setDiffView(null);
                openAbsolute(absPath, line);
              }}
            />
          )}
          {viewId && cwd && diffView && diffView.source !== 'task' && diffView.source !== 'preview' && (
            <DiffView
              sessionId={viewId}
              view={diffView}
              branchChanges={branchChanges}
              scmView={scmView}
              comments={sessionComments}
              onAddComment={addComment}
              onRemoveComment={removeComment}
              onChange={setDiffView}
              onOpenFile={(path) => void openFile(path)}
            />
          )}
          {viewId && cwd ? (
            // 差分を見ている間もエディタは残しておく（未保存の変更やスクロール位置を保つ）
            <div className="editor-host" hidden={!!diffView}>
            <EditorPane
              key={cwd}
              sessionId={viewId}
              files={editor.files}
              activePath={editor.activePath}
              changes={changes}
              mergeBase={branchChanges?.base.mergeBase ?? null}
              onShowDiff={openBranchDiff}
              onOpenFile={openPath}
              reveal={editor.reveal}
              onActivate={activatePath}
              onClose={closeFile}
              onSave={saveFile}
              onCursor={setCursor}
              comments={sessionComments}
              onAddComment={addComment}
              onRemoveComment={removeComment}
            />
            </div>
          ) : composing ? (
            <div className="empty-state">
              <p>左のチャット欄でフォルダを選び、最初の指示を送るとセッションが始まります</p>
            </div>
          ) : (
            <div className="empty-state">
              <p>セッションがありません</p>
              <button className="send-button" onClick={startComposing}>
                新規セッション
              </button>
            </div>
          )}
          {/* 見ていないセッションのブラウザも持っておく（Claude が裏で操作できるように） */}
          <PreviewPane
            sessionId={selected && !selected.archived ? selected.id : null}
            visible={diffView?.source === 'preview' && !!selected && !selected.archived}
            liveSessionIds={liveSessionIds}
            onClose={closeCenter}
          />
          <TerminalPanel
            sessionId={selected && !selected.archived ? selected.id : null}
            open={terminal.open}
            view={terminal.view}
            onView={(view) => setTerminal({ open: true, view })}
            onClose={() => setTerminal((t) => ({ ...t, open: false }))}
          />
        </div>
      </div>
      <StatusBar
        previewOpen={diffView?.source === 'preview'}
        onTogglePreview={() => setDiffView(diffView?.source === 'preview' ? null : { source: 'preview' })}
        terminalOpen={terminal.open && terminal.view === 'shell'}
        onToggleTerminal={() =>
          setTerminal((t) => (t.open && t.view === 'shell' ? { ...t, open: false } : { open: true, view: 'shell' }))
        }
        status={chat.status}
        exitCode={chat.exitCode}
        branch={(git.state?.isRepo ? git.state.branch : workspace?.branch) ?? null}
        worktree={selected?.worktree ?? null}
        onOpenScm={() => setSidePanel('scm')}
        pr={chat.pr}
        showCursor={activeFile?.content.kind === 'text'}
        language={language}
        claudeVersion={claudeVersion}
      />
    </div>
  );
}

function DiffView({
  sessionId,
  view,
  branchChanges,
  scmView,
  comments,
  onAddComment,
  onRemoveComment,
  onChange,
  onOpenFile,
}: {
  sessionId: string;
  view: DiffView;
  branchChanges: BranchChanges | null;
  scmView: ScmView;
  comments: ReviewComment[];
  onAddComment: (comment: ReviewComment) => void;
  onRemoveComment: (id: string) => void;
  onChange: (view: DiffView | null) => void;
  onOpenFile: (path: string) => void;
}) {
  const lineComments = { list: comments.filter((c) => c.path === view.path), onAdd: onAddComment, onRemove: onRemoveComment };
  if (view.source === 'scm') {
    return (
      <DiffPane
        path={view.path}
        subtitle={view.staged ? 'ステージ済みの変更（HEAD ↔ インデックス）' : '変更（インデックス ↔ 作業ツリー）'}
        load={() => window.tanacode.git.diffSides(sessionId, view.path, view.staged)}
        reloadKey={String(view.staged)}
        onClose={() => onChange(null)}
        onOpenFile={onOpenFile}
        comments={lineComments}
      />
    );
  }
  const paths = branchPaths(branchChanges, scmView);
  const index = paths.indexOf(view.path);
  const change = branchChanges?.files[view.path];
  const mergeBase = branchChanges?.base.mergeBase ?? null;
  const go = (i: number) => (i >= 0 && i < paths.length ? () => onChange({ source: 'branch', path: paths[i] }) : null);
  if (!branchChanges || !mergeBase) return null;
  return (
    <DiffPane
      path={view.path}
      subtitle={`${branchChanges.base.ref} から`}
      load={() => window.tanacode.git.branchDiffSides(sessionId, mergeBase, view.path)}
      reloadKey={JSON.stringify([change ?? null, mergeBase])}
      onClose={() => onChange(null)}
      onOpenFile={change?.kind === 'deleted' ? null : onOpenFile}
      comments={change?.kind === 'deleted' ? undefined : lineComments}
      nav={{ position: index === -1 ? '—' : `${index + 1} / ${paths.length}`, onPrev: go(index - 1), onNext: index === -1 ? go(0) : go(index + 1) }}
    />
  );
}

function TaskView({
  sessionId,
  view,
  tasks,
  subagents,
  workflows,
  bash,
  stopping,
  onStop,
  onClose,
  onOpenFile,
}: {
  sessionId: string;
  view: TaskRef;
  tasks: TaskEntry[];
  subagents: ReturnType<ReturnType<typeof useSessionSubagents>['subagentsOf']>;
  workflows: ReturnType<ReturnType<typeof useSessionWorkflows>['workflowsOf']>;
  bash: ReturnType<ReturnType<typeof useSessionBash>['bashOf']>;
  stopping: ReadonlySet<string>;
  onStop: (task: TaskEntry) => void;
  onClose: () => void;
  onOpenFile: (absPath: string, line?: number) => void;
}) {
  const task = tasks.find((t) => t.key === taskKey(view));
  if (!task) return null;
  return (
    <TaskPane
      key={task.key}
      sessionId={sessionId}
      task={task}
      subagent={subagents.get(view.toolUseId)}
      workflow={workflows.get(view.toolUseId)}
      bash={bash.get(view.toolUseId)}
      stopping={stopping.has(task.key)}
      onStop={() => onStop(task)}
      onClose={onClose}
      onOpenFile={onOpenFile}
    />
  );
}

const renameSession = (id: string, title: string) => void window.tanacode.sessions.rename(id, title);
const unarchiveSession = (id: string) => void window.tanacode.sessions.unarchive(id);
