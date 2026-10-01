import type { ChatEvent } from './chat';
import type { Activity, PermissionMode, ScreenInfo } from './screen';
import type { SubagentRun } from './subagent';
import type { SessionKnowledge } from './knowledge';
import type { ModelCatalog } from './models';
import type { StatusLineInfo } from './statusline';
import type { SystemStats } from './system';
import type { UsageLimits } from './usage';
import type { AgentLogRef, BashTask } from './task';
import type { AppUpdate } from './app-update';
import type { WorkflowRun } from './workflow';

export const IpcChannel = {
  SessionsList: 'sessions:list',
  SessionsChanged: 'sessions:changed',
  SessionsCreate: 'sessions:create',
  SessionsOpen: 'sessions:open',
  SessionsArchive: 'sessions:archive',
  SessionsUnarchive: 'sessions:unarchive',
  SessionsFocus: 'sessions:focus',
  SessionsSnapshot: 'sessions:snapshot',
  SessionsSelect: 'sessions:select',
  // メニュー（⌘N）から。新規セッションの画面を開かせる
  SessionsNew: 'sessions:new',
  FolderPick: 'folders:pick',
  FolderInfo: 'folders:info',
  FolderFiles: 'folders:files',
  FolderCommands: 'folders:commands',
  FolderOpen: 'folders:open',
  FolderClose: 'folders:close',
  SessionsConfigure: 'sessions:configure',
  SessionsRestart: 'sessions:restart',
  SessionsSetRemoteControl: 'sessions:set-remote-control',
  RemoteControlAvailable: 'remote-control:available',
  SessionsRename: 'sessions:rename',
  SessionsRemove: 'sessions:remove',
  SessionsHistory: 'sessions:history',
  ChatImage: 'chat:image',
  SessionsDiscover: 'sessions:discover',
  SessionsImport: 'sessions:import',
  ScreenGet: 'screen:get',
  ScreenChanged: 'screen:changed',
  ScreenChoose: 'screen:choose',
  ScreenActivityGet: 'screen:activity-get',
  ScreenActivity: 'screen:activity',
  WorkflowsGet: 'workflows:get',
  WorkflowsChanged: 'workflows:changed',
  SubagentsGet: 'subagents:get',
  ScreenSetMode: 'screen:set-mode',
  ScreenRewind: 'screen:rewind',
  ListFiles: 'fs:list-files',
  WriteFile: 'fs:write-file',
  Search: 'fs:search',
  GitState: 'git:state',
  GitBranches: 'git:branches',
  GitRun: 'git:run',
  GitDiffSides: 'git:diff-sides',
  GitBranchDiffSides: 'git:branch-diff-sides',
  GitBaseline: 'git:baseline',
  GitLastMessage: 'git:last-message',
  CommandsList: 'commands:list',
  AttachmentSave: 'attachments:save',
  SubagentsChanged: 'subagents:changed',
  ChatEvents: 'chat:events',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  PtyResetSize: 'pty:reset-size',
  PtyData: 'pty:data',
  ShellCreate: 'shell:create',
  ShellWrite: 'shell:write',
  ShellResize: 'shell:resize',
  ShellKill: 'shell:kill',
  ShellData: 'shell:data',
  ShellExit: 'shell:exit',
  WorkspaceInfo: 'workspace:info',
  ListDir: 'fs:list-dir',
  ReadFile: 'fs:read-file',
  ReadImage: 'fs:read-image',
  FilesChanged: 'fs:changed',
  TasksBash: 'tasks:bash',
  TasksBashChanged: 'tasks:bash-changed',
  TasksAgentLog: 'tasks:agent-log',
  KnowledgeGet: 'knowledge:get',
  ModelsGet: 'models:get',
  ModelsRefresh: 'models:refresh',
  UsageGet: 'usage:get',
  UsageRefresh: 'usage:refresh',
  UsageChanged: 'usage:changed',
  NotificationsGet: 'notifications:get',
  NotificationsSet: 'notifications:set',
  StatusLineGet: 'statusline:get',
  SystemStats: 'system:stats',
  ClaudeVersionGet: 'claude:version-get',
  ClaudeVersionChanged: 'claude:version-changed',
  AppUpdateGet: 'app-update:get',
  AppUpdateChanged: 'app-update:changed',
  StatusLineChanged: 'statusline:changed',
  KnowledgeChanged: 'knowledge:changed',
} as const;

export type SessionAttention = 'question' | 'permission' | 'other' | null;

export type SessionSummary = {
  id: string;
  title: string | null;
  cwd: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  unread: boolean;
  // ユーザーの操作を待っているもの。question: AskUserQuestion / permission: ツール実行の許可 /
  // other: フォルダの信頼確認や認識できない対話画面など / null: 待っていない
  attention: SessionAttention;
  // 実行中のバックグラウンドタスク（サブエージェント・ワークフロー・Bash）の数
  backgroundTasks: number;
  model: string | null;
  effort: string | null;
  // Remote Control を使うか（このセッションの指定。実際につながっているかは会話ログの bridge_status で分かる）
  remoteControl: boolean;
};

export type SearchOptions = { caseSensitive: boolean; regex: boolean };
// matchStart / matchLength は text（行の一部を抜き出したもの）の中での位置
export type SearchMatch = { line: number; column: number; text: string; matchStart: number; matchLength: number };
export type SearchResult = { files: { path: string; matches: SearchMatch[] }[]; truncated: boolean; error?: string };

// git status の 1 件。index / worktree は --porcelain の 2 文字（'?' は未追跡）
export type GitEntry = { path: string; from?: string; index: string; worktree: string };
export type GitState =
  | { isRepo: false }
  | {
      isRepo: true;
      branch: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      empty: boolean;
      entries: GitEntry[];
      // 今のブランチの基点から作業ツリーまでの変更（基点が決まらなければ null）
      branchChanges: BranchChanges | null;
    };
// ブランチの差分の基点。branch: 分岐元のブランチとの分岐点 / upstream: main など基点のブランチにいるときの上流
export type BranchBase = { ref: string; mergeBase: string; kind: 'branch' | 'upstream' };
export type BranchChanges = { base: BranchBase; files: Record<string, FileChange> };
export type GitDiffSides = { original: string; modified: string };
// ソース管理パネルからの操作
export type GitAction =
  | { kind: 'stage' | 'unstage' | 'discard'; paths: string[] }
  | { kind: 'commit'; message: string; amend: boolean }
  | { kind: 'push' | 'pull' | 'fetch' }
  | { kind: 'checkout'; branch: string; mode: 'local' | 'remote' | 'create' }
  // リモートの最新を取り込み、デフォルトブランチに切り替えて最新にする
  | { kind: 'switch-default' };
// ブランチの切り替えの候補。defaultBranch: デフォルトブランチの名前（分からなければ null）
export type GitBranches = { local: string[]; remote: string[]; defaultBranch: string | null };

// / で始まる入力の補完候補
// source の skill は Claude Code が会話ログに書いたスキルの一覧から（組み込み・プラグインのスキルを含む）。aliases は別名
export type SlashCommand = { name: string; description: string; source: 'builtin' | 'project' | 'user' | 'skill'; aliases?: string[] };

export type SessionWorkflows = { sessionId: string; runs: WorkflowRun[] };
export type SessionSubagents = { sessionId: string; runs: SubagentRun[] };
export type SessionBashTasks = { sessionId: string; tasks: BashTask[] };
export type SessionKnowledgeChanged = { sessionId: string; knowledge: SessionKnowledge };
export type SessionStatusLine = { sessionId: string; info: StatusLineInfo };
// アプリの外で作られた Claude Code の会話
export type DiscoveredSession = { claudeSessionId: string; cwd: string; title: string; updatedAt: number };

export type SessionOptions = { model: string | null; effort: string | null };
// 新規セッションを始めるときの指定。どれも null なら Claude Code の既定値（ユーザー設定）
export type NewSessionOptions = SessionOptions & { mode: PermissionMode | null; remoteControl: boolean };
export type SessionScreen = { sessionId: string; info: ScreenInfo };
export type SessionActivity = { sessionId: string; activity: Activity | null };
// optionId の選択肢にカーソルを合わせて key を送る。text は自由記述の入力。
// none: 何も送らない（複数選択の自由記述は、打つだけでチェックが付く）
export type ScreenChoice = { optionId: string; key: 'enter' | 'space' | 'none'; text?: string };

// seq はセッションごとのイベント通し番号。スナップショットとライブ配信の重複を除くのに使う
// live: 今まさに起きたこと。false は再開時に読み込んだ過去の会話
export type ChatBatch = { sessionId: string; fromSeq: number; events: ChatEvent[]; live: boolean };
export type SessionSnapshot = { sessionId: string; fromSeq: number; events: ChatEvent[] };
export type PtyData = { sessionId: string; data: string };
// ユーザーが開いたシェル（統合ターミナル）
export type ShellData = { id: string; data: string };
export type ShellExit = { id: string; exitCode: number };

export type WorkspaceInfo = { root: string; name: string; branch: string | null };
export type DirEntry = { name: string; path: string; isDir: boolean };
export type FileContent =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number };
// paths は root からの相対パス
export type FilesChanged = { root: string; paths: string[] };

// ブランチの基点から変わったファイル（差分の行数）。binary は行数を数えられないファイル
export type FileChange = { kind: 'added' | 'modified' | 'deleted'; added: number; removed: number; binary?: boolean };
// 基点での内容。exists: false は基点の後に作られたファイル
export type FileBaseline = { exists: boolean; text: string };

export type TanacodeApi = {
  sessions: {
    list(): Promise<SessionSummary[]>;
    // cwd のフォルダで新しいセッションを始める。作ったセッションの id を返す
    create(cwd: string, options: NewSessionOptions): Promise<string>;
    open(id: string): Promise<void>;
    archive(id: string): Promise<void>;
    unarchive(id: string): Promise<void>;
    // 表示中のセッション。通知の要否と未読の解除に使う
    focus(id: string | null): void;
    snapshot(id: string): Promise<SessionSnapshot>;
    // モデル・エフォートを変える。起動中なら --resume で起動し直して反映する
    configure(id: string, options: SessionOptions): Promise<void>;
    // Claude Code を起動し直して同じ会話を続ける（スキルや設定を読み込み直す）
    restart(id: string): Promise<void>;
    // このセッションの Remote Control を切り替える。動いていればその場でつなぐ・切る。切り替えられなかったら理由を返す
    setRemoteControl(id: string, on: boolean): Promise<string | null>;
    // Remote Control を使えるか（開発版では、TANACODE_REMOTE_CONTROL=1 で起動したときだけ使える）
    remoteControlAvailable(): Promise<boolean>;
    rename(id: string, title: string): Promise<void>;
    // 一覧から消す（会話ログは残る）
    remove(id: string): Promise<void>;
    // 再開せずに会話ログから作ったチャット（アーカイブ済みセッションの表示用）
    history(id: string): Promise<ChatEvent[]>;
    // 会話ログに埋め込まれた画像（イベントの images の鍵）。data URL。もう持っていなければ null
    image(key: string): Promise<string | null>;
    discover(): Promise<DiscoveredSession[]>;
    // 既存の会話を取り込み、再開する。作ったセッションの id を返す
    import(session: DiscoveredSession): Promise<string>;
    onChanged(listener: (sessions: SessionSummary[]) => void): () => void;
    onSelect(listener: (id: string) => void): () => void;
    onNew(listener: () => void): () => void;
    onChat(listener: (batch: ChatBatch) => void): () => void;
  };
  screen: {
    get(sessionId: string): Promise<ScreenInfo | null>;
    choose(sessionId: string, choice: ScreenChoice): Promise<void>;
    // 権限モードを Shift+Tab で切り替える（このセッションだけ）
    setMode(sessionId: string, mode: PermissionMode): Promise<boolean>;
    // text で始まる発言の直前まで巻き戻す（/rewind の一覧から選ぶ）
    rewind(sessionId: string, text: string): Promise<boolean>;
    onChanged(listener: (payload: SessionScreen) => void): () => void;
    // 作業中の進み具合（画面のタイマーの行）。作業中でなければ null
    activity(sessionId: string): Promise<Activity | null>;
    onActivity(listener: (payload: SessionActivity) => void): () => void;
  };
  workflows: {
    get(sessionId: string): Promise<WorkflowRun[]>;
    onChanged(listener: (payload: SessionWorkflows) => void): () => void;
  };
  subagents: {
    get(sessionId: string): Promise<SubagentRun[]>;
    onChanged(listener: (payload: SessionSubagents) => void): () => void;
  };
  // プランの利用枠（5 時間枠・週の枠）。セッションの応答のたびに statusLine から更新される
  usage: {
    get(): Promise<UsageLimits | null>;
    // Claude Code 自身の控え（/usage を開いたときのもの）の方が新しければ読み込む
    refresh(): Promise<void>;
    onChanged(listener: (usage: UsageLimits) => void): () => void;
  };
  // macOS の通知（作業の完了・確認待ち）を出すか。ウインドウ右上のベルで切り替える。アプリ側に保存し、Claude Code の設定は変えない
  notifications: {
    get(): Promise<boolean>;
    set(on: boolean): Promise<void>;
  };
  // この Mac の CPU・メモリの使用状況（2 秒ごと）
  system: {
    onStats(listener: (stats: SystemStats) => void): () => void;
  };
  // 入っている Claude Code の版（`claude --version`。見つからなければ null）。起動時・10 分ごと・ウィンドウを前に出したときに確かめる
  claudeVersion: {
    get(): Promise<string | null>;
    onChanged(listener: (version: string | null) => void): () => void;
  };
  // tanacode の新しいバージョン（GitHub の Releases）。起動時と 1 時間ごとに確かめる。まだ分からない・確かめる設定がオフなら null
  appUpdate: {
    get(): Promise<AppUpdate | null>;
    onChanged(listener: (update: AppUpdate | null) => void): () => void;
  };
  // セッションごとの statusLine（モデル・コンテキスト・利用枠）
  statusLine: {
    get(sessionId: string): Promise<StatusLineInfo | null>;
    onChanged(listener: (payload: SessionStatusLine) => void): () => void;
  };
  // モデル欄の選択肢（Claude Code の /model の一覧）
  models: {
    // Claude Code が持っているモデル一覧の控え（~/.claude/cache/model-catalog）。無ければ null
    get(): Promise<ModelCatalog | null>;
    // Claude Code が持っているモデル一覧の控えを読み直す
    refresh(): Promise<{ catalog: ModelCatalog } | { error: string }>;
  };
  // Claude が読んだ・書いたファイルと、コンテキストの使用量
  knowledge: {
    get(sessionId: string): Promise<SessionKnowledge>;
    onChanged(listener: (payload: SessionKnowledgeChanged) => void): () => void;
  };
  tasks: {
    // バックグラウンドで動かした Bash
    bash(sessionId: string): Promise<BashTask[]>;
    onBashChanged(listener: (payload: SessionBashTasks) => void): () => void;
    // サブエージェント・ワークフローのエージェントの会話（読むたびに全体を返す）
    agentLog(sessionId: string, ref: AgentLogRef): Promise<ChatEvent[]>;
  };
  pty: {
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    // 既定の大きさに戻す（Claude Code の画面を閉じたとき）
    resetSize(sessionId: string): void;
    onData(listener: (payload: PtyData) => void): () => void;
  };
  shell: {
    // セッションのフォルダでログインシェルを開く
    create(sessionId: string, cols: number, rows: number): Promise<{ id: string; name: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    onData(listener: (payload: ShellData) => void): () => void;
    onExit(listener: (payload: ShellExit) => void): () => void;
  };
  // まだセッションが無いフォルダ（新規セッションの画面で選んだもの）
  folders: {
    // フォルダ選択ダイアログ。キャンセル時は null
    pick(): Promise<string | null>;
    // フォルダが無ければ null
    info(cwd: string): Promise<WorkspaceInfo | null>;
    listFiles(cwd: string): Promise<string[]>;
    commands(cwd: string): Promise<SlashCommand[]>;
    // フォルダを右パネル（エクスプローラー・ソース管理・検索）とエディタで開き、workspace・git に渡す id を返す。
    // セッションの id と同じように使える。使い終わったら close する
    open(cwd: string): Promise<string>;
    close(id: string): void;
  };
  // sessionId には、セッションの id のほか folders.open で開いたフォルダの id も渡せる
  workspace: {
    info(sessionId: string): Promise<WorkspaceInfo>;
    listDir(sessionId: string, relPath: string): Promise<DirEntry[]>;
    readFile(sessionId: string, relPath: string): Promise<FileContent>;
    // 画像を data URL で読む（画像でない・大きすぎるときは null）
    readImage(sessionId: string, relPath: string): Promise<string | null>;
    writeFile(sessionId: string, relPath: string, text: string): Promise<void>;
    onFilesChanged(listener: (payload: FilesChanged) => void): () => void;
    // ワークスペースの全ファイル（フォルダからの相対パス）
    listFiles(sessionId: string): Promise<string[]>;
    search(sessionId: string, query: string, options: SearchOptions): Promise<SearchResult>;
  };
  git: {
    state(sessionId: string): Promise<GitState>;
    branches(sessionId: string): Promise<GitBranches>;
    // 失敗したら git のエラーメッセージ、成功したら null
    run(sessionId: string, action: GitAction): Promise<string | null>;
    diffSides(sessionId: string, relPath: string, staged: boolean): Promise<GitDiffSides>;
    // ブランチの差分の左右（基点 ↔ 作業ツリー）と、基点での内容（エディタで変わった行を示すため）
    branchDiffSides(sessionId: string, mergeBase: string, relPath: string): Promise<GitDiffSides>;
    baseline(sessionId: string, mergeBase: string, relPath: string): Promise<FileBaseline>;
    lastCommitMessage(sessionId: string): Promise<string>;
  };
  commands: {
    list(sessionId: string): Promise<SlashCommand[]>;
  };
  attachments: {
    // 貼り付け・ドロップされた画像を一時ファイルに保存し、そのパスを返す
    save(name: string, data: Uint8Array): Promise<string>;
  };
  // ドロップされたファイルの実際のパス
  pathForFile(file: File): string;
};
