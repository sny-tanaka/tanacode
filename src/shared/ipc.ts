import type { ChatEvent } from './chat';
import type { Activity, PermissionMode, ScreenInfo } from './screen';
import type { SubagentRun } from './subagent';
import type { SessionKnowledge } from './knowledge';
import type { SessionContext } from './context';
import type { ModelCatalog } from './models';
import type { SettingsFile } from './settings-file';
import type { StatusLineInfo } from './statusline';
import type { SystemStats } from './system';
import type { UsageLimits } from './usage';
import type { AgentLogRef, BashTask, TaskRef } from './task';
import type { AppUpdate } from './app-update';
import type { WorkflowRun } from './workflow';
import type { TranslateResult } from './translate';

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
  SessionsSubmit: 'sessions:submit',
  SessionsInterrupt: 'sessions:interrupt',
  // メニュー（⌘N）から。新規セッションの画面を開かせる
  SessionsNew: 'sessions:new',
  FolderPick: 'folders:pick',
  FolderInfo: 'folders:info',
  FolderFiles: 'folders:files',
  FolderCommands: 'folders:commands',
  FolderOpen: 'folders:open',
  FolderClose: 'folders:close',
  SettingsFilesList: 'settings-files:list',
  SettingsFilesPick: 'settings-files:pick',
  SettingsFilesAdd: 'settings-files:add',
  SettingsFilesRename: 'settings-files:rename',
  SettingsFilesRemove: 'settings-files:remove',
  SettingsFilesChanged: 'settings-files:changed',
  SessionsConfigure: 'sessions:configure',
  SessionsRestart: 'sessions:restart',
  SessionsSetRemoteControl: 'sessions:set-remote-control',
  RemoteControlAvailable: 'remote-control:available',
  SessionsRename: 'sessions:rename',
  SessionsRemove: 'sessions:remove',
  SessionsWorktreeLeftovers: 'sessions:worktree-leftovers',
  SessionsHistory: 'sessions:history',
  // 作業の書き出し。材料（会話ログ）を読む・保存のダイアログで保存する・保存したファイルを Finder で見せる
  SessionsExportSource: 'sessions:export-source',
  SessionsExportSave: 'sessions:export-save',
  SessionsExportReveal: 'sessions:export-reveal',
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
  ShellOpened: 'shell:opened',
  WorkspaceInfo: 'workspace:info',
  ListDir: 'fs:list-dir',
  ReadFile: 'fs:read-file',
  ReadImage: 'fs:read-image',
  FilesChanged: 'fs:changed',
  TasksBash: 'tasks:bash',
  TasksBashChanged: 'tasks:bash-changed',
  TasksAgentLog: 'tasks:agent-log',
  TasksStop: 'tasks:stop',
  KnowledgeGet: 'knowledge:get',
  ContextGet: 'context:get',
  ModelsGet: 'models:get',
  ModelsRefresh: 'models:refresh',
  // チャットの思考・応答の翻訳（macOS 標準の翻訳）。使えるか・訳す・システム設定の「言語と地域」を開く
  TranslateAvailable: 'translate:available',
  TranslateRun: 'translate:run',
  TranslateOpenSettings: 'translate:open-settings',
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
  // アプリ内ブラウザを Claude が操作する（MCP）。main → 画面: 開く・操作中の様子・表示幅 / 画面 → main: webview を作った
  BrowserOpen: 'browser:open',
  BrowserActivity: 'browser:activity',
  BrowserViewport: 'browser:viewport',
  BrowserAttach: 'browser:attach',
  // タブ。main → 画面: 新しいタブで開く・選ぶ・閉じる / 画面 → main: 今のタブが変わった
  BrowserNewTab: 'browser:new-tab',
  BrowserSelectTab: 'browser:select-tab',
  BrowserCloseTab: 'browser:close-tab',
  BrowserActivate: 'browser:activate',
  // 今のページを、ふだんのブラウザで開く
  BrowserOpenExternal: 'browser:open-external',
  BrowserHostsGet: 'browser:hosts-get',
  BrowserHostsSet: 'browser:hosts-set',
  // メニューの「アプリ内ブラウザで Claude に許す先…」から。許す先のダイアログを開かせる
  BrowserHostsOpen: 'browser:hosts-open',
  // Claude がユーザーに操作を頼む（ask_user_to_act）。main → 画面: 頼んだ・終わった / 画面 → main: 今頼んでいるもの・返事 /
  // main → 画面: そのセッションのブラウザを開かせる（頼まれたときの通知をクリックした）
  BrowserAsk: 'browser:ask',
  BrowserAsksGet: 'browser:asks-get',
  BrowserAnswer: 'browser:answer',
  BrowserShow: 'browser:show',
} as const;

// アプリ内ブラウザのページの中の位置と大きさ（CSS の px。見えている範囲の左上から）
export type BrowserRect = { x: number; y: number; width: number; height: number };

// Claude がアプリ内ブラウザを操作している様子。active: 「Claude が操作中」の帯を出す / label: 今の操作（終わったら null）/
// box: これから押す要素（枠を出す）
export type BrowserActivity = { sessionId: string; active: boolean; label: string | null; box: BrowserRect | null };

// Claude が、まだブラウザを開いていないセッションでページを開いた
export type BrowserOpenRequest = { sessionId: string; url: string };

// 新しいタブで開く。ページが新しいウィンドウで開こうとした（target=_blank・window.open）か、Claude が新しいタブで開いた。
// background: 裏で開く（⌘ を押したままのクリック）/ openerTabId: 開いたページのタブ
export type BrowserNewTabRequest = { sessionId: string; url: string; background: boolean; openerTabId: string | null };

// セッションのタブ
export type BrowserTabRef = { sessionId: string; tabId: string };

// Claude が表示幅を変えた（0 は全幅）
export type BrowserViewportChange = { sessionId: string; width: number };

// Claude がユーザーに頼んでいる操作（ask_user_to_act）。id: 頼むたびに変わる（返事をどの頼みへのものか見分ける）/ message: 頼む内容
export type BrowserAsk = { id: string; message: string };
// 頼んだ・終わった（ask が null）
export type BrowserAskChange = { sessionId: string; ask: BrowserAsk | null };
// ユーザーの返事。done: 「終わった」/ そうでなければ「できない」で、reason はその理由（書かなければ空）
export type BrowserAnswer = { done: boolean; reason: string };

export type SessionAttention = 'question' | 'permission' | 'other' | 'browser' | null;

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
  // other: フォルダの信頼確認や認識できない対話画面など / browser: アプリ内ブラウザでの操作の依頼（ask_user_to_act）/ null: 待っていない
  attention: SessionAttention;
  // 実行中のバックグラウンドタスク（サブエージェント・ワークフロー・Bash）の数
  backgroundTasks: number;
  model: string | null;
  effort: string | null;
  // 起動に重ねる、登録した設定ファイルの ID（SettingsFile.id）。null は標準の設定のまま
  settingsFile: string | null;
  // Remote Control を使うか（このセッションの指定。実際につながっているかは会話ログの bridge_status で分かる）
  remoteControl: boolean;
  // worktree で始めたセッション（cwd は worktree のフォルダ）。null はふつうのセッション
  worktree: SessionWorktree | null;
  // 親セッションの ID（親の Claude が start_session で起動した子セッション）。無ければ親のないセッション
  parentId?: string | null;
};

// worktree のセッション。name: worktree の名前（claude --worktree に渡したもの）/ branch: Claude Code が作ったブランチ /
// root: 元のフォルダ（リポジトリのいちばん上）/ preparing: 準備の途中（終わるまで最初の指示を送らない）
export type SessionWorktree = { name: string; branch: string; root: string; preparing: WorktreePreparing | null };
// creating: Claude Code が worktree を作るのを待っている / restoring: 消した worktree を、残したブランチから作り直している /
// copying: node_modules を複製している / installing: パッケージマネージャーの install（npm install など）を実行している
export type WorktreePreparing = 'creating' | 'restoring' | 'copying' | 'installing';

// worktree を消す前に、残っているもの。数は件数
export type WorktreeLeftovers = {
  // worktree のフォルダがある
  exists: boolean;
  branch: string;
  // 未コミットの変更（追跡しているファイル）と、未追跡のファイル
  uncommitted: number;
  untracked: number;
  // プッシュしていないコミット（上流が無ければ、どのリモートにも、ほかのブランチにも無いコミット）。PR の head に入っているコミットは、
  // マージのあとにリモートのブランチを消していても GitHub にあるので数えない。中身がデフォルトブランチに入っていれば（手元での
  // スカッシュマージ・cherry-pick など）0 で、contentIn にそのブランチの名前（そうでなければ null）
  unpushed: number;
  contentIn: string | null;
  pr: WorktreePr;
};

// worktree のブランチから作った PR（gh で調べる。PR がいくつかあれば、開いているもの → マージ済み → 閉じたものの順に、新しいもの）。
// none: PR が無い / unknown: 調べられない（gh が無い・ログインしていない・GitHub のリポジトリでないなど）/
// after: PR の head のあとに、手元で足したコミットの数（head のコミットが手元に無ければ null）
export type WorktreePr =
  | { state: 'open' | 'merged' | 'closed'; number: number; base: string; url: string; after: number | null }
  | { state: 'none' }
  | { state: 'unknown' };

// アーカイブ・一覧からの削除のときの指定。removeWorktree: worktree のセッションなら、worktree も消す
export type ArchiveOptions = { removeWorktree: boolean };
// worktree を消した結果。backupRef: 未コミットの変更の控え（無ければ null）/ branchKept: 手元にしか無いコミットがあり、ブランチを残した
export type WorktreeRemoval = { backupRef: string | null; branch: string; branchKept: boolean };

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
// 作業の書き出しの材料。events: 会話ログ全体から作ったチャットのイベント（画像は画像置き場に入れ直してある）/
// branches: 作業したブランチ（会話ログの行に残ったもの。出てきた順）/ home: ホームフォルダ（~ に置き換えるため）
export type ExportSource = { events: ChatEvent[]; branches: string[]; home: string };
// アプリの外で作られた Claude Code の会話
export type DiscoveredSession = { claudeSessionId: string; cwd: string; title: string; updatedAt: number };

// settingsFile を変えると、モデルとエフォートは新しい設定ファイルの既定に戻る（設定によって選べるモデルが違うため）
export type SessionOptions = { model: string | null; effort: string | null; settingsFile: string | null };
// 新規セッションを始めるときの指定。どれも null なら Claude Code の既定値（ユーザー設定）
// worktree: claude --worktree で、新しい worktree に分けて始める
export type NewSessionOptions = SessionOptions & { mode: PermissionMode | null; remoteControl: boolean; worktree: boolean };
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
// アプリが開いたコマンドのターミナル（worktree の npm install など）。owner: セッションの id
export type ShellOpened = { owner: string; id: string; name: string };

export type WorkspaceInfo = { root: string; name: string; branch: string | null };
export type DirEntry = { name: string; path: string; isDir: boolean };
export type FileContent =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  // 画像（PNG・JPEG など。SVG は文字なので text）。url は data URL（レンダラーはファイルを直接読めない）
  | { kind: 'image'; url: string }
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
    // worktree のセッションで removeWorktree を指定すると、Claude Code が終わるのを待ってから worktree も消す（消せなければ理由を添えて失敗する）
    archive(id: string, options?: ArchiveOptions): Promise<WorktreeRemoval | null>;
    unarchive(id: string): Promise<void>;
    // 表示中のセッション。通知の要否と未読の解除に使う
    focus(id: string | null): void;
    snapshot(id: string): Promise<SessionSnapshot>;
    // Claude Code の入力欄に打ち込んで送る。画像はパスを貼り付けとして送ると [Image #n] として添付される。
    // 同じセッションへの送信（親セッションからの指示を含む）は、混ざらないよう 1 つずつ順に送る
    submit(id: string, text: string, attachments: string[]): Promise<void>;
    // 作業を中断する（Esc を送る）
    interrupt(id: string): void;
    // モデル・エフォート・設定ファイルを変える。起動中なら --resume で起動し直して反映する。設定ファイルを読めなければ理由を添えて失敗する
    configure(id: string, options: SessionOptions): Promise<void>;
    // Claude Code を起動し直して同じ会話を続ける（スキルや設定を読み込み直す）
    restart(id: string): Promise<void>;
    // このセッションの Remote Control を切り替える。動いていればその場でつなぐ・切る。切り替えられなかったら理由を返す
    setRemoteControl(id: string, on: boolean): Promise<string | null>;
    // Remote Control を使えるか（開発版では、TANACODE_REMOTE_CONTROL=1 で起動したときだけ使える）
    remoteControlAvailable(): Promise<boolean>;
    rename(id: string, title: string): Promise<void>;
    // 一覧から消す（会話ログは残る）。removeWorktree は archive と同じ
    remove(id: string, options?: ArchiveOptions): Promise<WorktreeRemoval | null>;
    // worktree を消す前に、残っているもの（worktree のセッションでなければ null）
    worktreeLeftovers(id: string): Promise<WorktreeLeftovers | null>;
    // 再開せずに会話ログから作ったチャット（アーカイブ済みセッションの表示用）
    history(id: string): Promise<ChatEvent[]>;
    // 会話ログに埋め込まれた画像（イベントの images の鍵）。data URL。もう持っていなければ null
    image(key: string): Promise<string | null>;
    // 作業の書き出しの材料（会話ログを読み直す）
    exportSource(id: string): Promise<ExportSource>;
    // 書き出した HTML を、保存のダイアログで選んだ場所に保存する。保存したパスを返す（取りやめたら null）。どこにも送らない
    saveExport(html: string, fileName: string): Promise<string | null>;
    // 保存した書き出しのファイルを Finder で見せる（このアプリが保存したものだけ）
    revealExport(path: string): void;
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
  // 登録した設定ファイル（セッションごとに選んで、標準の設定に重ねて起動する）
  settingsFiles: {
    list(): Promise<SettingsFile[]>;
    // ファイルの選択ダイアログを開き、選んだファイルのパスを返す（取りやめたら null）
    pick(): Promise<string | null>;
    // 登録する。name を省くと、ファイル名から付ける。読めないファイルなら、理由を添えて失敗する
    add(path: string, name?: string): Promise<SettingsFile>;
    // 名前を変える。空の名前や、ほかと同じ名前なら、理由を添えて失敗する
    rename(id: string, name: string): Promise<void>;
    // 登録から外す（ファイル自体は消さない）。使っているセッションは、次に起動するときに理由を出して断る
    remove(id: string): Promise<void>;
    onChanged(listener: (files: SettingsFile[]) => void): () => void;
  };
  models: {
    // Claude Code が持っているモデル一覧の控え（~/.claude/cache/model-catalog）。無ければ null
    get(): Promise<ModelCatalog | null>;
    // Claude Code が持っているモデル一覧の控えを読み直す
    refresh(): Promise<{ catalog: ModelCatalog } | { error: string }>;
  };
  // チャットの思考・応答を、macOS 標準の翻訳で日本語に訳す（Mac の中だけで訳し、外へは送らない）
  translate: {
    // macOS 15 以降で、翻訳の補助プログラムがあるか
    available(): Promise<boolean>;
    // 1 行ずつ訳す（返す texts は同じ順・同じ数）。形が違う・長すぎるときは reject
    run(texts: string[]): Promise<TranslateResult>;
    // 翻訳データを入れてもらうために、システム設定の「言語と地域」を開く
    openSettings(): Promise<void>;
  };
  // Claude が読んだ・書いたファイルと、コンテキストの使用量
  knowledge: {
    get(sessionId: string): Promise<SessionKnowledge>;
    onChanged(listener: (payload: SessionKnowledgeChanged) => void): () => void;
  };
  // コンテキストの中身（読んだファイル・大きなツールの結果・画像・サブエージェントの結果・発言ごとのやりとり）
  context: {
    get(sessionId: string): Promise<SessionContext>;
  };
  tasks: {
    // バックグラウンドで動かした Bash
    bash(sessionId: string): Promise<BashTask[]>;
    onBashChanged(listener: (payload: SessionBashTasks) => void): () => void;
    // サブエージェント・ワークフローのエージェントの会話（読むたびに全体を返す）
    agentLog(sessionId: string, ref: AgentLogRef): Promise<ChatEvent[]>;
    // 動いているバックグラウンドのもの（サブエージェント・ワークフロー・Bash）を止める。止められなかったら理由を返す
    stop(sessionId: string, ref: TaskRef): Promise<string | null>;
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
    // アプリがコマンドのターミナルを開いた（終わってもタブは残す）
    onOpened(listener: (payload: ShellOpened) => void): () => void;
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
  // Claude によるアプリ内ブラウザの操作（Claude Code に足す MCP サーバー tanacode-browser）
  browser: {
    // タブの webview を作った（main が、その中身を操作できるようにする）
    attach(sessionId: string, tabId: string, webContentsId: number): void;
    // 今のタブが変わった（タブが無くなったら null）。Claude の操作は今のタブに対して行う
    activate(sessionId: string, tabId: string | null): void;
    onOpen(listener: (request: BrowserOpenRequest) => void): () => void;
    onNewTab(listener: (request: BrowserNewTabRequest) => void): () => void;
    onSelectTab(listener: (tab: BrowserTabRef) => void): () => void;
    onCloseTab(listener: (tab: BrowserTabRef) => void): () => void;
    // ふだんのブラウザで開く（http(s) だけ）
    openExternal(url: string): Promise<void>;
    onActivity(listener: (activity: BrowserActivity) => void): () => void;
    onViewport(listener: (change: BrowserViewportChange) => void): () => void;
    // ユーザーが足した、Claude に許す先（localhost などの既定は含まない）
    hosts(): Promise<string[]>;
    // 書き方をそろえて保存し、保存したものを返す。書き方が違うものがあれば、理由を添えて失敗する
    setHosts(hosts: string[]): Promise<string[]>;
    onHostsOpen(listener: () => void): () => void;
    // Claude がユーザーに頼んでいる操作。asks: 今頼んでいるもの（画面を作り直したとき用）/ answer: ユーザーの返事 /
    // onShow: そのセッションを選んで、ブラウザを開く（頼まれたときの通知をクリックした）
    onAsk(listener: (change: BrowserAskChange) => void): () => void;
    asks(): Promise<BrowserAskChange[]>;
    answer(sessionId: string, askId: string, answer: BrowserAnswer): void;
    onShow(listener: (sessionId: string) => void): () => void;
  };
  // ドロップされたファイルの実際のパス
  pathForFile(file: File): string;
};
