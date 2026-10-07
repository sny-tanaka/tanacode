import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchChanges, FileChange, FileContent, NewSessionOptions, SessionSummary, WorkspaceInfo } from '@shared/ipc';
import { listRecentFolders } from '@shared/recent-folders';
import type { Checklist } from '@shared/checklist';
import type { TaskRef } from '@shared/task';
import { ClaudePane } from './chat/ClaudePane';
import { errorMessage } from './errorMessage';
import { chatFromEvents, useSessionChats, type ChatState } from './chat/chatState';
import { usePendingSends } from './chat/pendingSends';
import { scheduledOf, useScheduledMessages } from './chat/scheduled';
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
import { isWorking, liveChildrenOf } from './sessions/sessionTree';
import { useHiddenFolders } from './sessions/useHiddenFolders';
import { useSessions } from './sessions/useSessions';
import { StatusBar } from './StatusBar';
import { useClaudeVersion } from './system/ClaudeVersion';
import { contextUsage, useSessionKnowledge } from './knowledge/useSessionKnowledge';
import { SessionContextPanel } from './knowledge/ContextPanel';
import { useCompactState } from './chat/compactState';
import { useSessionStatusLine } from './statusline/useSessionStatusLine';
import { Resizer, useColumnWidths, type Column } from './layout/columns';
import { BranchIcon, ChecklistIcon, ContextIcon, FilesIcon, GlobeIcon, SearchIcon, TasksIcon, TerminalIcon, type IconComponent } from './icons';
import { CardPane } from './checklist/CardPane';
import { ChecklistPanel } from './checklist/ChecklistPanel';
import { useOpenChecklistCard, type CardTarget } from './checklist/openCard';
import { useChecklists } from './checklist/useChecklists';
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
import { rangeQuestionText, restartRequestText, shownStep, stepQuestionText, type Walkthrough, type WalkthroughStep } from '@shared/walkthrough';
import type { RangeQuestion } from './review/LineComments';
import { useOpenWalkthroughTarget } from './walkthrough/openWalkthrough';
import { useWalkthroughs } from './walkthrough/useWalkthroughs';
import { WalkthroughBand } from './walkthrough/WalkthroughBand';
import { CommentDialog } from './walkthrough/CommentDialog';
import type { WalkthroughControls } from './walkthrough/WalkthroughZone';

type EditorState = { files: OpenFile[]; activePath: string | null; reveal: RevealRequest | null };
const EMPTY_EDITOR: EditorState = { files: [], activePath: null, reveal: null };
const NO_COMMENTS: ReviewComment[] = [];
const NO_CHANGES: Record<string, FileChange> = {};
const NO_SESSIONS: SessionSummary[] = [];
// ウォークスルーを始めてからこの間に届いたファイルの変更は、始める前の Claude の書き込みとみなす（変更の知らせは少し遅れて届く）
const WALK_STALE_GRACE_MS = 3000;
const WALKTHROUGH_REQUEST = 'このブランチの変更を、tanacode のウォークスルーで、コードを示しながら説明してください。';

type SidePanel = 'files' | 'search' | 'scm' | 'tasks' | 'checklist' | 'context';
// サイドパネルの切り替え（左端に縦に並べるアイコン）
const SIDE_PANELS: { id: SidePanel; label: string; title: string; Icon: IconComponent }[] = [
  { id: 'files', label: 'エクスプローラー', title: 'エクスプローラー', Icon: FilesIcon },
  { id: 'search', label: '検索', title: '検索（⌘⇧F）', Icon: SearchIcon },
  { id: 'scm', label: 'ソース管理', title: 'ソース管理（git）。ブランチの変更を見て、行にコメントを付けて Claude に返す', Icon: BranchIcon },
  { id: 'tasks', label: 'タスク', title: 'タスク（サブエージェント・ワークフロー・バックグラウンドの Bash）', Icon: TasksIcon },
  { id: 'checklist', label: 'チェックリスト', title: 'チェックリスト（Claude と一緒に見て、編集するリスト。会話が圧縮されても残る）', Icon: ChecklistIcon },
  { id: 'context', label: 'コンテキスト', title: 'コンテキスト（今の会話に入っているものと大きさ。圧縮で残すもの・捨てるものを選ぶ）', Icon: ContextIcon },
];

let revealSeq = 0;

// エディタの代わりに出す差分。ステージ済み・未ステージの変更か、ブランチの変更（基点 ↔ 作業ツリー）
type DiffView = { source: 'scm'; path: string; staged: boolean } | { source: 'branch'; path: string };
// エディタの場所に出すもの。差分か、タスク（サブエージェントなど）の中身か、チェックリストのカード
type CenterView = DiffView | { source: 'task'; ref: TaskRef } | { source: 'preview' } | { source: 'card'; listId: string; cardId: string };

function withFile(files: OpenFile[], path: string, content: FileContent): OpenFile[] {
  return files.some((f) => f.path === path)
    ? files.map((f) => (f.path === path ? { path, content } : f))
    : [...files, { path, content }];
}

export function App() {
  const sessions = useSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // セッションごとの値は全セッションの分を持つが、App を描き直すのは選択中のセッションの値が変わったときだけ
  const { chatOf, load, reset: resetChat } = useSessionChats(selectedId);
  const pendingSends = usePendingSends(chatOf);
  // 時刻を指定して送信（予約）したメッセージ（すべてのセッションの分）
  const scheduled = useScheduledMessages();
  const selectedScheduled = useMemo(() => (selectedId ? scheduledOf(scheduled, selectedId) : []), [scheduled, selectedId]);
  const { screenOf, load: loadScreen } = useSessionScreens(selectedId);
  const { workflowsOf, load: loadWorkflows } = useSessionWorkflows(selectedId);
  const { subagentsOf, load: loadSubagents } = useSessionSubagents(selectedId);
  const { bashOf, load: loadBash } = useSessionBash(selectedId);
  const { knowledgeOf, load: loadKnowledge } = useSessionKnowledge(selectedId);
  const { statusLineOf, load: loadStatusLine } = useSessionStatusLine(selectedId);
  const { listsOf: checklistsOf, load: loadChecklists, unread: checklistUnread } = useChecklists(selectedId);
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
  const toggleShell = useCallback(() => setTerminal((t) => (t.open && t.view === 'shell' ? { ...t, open: false } : { open: true, view: 'shell' })), []);
  // 左から 3 番目のペイン
  const [sidePanel, setSidePanel] = useState<SidePanel>('files');
  const [diffView, setDiffView] = useState<CenterView | null>(null);
  // アプリ内ブラウザで Claude に許す先のダイアログ（メニューから開く）
  const [browserHostsOpen, setBrowserHostsOpen] = useState(false);
  // ウォークスルーを GitHub の PR に載せる下見のダイアログ（どのセッションのものか）
  const [commenting, setCommenting] = useState<string | null>(null);
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
  // ブラウザとターミナルの持ち主。セッションを見ているときはそのセッション。新規セッションの画面では、いま開いているフォルダ（どのセッションにも紐づかず、画面を閉じると一緒に閉じる）
  const draftToolId = composing && draft && draft.cwd === composing.cwd ? draft.id : null;
  const toolId = selected ? (selected.archived ? null : selected.id) : draftToolId;
  // 新規セッションの画面には、Claude Code の画面がない。ターミナルはシェルで開く
  useEffect(() => {
    if (!selected) setTerminal((t) => (t.view === 'claude' ? { ...t, view: 'shell' } : t));
  }, [selected]);
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
  // 選択中のセッションのチェックリスト。カードを開いたら、サイドパネルも「チェックリスト」にする（チャットの知らせなど、どこから開いても同じ）
  const checklists = checklistsOf(selectedId);
  const activeCardId = diffView?.source === 'card' ? diffView.cardId : null;
  const openCard = useCallback((listId: string, cardId: string) => {
    setDiffView({ source: 'card', listId, cardId });
    setSidePanel('checklist');
  }, []);
  useOpenChecklistCard((target: CardTarget) => {
    if ('listId' in target) return openCard(target.listId, target.cardId);
    const key = target.list.normalize('NFKC').trim().toLowerCase();
    const list = checklists.find((l) => !l.deletedAt && l.name.normalize('NFKC').trim().toLowerCase() === key);
    const card = list?.cards.find((c) => c.number === target.number);
    if (list && card) openCard(list.id, card.id);
    else setSidePanel('checklist');
  });
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
      loadChecklists(selectedId);
    }
  }, [selectedId, loadScreen, loadWorkflows, loadSubagents, loadBash, loadKnowledge, loadStatusLine, loadChecklists]);

  // Claude がアプリ内ブラウザを操作し始めたセッション（帯が消えるまで）と、見ていない間に操作したセッション
  const browsing = useRef(new Set<string>());
  const browsedUnseen = useRef(new Set<string>());
  // 見ていない間に、Claude がウォークスルーで場所を示したセッション
  const walkedUnseen = useRef(new Set<string>());
  // 人が、Claude が前に示した場所を見ているか（Claude が次を示したときに追従するか）。描くたびに決める
  const viewingWalkRef = useRef(false);
  // Claude がウォークスルーで場所を示した。見ているセッションで、始めたときか、人が前に示した場所を見ていたら、その場所を開く。
  // 人が自分で別のファイルや画面を開いていたら動かさない（エディタの場所の上の帯から戻れる）
  const walkthroughs = useWalkthroughs((sessionId: string, walk: Walkthrough, prev: Walkthrough | null) => {
    if (sessionId !== selectedIdRef.current) {
      walkedUnseen.current.add(sessionId);
      return;
    }
    if (!prev || prev.id !== walk.id || viewingWalkRef.current) showStepRef.current(shownStep(walk));
  });
  const walksRef = useRef(walkthroughs);
  walksRef.current = walkthroughs;

  // セッションを切り替えたら、エディタの場所は閉じる。見ていない間に Claude がブラウザを操作したセッションなら、ブラウザを開く。
  // 見ていない間に Claude がウォークスルーで場所を示したセッションなら、その場所を開く
  useEffect(() => {
    setDiffView(viewId && browsedUnseen.current.delete(viewId) ? { source: 'preview' } : null);
    const walk = viewId && walkedUnseen.current.delete(viewId) ? walksRef.current[viewId] : null;
    if (walk?.open) showStepRef.current(shownStep(walk));
  }, [viewId]);

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

  // Claude がユーザーに操作を頼んだ（ask_user_to_act）。見ているセッションならブラウザを開き、見ていなければ戻ったときに開く。
  // 頼まれたときの通知をクリックしたら、そのセッションを選んでブラウザを開く（閉じていても開き直す）。
  // 画面を作り直したとき（ウィンドウを閉じて開き直した）は、今頼まれているセッションも同じに扱う
  useEffect(() => {
    const open = (sessionId: string) => {
      if (sessionId === selectedIdRef.current) setDiffView({ source: 'preview' });
      else browsedUnseen.current.add(sessionId);
    };
    void window.tanacode.browser.asks().then((list) => list.forEach((c) => c.ask && open(c.sessionId)));
    const offAsk = window.tanacode.browser.onAsk(({ sessionId, ask }) => ask && open(sessionId));
    const offShow = window.tanacode.browser.onShow((sessionId) => {
      open(sessionId);
      select(sessionId);
    });
    return () => {
      offAsk();
      offShow();
    };
  }, [select]);

  // アーカイブしていないセッションと、新規セッションの画面のフォルダ（ブラウザのタブを持っておくもの。消した・アーカイブしたセッション、閉じた画面のタブは閉じる）
  const liveKey = [...(sessions ?? []).filter((s) => !s.archived).map((s) => s.id), ...(draftToolId ? [draftToolId] : [])].join(',');
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

  // アーカイブすると Claude Code は止まるが、終了の知らせ（process-exit）は届かない（main がランタイムを先に片付けるため）。
  // 動いていたときのチャットのままだと、戻したあとも待機中に見え、送った指示が届かずに消える。
  // アプリを起動し直したときと同じく起動前に戻し、アーカイブ中は会話ログから読み、戻したあとは選んだ時点で再開する
  useEffect(() => {
    for (const s of sessions ?? []) if (s.archived && chatOf(s.id).status !== 'not-started') resetChat(s.id);
  }, [sessions, chatOf, resetChat]);

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

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

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

  // ウォークスルーを始めたあとで、ステップのファイルがディスク側で変わった（ウォークスルーの id:パス）。示している位置がずれているかもしれない
  const [staleWalkFiles, setStaleWalkFiles] = useState<ReadonlySet<string>>(new Set());
  useEffect(
    () =>
      window.tanacode.workspace.onFilesChanged(({ root, paths }) => {
        const changed = new Set(paths);
        const keys: string[] = [];
        for (const [sessionId, walk] of Object.entries(walksRef.current)) {
          if (sessionsRef.current?.find((s) => s.id === sessionId)?.cwd !== root || Date.now() - walk.startedAt < WALK_STALE_GRACE_MS) continue;
          for (const step of walk.steps) if (changed.has(step.path)) keys.push(`${walk.id}:${step.path}`);
        }
        if (keys.length > 0) setStaleWalkFiles((prev) => new Set([...prev, ...keys]));
      }),
    [],
  );

  const openBranchDiff = useCallback((path: string) => {
    setSidePanel('scm');
    setDiffView({ source: 'branch', path });
  }, []);

  // ウォークスルーのステップを出す場所。diff のステップは、ブランチで変わった（消していない）ファイルなら差分の画面、ほかはエディタ
  const inBranchDiff = useCallback(
    (step: WalkthroughStep) => step.view === 'diff' && !!branchChanges?.base.mergeBase && !!changes[step.path] && changes[step.path].kind !== 'deleted',
    [branchChanges, changes],
  );
  const showStep = useCallback(
    (step: WalkthroughStep) => {
      if (inBranchDiff(step)) openBranchDiff(step.path);
      else void openFile(step.path);
    },
    [inBranchDiff, openBranchDiff, openFile],
  );
  const showStepRef = useRef(showStep);
  showStepRef.current = showStep;

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
        toggleShell();
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
  // 最近使ったフォルダ（新しい順）。新規セッションの画面から外したフォルダは出さない
  const [hiddenFolders, hideFolder] = useHiddenFolders();
  const recentFolders = useMemo(() => listRecentFolders(sessions ?? [], hiddenFolders), [sessions, hiddenFolders]);

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
  const archiveSession = useCallback(
    (id: string) => {
      const list = sessionsRef.current ?? [];
      // 親をアーカイブすると、子セッションも一緒にアーカイブされる（子の worktree は残る）。アクティブな子があれば、先に確かめる
      const children = liveChildrenOf(list, id);
      const working = children.filter((c) => isWorking(c, statusOf(c.id))).length;
      const detail = working > 0 ? `（うち ${working} 件は作業中です）` : '';
      if (children.length > 0 && !window.confirm(`子セッション ${children.length} 件も一緒にアーカイブします${detail}。アーカイブしますか？`)) return;
      if (list.find((s) => s.id === id)?.worktree) setWorktreeDialog({ id, action: 'archive' });
      else void window.tanacode.sessions.archive(id);
    },
    [statusOf],
  );
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
        removal?.branchKept && `ブランチ ${removal.branch} には、手元にしか無いコミットがあるので残しました。`,
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
  const shownPanel = sidePanel;
  const openScm = useCallback(() => setSidePanel('scm'), []);
  const showContext = useCallback(() => setSidePanel('context'), []);
  const compact = useCompactState(selected ?? null, chat, selected ? screenOf(selected.id) : null);
  const compactWith = useCallback((instructions: string) => sendToSelected(`/compact ${instructions}`, []), [sendToSelected]);

  // ウォークスルー（選んでいるセッションのもの）。walkAll は閉じたものも含む（ソース管理の一覧に出し、もう一度開ける）。
  // walk は開いているものだけ（吹き出し・帯・「ここを聞く」）。人が今、Claude の示している場所を見ているか
  const walkAll = (selected && !selected.archived && walkthroughs[selected.id]) || null;
  const walk = walkAll?.open ? walkAll : null;
  const walkShown = walk ? shownStep(walk) : null;
  const walkInDiff = !!walkShown && inBranchDiff(walkShown);
  const viewingWalk =
    !!walkShown &&
    (walkInDiff ? diffView?.source === 'branch' && diffView.path === walkShown.path : !diffView && editor.activePath === walkShown.path);
  viewingWalkRef.current = viewingWalk;
  const walkStale = !!walk && !walk.aside && staleWalkFiles.has(`${walk.id}:${walkShown!.path}`);
  // ステップへ移る（閉じていれば開く）。先にエディタで開き、main に知らせる（範囲までのスクロールは、main から届いた変更で吹き出しが行う）
  const goWalk = useCallback(
    (index: number) => {
      if (!walkAll || !selectedId) return;
      const step = walkAll.steps[Math.min(Math.max(index, 0), walkAll.steps.length - 1)];
      if (step) showStepRef.current(step);
      void window.tanacode.walkthrough.go(selectedId, index);
    },
    [walkAll, selectedId],
  );
  const closeWalk = useCallback(() => selectedId && void window.tanacode.walkthrough.close(selectedId), [selectedId]);
  const publishWalk = useCallback(() => selectedId && setCommenting(selectedId), [selectedId]);
  const walkControls = useMemo<WalkthroughControls | null>(() => {
    if (!walk || !selectedId) return null;
    const sessionId = selectedId;
    return {
      walkthrough: walk,
      stale: walkStale,
      onGo: goWalk,
      onClose: closeWalk,
      onAsk: (question) => pendingSends.send(sessionId, stepQuestionText(walk, question), []),
      onRestart: () => pendingSends.send(sessionId, restartRequestText(walk), []),
      onPublish: publishWalk,
      onShowList: () => setSidePanel('scm'),
    };
  }, [walk, walkStale, selectedId, goWalk, closeWalk, publishWalk, pendingSends.send]);
  // ソース管理パネルの一覧（寄り道だけで、ステップが無いものは出さない）
  const walkList = useMemo(
    () => (walkAll && walkAll.steps.length > 0 ? { walkthrough: walkAll, onGo: goWalk, onPublish: publishWalk } : null),
    [walkAll, goWalk, publishWalk],
  );
  // ソース管理の「ブランチの変更」の「Claude にウォークスルーしてもらう」
  const requestWalkthrough = useCallback(() => sendToSelected(WALKTHROUGH_REQUEST, []), [sendToSelected]);
  const askRange = useCallback(
    (q: RangeQuestion) => sendToSelected(rangeQuestionText(q.path, q.startLine, q.endLine, q.quote, q.text), []),
    [sendToSelected],
  );
  const showWalk = useCallback(() => walkShown && showStep(walkShown), [walkShown, showStep]);
  // チャットのウォークスルーのツールの行から。start_walkthrough は今の場所（閉じていれば、最後に見たステップから開き直す）、show_code はその場所を開く
  useOpenWalkthroughTarget((target) => {
    if (target.kind === 'walkthrough') {
      if (walk) showWalk();
      else if (walkAll && walkAll.steps.length > 0) goWalk(walkAll.current);
    }
    else if (target.path.startsWith('/')) openAbsolute(target.path, target.line);
    else void openFile(target.path, target.line);
  });

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
          scheduled={scheduled}
          checklistUnread={checklistUnread}
        />
        {resizer('sessions')}
        {composing && (
          <NewSessionPane
            folders={recentFolders}
            onForgetFolder={hideFolder}
            cwd={composing.cwd}
            onCwdChange={changeComposingCwd}
            sessions={sessions ?? NO_SESSIONS}
            branch={draft && draft.cwd === composing.cwd && git.state ? (git.state.isRepo ? git.state.branch : null) : undefined}
            onOpenScm={openScm}
            gitId={draft && draft.cwd === composing.cwd ? draft.id : null}
            onGitChanged={git.refresh}
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
            sessions={sessions ?? NO_SESSIONS}
            onSelectSession={select}
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
            onShowContext={showContext}
            onShowShell={showShell}
            onToggleTerminal={toggleClaudeScreen}
            onOpenFile={openAbsolute}
            onResume={openSelected}
            onUnarchive={openSelected}
            onSend={sendToSelected}
            pending={pendingSends.pendingOf(selected.id)}
            sending={pendingSends.sendingOf(selected.id)}
            onTakePending={takeSelectedPending}
            scheduled={selectedScheduled}
          />
        )}
        {selected && resizer('claude')}
        {viewId && cwd && workspace && (
          <aside className="explorer">
            <div className="activity-bar">
              {SIDE_PANELS.map(({ id, title, Icon }) => {
                const badge = id === 'scm' ? gitCount : id === 'tasks' ? trayTasks.length : id === 'checklist' ? (selectedId ? (checklistUnread[selectedId] ?? 0) : 0) : 0;
                return (
                  <button key={id} className={shownPanel === id ? 'on' : ''} onClick={() => setSidePanel(id)} data-tip={title} data-tip-side="right" aria-label={title}>
                    <Icon size={22} />
                    {badge > 0 && <span className={`activity-badge${id === 'tasks' ? ' live' : ''}`}>{badge}</span>}
                  </button>
                );
              })}
              {/* パネルの切り替えではなく、中央のブラウザと下のターミナルを開く・閉じる（セッションか、新規セッションの画面のフォルダがあるとき） */}
              {toolId && (
                <>
                  <span className="activity-sep" />
                  <button
                    className={`activity-toggle${diffView?.source === 'preview' ? ' on' : ''}`}
                    onClick={() => setDiffView(diffView?.source === 'preview' ? null : { source: 'preview' })}
                    data-tip={'ブラウザを開く・閉じる\n開発中のページを開いて、要素を選んで Claude に直してもらえます'}
                    data-tip-side="right"
                    aria-label="ブラウザ"
                    aria-pressed={diffView?.source === 'preview'}
                  >
                    <GlobeIcon size={22} />
                  </button>
                  <button
                    className={`activity-toggle${terminal.open && terminal.view === 'shell' ? ' on' : ''}`}
                    onClick={toggleShell}
                    data-tip="ターミナルを開く・閉じる（⌃`）"
                    data-tip-side="right"
                    aria-label="ターミナル"
                    aria-pressed={terminal.open && terminal.view === 'shell'}
                  >
                    <TerminalIcon size={22} />
                  </button>
                </>
              )}
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
                  onWalkthrough={selected && !selected.archived ? requestWalkthrough : undefined}
                  walkthrough={walkList}
                />
              </div>
              <div hidden={shownPanel !== 'tasks'} className="side-body">
                {selected ? (
                  <TaskListPanel
                    tasks={allTasks}
                    activeKey={activeTaskKey}
                    onOpen={openTaskEntry}
                    onStop={stopTask}
                    stopping={stoppingTasks}
                    visible={shownPanel === 'tasks'}
                  />
                ) : (
                  // 新規セッションの画面にはセッションがない。ボタンは残して、開いたら何が見られるかを伝える
                  <div className="scm-empty">セッションで実行したバックグラウンドタスクが表示されます</div>
                )}
              </div>
              <div hidden={shownPanel !== 'checklist'} className="side-body">
                {selected ? (
                  <ChecklistPanel
                    session={selected}
                    lists={checklists}
                    sessions={sessions ?? NO_SESSIONS}
                    activeCardId={activeCardId}
                    onOpen={openCard}
                  />
                ) : (
                  <div className="scm-empty">セッションのチェックリストが表示されます</div>
                )}
              </div>
              <div hidden={shownPanel !== 'context'} className="side-body">
                {selected ? (
                  <SessionContextPanel
                    key={selected.id}
                    sessionId={selected.id}
                    visible={shownPanel === 'context'}
                    revision={chat.items.length}
                    {...contextUsage(selected.model, screenOf(selected.id)?.model ?? null, statusLineOf(selected.id), knowledgeOf(selected.id).contextTokens)}
                    canCompact={compact.canCompact}
                    compacting={compact.compacting}
                    onCompact={compactWith}
                  />
                ) : (
                  <div className="scm-empty">セッションのコンテキストの中身が表示されます</div>
                )}
              </div>
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
        {commenting && <CommentDialog sessionId={commenting} onClose={() => setCommenting(null)} />}
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
          {walk && !viewingWalk && <WalkthroughBand walkthrough={walk} onShow={showWalk} onClose={closeWalk} />}
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
          {selected && diffView?.source === 'card' && (
            <CardView session={selected} sessions={sessions ?? NO_SESSIONS} lists={checklists} view={diffView} onClose={() => setDiffView(null)} />
          )}
          {viewId && cwd && diffView && diffView.source !== 'task' && diffView.source !== 'preview' && diffView.source !== 'card' && (
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
              walkthrough={walkInDiff ? walkControls : null}
              onAsk={walk ? askRange : undefined}
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
              walkthrough={walkInDiff ? null : walkControls}
              onAsk={walk ? askRange : undefined}
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
            sessionId={toolId}
            visible={diffView?.source === 'preview' && !!toolId}
            liveSessionIds={liveSessionIds}
            onClose={closeCenter}
          />
          <TerminalPanel
            sessionId={toolId}
            claudeScreen={!!selected}
            open={terminal.open}
            view={terminal.view}
            onView={(view) => setTerminal({ open: true, view })}
            onClose={() => setTerminal((t) => ({ ...t, open: false }))}
          />
        </div>
      </div>
      <StatusBar
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
  walkthrough,
  onAsk,
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
  // ウォークスルー（diff のステップのときだけ。ブランチの変更の差分に出す）と「ここを聞く」
  walkthrough: WalkthroughControls | null;
  onAsk: ((question: RangeQuestion) => void) | undefined;
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
        onAsk={onAsk}
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
      walkthrough={walkthrough}
      onAsk={onAsk}
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

// チェックリストのカードの詳細。カードが消えた（ゴミ箱に入れた・ほかのセッションから消した）ら何も出さない
function CardView({
  session,
  sessions,
  lists,
  view,
  onClose,
}: {
  session: SessionSummary;
  sessions: SessionSummary[];
  lists: Checklist[];
  view: { listId: string; cardId: string };
  onClose: () => void;
}) {
  // 別のリストへ移したカードも追いかける
  const list = lists.find((l) => !l.deletedAt && l.cards.some((c) => c.id === view.cardId && !c.deletedAt));
  const card = list?.cards.find((c) => c.id === view.cardId);
  if (!list || !card) return null;
  return <CardPane session={session} sessions={sessions} list={list} card={card} onClose={onClose} />;
}

const renameSession = (id: string, title: string) => void window.tanacode.sessions.rename(id, title);
const unarchiveSession = (id: string) => void window.tanacode.sessions.unarchive(id);
