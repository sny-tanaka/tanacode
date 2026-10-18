import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  bridgeUrlOf,
  isTranscriptEntry,
  retractedUuidsOf,
  toChatEvents,
  transcriptTitle,
  unsentView,
  type ChatEvent,
  type HookRun,
  type PartialBlock,
  type TranscriptEntry,
  type UnsentPrompt,
} from '@shared/chat';
import { bracketedPaste, stripControlChars } from '@shared/paste';
import { t, type MessageKey } from '@shared/i18n';
import type { CarriedTask } from '@shared/optimized-compact';
import { modeWithin, type SessionState } from '@shared/session-tools';
import type {
  ArchiveOptions,
  ChatBatch,
  ExportSource,
  NewSessionOptions,
  RewindChoice,
  RewindOutcome,
  RewindPreview,
  SessionOptions,
  SessionSnapshot,
  SessionAttention,
  SessionSummary,
  SlashCommand,
  WorktreeLeftovers,
  WorktreePreparing,
  WorktreeRemoval,
} from '@shared/ipc';
import type { Activity, Menu, PermissionMode } from '@shared/screen';
import { tanacodeToolLabel } from '@shared/tool-label';
import type { SubagentRun } from '@shared/subagent';
import type { SessionKnowledge } from '@shared/knowledge';
import type { SessionContext } from '@shared/context';
import type { StatusLineInfo } from '@shared/statusline';
import type { AgentLogRef, BashTask, TaskRef } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import type { SessionModel } from '@shared/models';
import type { PendingPermission, PendingQuestion, PermissionReply, QuestionReply } from '@shared/questions';
import { checkedContent, type ElicitationReply, type PendingElicitation } from '@shared/elicitation';
import { BashTaskTracker } from './bash-task-tracker';
import { branchCut, readAgentLog, readChatLog, readExportLog, retract, type ChainEntry } from './chat-log';
import { ClaudeSession, transcriptPath, type LaunchKind } from './claude-session';
import { claudeConfigDir, settingsDefaultMode } from './claude-config';
import { commandsFromInitialize } from './commands';
import { blockedByPreCompact } from './auto-compact';
import { turnStarterOf, type TurnNotice, type TurnStarter } from './compact-notice';
import type { BrowserMcpLaunch } from './browser-bridge';
import type { McpLaunch } from './mcp-bridge';
import { PendingQuestions } from './pending-questions';
import type { TerminalMcpLaunch } from './terminal-bridge';
import type { PreparedSettings, SettingsFiles } from './settings-files';
import { KnowledgeTracker } from './knowledge-tracker';
import { askQuestionsOf, elicitationOf, elicitationResult, PLAN_TOOL, permissionOf, permissionResult, questionResult } from './requests';
import { stopLeftoverClaude, type ClaudeProcess } from './leftover-claude';
import { ContextTracker, readContext } from './context-tracker';
import type { PtyHostApi } from './pty-host-client';
import type { HostedInfo, HostedPipeInfo, HostedPtyInfo } from './pty-host-protocol';
import { rememberImage } from './image-cache';
import { TaskRouter } from './task-router';
import type { StatusLineWatcher } from './statusline';
import { SubagentTracker } from './subagent-tracker';
import { WorkflowTracker } from './workflow-tracker';
import type { SessionRecord, SessionStore } from './session-store';
import { SendError } from './send-error';
import type { WorkspaceWatchers } from './workspace-watcher';
import { disableRemoteControl, enableRemoteControl, generateTitle, rewindConversation, type RewindResult } from './stream/internal';
import { ControlError } from './stream/client';
import { LineLog } from './stream/log';
import type {
  AssistantMessage,
  BridgeStateMessage,
  CanUseToolRequest,
  CommandLifecycleMessage,
  CommandsChangedMessage,
  ContentBlock,
  ContextUsageResponse,
  ElicitationCompleteMessage,
  ElicitationRequest,
  HookResponseMessage,
  HookStartedMessage,
  InitializeResponse,
  ModelInfo,
  ModelRefusalFallbackMessage,
  NotificationMessage,
  PermissionCheckStatusMessage,
  ResultMessage,
  RewindFilesResult,
  SettingsResponse,
  StatusMessage,
  StreamMessage,
  TaskNotificationMessage,
  TaskStartedMessage,
  UsageResponse,
  UserMessage,
} from './stream/protocol';
import { notificationEvent } from './stream/notification';
import { PartialText } from './stream/partial';
import { appMode, elapsedText, modelName, Progress, rateLimitsOf, streamMode, usageLimitsOf, type UsageReport } from './stream/state';
import {
  hideWorktrees,
  planWorktree,
  prepareNodeModules,
  removeWorktree,
  restoreWorktree,
  waitForWorktree,
  worktreeLeftovers,
  type NodeModulesResult,
} from './worktree';

// rename で付けた名前。会話ログのタイトル（最大 3）より常に優先する
const USER_TITLE_PRIORITY = 4;
// 会話ログのタイトルのうち、最初の発言のもの（これより高いものは ai-title・custom-title）
const FIRST_PROMPT_TITLE_PRIORITY = 1;

// ターンの終わり（result）のあと、そのターンの最後の応答が会話ログに出るのを待つ上限（出たら、チャットにターンの終わりを出す。設計書 7 節）。
// result は会話ログより先に届くので、先に出すと実行中のツールをいったんエラーにしてしまう
const TURN_END_WAIT_MS = 3000;
// 会話ログに出た送った発言の uuid を覚えておく数（応答の前に終わったターンの終わりを、発言が出てから出すため）
const MAX_ARRIVED_PROMPTS = 50;
// 送った発言が Claude Code に受け付けられた知らせ（command_lifecycle）も会話ログの行も来ないまま、送信中として扱う上限
const SENDING_TIMEOUT_MS = 30_000;
// 再起動の途中に送った発言が、起動し直した claude（止められなかったときは、止めようとした claude）が受け付けるようになるのを待つ上限
// （待ちきれなければ、送らずに失敗する。画面は、送れなかった発言を預かりに戻す）
const RESTART_SEND_WAIT_MS = 60_000;
// initialize の返事が無いまま、起動に時間がかかっていると知らせるまで（経過と標準エラーの末尾を出す。設計書 9 節の「起動が遅いときの案内」）
const SLOW_START_MS = 10_000;
// プランの利用枠を get_usage で聞き直す間隔の下限（サーバーに聞くため。プロファイル＝SessionManager ごとに）
const USAGE_INTERVAL_MS = 5 * 60_000;
// 何も出力しなかったフックをチャットに出すときの控えの上限（quietHook）。始まった時刻・stream で見たツールの呼び出し・チャットに出したカード
const MAX_HOOK_STARTS = 200;
const MAX_STREAM_TOOLS = 200;
// stream で見た本体の応答の行の控え（streamMessages）の上限
const MAX_STREAM_MESSAGES = 50;
const MAX_SHOWN_TOOLS = 1000;
// ツールの呼び出しごとに動くフックの出来事（hook_name が「出来事:ツールの名前」）
const TOOL_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
// stop_task のあと、タスクが終わった知らせ（task_notification）を待つ上限
const TASK_STOP_WAIT_MS = 10_000;
// 作業中の経過時間を知らせ直す間隔
const PROGRESS_TICK_MS = 1000;
// 書いている途中の文を画面へ送る間隔の下限（書いている途中の行は数文字ごとに届くので、まとめて送る）
const PARTIAL_INTERVAL_MS = 50;

// ターミナルモードで Claude Code の画面を見ていないときの pty サイズ（ターミナルモードで見ているあいだだけ、ペインの大きさに合わせる）
export const DEFAULT_PTY_SIZE = { cols: 120, rows: 40 };

// 送ったが、まだ会話に出ていない発言。at: 送った時刻 / shown: チャットに出す（発言。親セッション・子セッションの知らせや
// 最適化圧縮の文は出さないが、会話に出るまでは作業中に数える）
type Unsent = UnsentPrompt & { at: number; shown: boolean };

type Runtime = {
  process: ClaudeSession | null;
  // これまでに配信したイベントの総数。再起動をまたいで増え続ける
  seq: number;
  // 直近の起動（process-start）以降のイベント
  events: ChatEvent[];
  unread: boolean;
  workflows: WorkflowTracker;
  subagents: SubagentTracker;
  bashTasks: BashTaskTracker;
  // 会話ログの行を、上の 3 つと質問に振り分ける
  tasks: TaskRouter;
  // Claude が読んだ・書いたファイルとコンテキストの使用量
  knowledge: KnowledgeTracker;
  // コンテキストの中身（読んだファイル・大きなツールの結果・発言ごとのやりとりなど）
  context: ContextTracker;
  // モデル・エフォート・コンテキスト・利用枠（stream-json の行と制御の要求の返事から作る。ターミナルモードの間は statusLine から）
  statusLine: StatusLineInfo | null;
  // 今の会話ログの行（uuid を持つもの）と、その行から作ったイベントの events 上の位置。巻き戻しの検出に使う
  chain: ChainEntry[];
  // ユーザーの操作を待っているもの（一覧の印）
  attention: SessionAttention;
  // 実行中のバックグラウンドタスク（サブエージェント・ワークフロー・Bash）の数
  background: number;
  // 書くだけの PermissionRequest のフックが最後にファイルに書いた時刻（フックはチャットでも足される。ファイルの変化は 1 回の
  // 書き込みで何度か知らされるので、同じ書き込みを数え直さないため）
  permissionAt: number | null;
  // 何も出力しなかったフック（hook_response）をチャットに出すための控え（quietHook）。hookStarts: 始まった時刻（hook_id → 時刻）/
  // streamTools: stream で見た、結果がまだ来ていないツールの呼び出し（来た順。sub: サブエージェントの中のもの）/ shownTools: 会話ログからチャットに出した
  // ツールのカード / heldHooks: カードがまだチャットに出ていないツールに付けるフックと、まだ会話に出ていない発言のときのフック・
  // 圧縮の失敗の知らせ（ツールの呼び出しの ID・送った発言の uuid → イベント）
  hookStarts: Map<string, number>;
  streamTools: { id: string; name: string; sub: boolean }[];
  shownTools: Set<string>;
  // stream で見た本体の応答の行の uuid → 応答の ID（message.id。新しい MAX_STREAM_MESSAGES 個まで）。モデルが断って取り消された応答
  // （system/model_refusal_fallback の retracted_message_uuids）を、書いている途中の文から外すのに使う
  streamMessages: Map<string, string>;
  heldHooks: Map<string, ChatEvent[]>;
  // Claude Code が答えを待っている要求（can_use_tool。request_id → 要求。来た順）
  requests: Map<string, CanUseToolRequest>;
  // MCP サーバーから人への質問（elicitation）のうち、Claude Code が答えを待っているもの（request_id → カードの形と要求。来た順）と、
  // URL の形で、人がページを開いて、MCP サーバーの完了の知らせを待っているもの（カードの ID → カードの形と要求。Claude Code にはもう答えた）
  elicitations: Map<string, ElicitationWait>;
  openedUrls: Map<string, ElicitationWait>;
  // 質問（AskUserQuestion）の要求のうち、PendingQuestions で返事を待っているもの（request_id → 待つのをやめる口）
  questionWaits: Map<string, AbortController>;
  // プランの承認（ExitPlanMode）の要求の、プランの本文（request_id → 本文。Claude Code は要求の入力に本文を入れない）
  plans: Map<string, string | null>;
  // 今の会話のプランのファイル（会話ログの plan_mode の添付の planFilePath。プランモードで Claude が書く）
  planFile: string | null;
  // Claude が ExitPlanMode に渡したプランの本文（tool_use の ID → 本文。プランのファイルが読めないときに使う）
  planInputs: Map<string, string>;
  // 設定のプランのフォルダ（get_settings の effective.plansDirectory。プロジェクトのいちばん上からの相対）。プランのファイルを読んでよい場所
  plansDirectory: string | null;
  // 引き継いだときに出し直した要求を受け取っている途中（質問の待ちの登録から届く知らせでも、通知しない）
  quietAttention: boolean;
  // ターミナルモード（今の claude は TUI で、人が画面で操作する。設計書 9 節）。チャットの送信・カード・親の指示は受け付けない
  terminal: boolean;
  // チャットとターミナルモードを切り替えている途中（今の claude を止めて、もう片方で起動し直すまで）
  switching: boolean;
  // 切り替えで、アプリが止めている claude（この claude の終わりは、すぐもう片方で起動するので出さない）
  switchStopping: ClaudeSession | null;
  // 再起動で、アプリが止めている claude と、起動し直し終えた（か、やめた）ことの知らせ。この claude の終わりは出さず、
  // その間は起動中にする（一瞬でも終了と見せると、画面が送信を止める）。その間に送るものは、起動し直した claude に送る
  restarting: { process: ClaudeSession; done: Promise<void> } | null;
  // アーカイブ・一覧からの削除で片付けている途中（worktree も消すときは、止め終わるまで一覧から外さない）。止めたあとに起動し直さない
  closing: boolean;
  // ターミナルモードで、TUI のターンの途中（会話ログの人の発言で始まり、ターンの終わりの行か、書くだけの Stop のフックで終わる）
  tuiTurn: boolean;
  // ターミナルモードで、TUI が出した確認・質問（書くだけの PermissionRequest のフックで分かる。答えたことは会話ログで分かる）
  tuiAsk: { kind: 'permission' | 'question'; menu: Menu } | null;
  // 引き継いだ TUI の、常駐のホストでの pty の ID。最初に画面を出したとき（resize）に、ホストが持つ今の画面を取り直して流す。済んだら null
  redrawFromHost: string | null;
  // initialize の返事が来た（コマンド・モデルの一覧など）。来るまでは起動中
  init: InitializeResponse | null;
  // 入力を受け付けられるようになった（ready を配信した）。worktree の準備が終わるまでは配信しない
  ready: boolean;
  // 分かっている権限モード（起動の引数・アプリでの切り替え・Claude Code が知らせたモード（init・status・発言の行）の、いちばん新しいもの）。
  // 子セッションの権限モードの上限にも使う
  knownMode: PermissionMode | null;
  // knownMode を知った時刻（会話ログの行で知ったときは、その行の時刻）。これより前に書かれた会話ログの行のモードでは戻さない
  modeAt: number;
  size: { cols: number; rows: number };
  // 引き継いだ claude（前のアプリが起動したもの）が起動した時刻。これ以降の会話ログの行は、今も動いている claude が書いた
  aliveSince: number | null;
  // ターンの途中（Claude Code が作業中）。stream-json の行で決める（設計書 7 節）
  turnOpen: boolean;
  // 今のターンの、本体の最後の行（応答か、ツールの結果）の uuid（ターンの終わりを、会話ログがここまで追いついてから出す）。
  // ツールの切れ目でフックが止めたターンでは、最後の行はツールの結果（stream の user の行。uuid は会話ログの行と同じ。実測）
  lastTurnLine: string | null;
  // 今のターンに取り込まれた（command_lifecycle の started）、送った発言の uuid（いちばん新しいもの）と、会話ログに出た送った発言の uuid
  // （新しい 50 個まで）。応答の前に終わったターンの終わりを、その発言が会話ログに出てから出す
  turnPrompt: string | null;
  // 今のターンに取り込まれた（started）送った発言のうち、まだ会話ログに出ていないもの。発言のときのフックを、その発言の行のあとまで
  // 待たせる鍵（出たとき・ターンの終わりに消す）
  promptLine: string | null;
  arrivedPrompts: Set<string>;
  // result が届き、チャットにターンの終わりを出すのを待っているもの。local: モデルを呼ばなかったターン（/clear・/compact など）
  // error: 会話ログに残らない失敗の理由（ターンの終わりの直前に出す）
  turnEnding: { interrupted: boolean; local: boolean; waitFor: string | null; error: ChatEvent | null; timer: NodeJS.Timeout } | null;
  // 待つ時間が切れて、待っていた行より先にチャットへ出したターンの終わり（その行があとで出たら、そのあとにもう一度出す。次のターンが始まったら捨てる）
  lateTurnEnd: { waitFor: string; interrupted: boolean; error: ChatEvent | null } | null;
  // 今の（か、最後に始まった）ターンを始めたもの。ターンが終わったら other に戻す（compact-notice.ts）
  turnStarter: TurnStarter;
  // 今のターンで、始めたもの（turnStarter）を会話ログから決めた
  starterSeen: boolean;
  // 作業中の進み具合（ターンの間だけ）
  progress: Progress | null;
  progressTimer: NodeJS.Timeout | null;
  // 書いている途中の応答の文と思考（チャットの最後に出し、会話ログに出たら外す）と、それを画面へ送るのを待っている時計
  partial: PartialText;
  partialTimer: NodeJS.Timeout | null;
  // 起動の見張り（initialize の返事を待つ間）。after（ミリ秒）を過ぎたら、経過と標準エラーの末尾を進み具合（starting）で知らせる
  startWatch: { since: number; after: number; timer: NodeJS.Timeout; stderr: string } | null;
  // 送ったが、まだ会話に出ていない発言（uuid → 発言）
  unsent: Map<string, Unsent>;
  // 送信の順番（画像を読む間に、あとから送ったものが追い越さないように）
  sendChain: Promise<void>;
  // 引き継いだ claude で、ホストに頼んだ送り直しが済んだ（前のアプリの頃の行を読み終えた）
  caughtUp: boolean;
  // Remote Control が実際につながっているか（system/bridge_state・remote_control の返事・会話ログの bridge-session で分かる）
  remoteConnected: boolean;
  // Remote Control を切り替えている途中（remote_control の返事を待っている）
  remoteSwitching: boolean;
  // チャットとターミナルモードを切り替えて起動した、元の種類。切り替えた先が起動を終える前に終わったら、元の種類で開き直す。
  // 起動を終えたら（チャットは initialize のあと、TUI は statusLine か会話ログの新しい行が届いたら）null
  switchedFrom: LaunchKind | null;
  // ターミナルモードに切り替えたときの、モデルとエフォート（statusLine）。チャットに戻すとき、TUI で変えたものを指定に写すため
  tuiBaseline: { model: string | null; effort: string | null } | null;
  // ターミナルモードの間に、TUI が Remote Control のつながりを会話ログに書いた（/remote-control で変えたかもしれない）
  tuiRemoteSeen: boolean;
  // つないだ Remote Control のセッションの ID（ターミナルモードから戻ったとき、同じセッションに付け直す）
  bridgeSessionId: string | null;
  // 裏のタスクの ID（tool_use の ID → task_started の task_id。stop_task で止めるときに使う）
  taskIds: Map<string, string>;
  // 止める頼みを送ったタスクの ID → 終わった知らせ（task_notification）を待っている受け手
  taskEnds: Map<string, () => void>;
  // /clear のあと、新しい会話の最初の応答がまだ無い。そのあいだコンテキストの量は分からないとして、get_context_usage も聞かない
  // （空の会話の見積もりを返す。それで「量が下がった」とすると、自動の最適化圧縮が、切り替えた直後にまだ超えていても繰り返す）
  freshConversation: boolean;
  // コンテキストの上限（最後に get_context_usage で聞いたもの。量が分からないあいだも、応答の使用量から割合を出すのに使う）
  contextSize: number | null;
  // 会話ログを読み終えた（読み直しの途中の、古いつながりの状態で合わせないため）
  historyLoaded: boolean;
  // 読み直した会話ログの最後の Remote Control の URL（bridge-session 行。切れていれば null、行が無ければ undefined）
  lastBridgeUrl: string | null | undefined;
  // この起動で、会話のタイトルを作らせた（generate_session_title。最初のターンのあとに 1 回だけ）
  titleRequested: boolean;
  // この起動で --settings に渡した、登録した設定ファイルを合わせたファイル（登録した設定ファイルを使っていなければ null）
  settingsPath: string | null;
  // worktree の準備の途中（Claude Code が worktree を作るのを待っている・node_modules の用意）。終わるまで ready を配信しない
  preparing: WorktreePreparing | null;
  // Claude Code が worktree を作り終えたか（新しい worktree で起動したときだけ。作れずに終わったら false）
  worktreeCreated: Promise<boolean> | null;
  // ファイルの変更を見張っているフォルダ（worktree は、Claude Code が作るまで見張れない）
  watched: string | null;
  // 見張っている、ワークスペースに追加したフォルダ
  watchedFolders: string[];
  // 起動を待って送る発言の数（ツールで返す状態で、作業中として扱う）
  pendingSubmits: number;
  // チェックリストの MCP サーバーを足して起動したか（引き継いだ claude は分からないので null）
  checklistMcp: boolean | null;
  // 最後に終わった claude の標準エラーの末尾（worktree を作れなかった理由など）
  stderr: string;
};

// アプリが開くコマンドのターミナル（worktree の npm install・yarn install など）。終了コードを返す。owner: セッションの id
export type RunTask = (owner: string, cwd: string, command: string, name: string) => Promise<number>;

type Listeners = {
  onSessionsChanged: (sessions: SessionSummary[]) => void;
  onChat: (batch: ChatBatch) => void;
  onPtyData: (sessionId: string, data: string) => void;
  onTurnCompleted: (session: SessionSummary, notice: TurnNotice) => void;
  // 作業中の進み具合（作業中でなければ null）
  onProgress: (sessionId: string, activity: Activity | null) => void;
  onWorkflows: (sessionId: string, runs: WorkflowRun[]) => void;
  onSubagents: (sessionId: string, runs: SubagentRun[]) => void;
  onBashTasks: (sessionId: string, tasks: BashTask[]) => void;
  onKnowledge: (sessionId: string, knowledge: SessionKnowledge) => void;
  onStatusLine: (sessionId: string, info: StatusLineInfo) => void;
  // チャットのターンの終わりに get_usage で聞いた、プランの利用枠（モデル別の週の枠を含む）
  onUsage?: (report: UsageReport, at: number) => void;
  // ユーザーの操作待ちになった（質問・許可の確認）
  onAttention: (session: SessionSummary, attention: { kind: 'menu'; menu: Menu }) => void;
  // 答えを待っている AskUserQuestion（いちばん前のもの）が変わった（無くなったら null）
  onQuestion?: (sessionId: string, question: PendingQuestion | null) => void;
  // 答えを待っている、質問でない要求（許可の確認・プランの承認）。いちばん前のもの（無ければ null）
  onPermission?: (sessionId: string, permission: PendingPermission | null) => void;
  // 答えを待っている MCP サーバーの質問（いちばん前のもの。無ければ、完了を待っている URL の形の質問。どちらも無ければ null）
  onElicitation?: (sessionId: string, elicitation: PendingElicitation | null) => void;
  // URL の形の MCP サーバーの質問で、人が「ページを開く」を選んだ。ふだんのブラウザで開く
  onOpenExternal?: (url: string) => void;
};

export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();
  private focusedId: string | null = null;
  private closed = false;
  // 最後に get_usage を聞いた時刻
  private usageAt = 0;

  constructor(
    private readonly host: PtyHostApi,
    private readonly store: SessionStore,
    private readonly watchers: WorkspaceWatchers,
    private readonly statusLines: StatusLineWatcher,
    private readonly listeners: Listeners,
    // Remote Control を使えるか。開発版では使わない（起動するたびにスマホに通知が届くため）
    private readonly remoteControlAvailable = true,
    // 登録した設定ファイルを、起動する Claude Code に重ねる。無ければ設定ファイルは使えない
    private readonly settingsFiles: SettingsFiles | null = null,
    // worktree の npm install などを実行する（アプリはターミナルのタブに出す）。無ければ、画面に出さずに実行する
    private readonly runTask: RunTask = runQuietly,
    // 起動する Claude Code に、アプリ内ブラウザの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly browser: () => BrowserMcpLaunch | null = () => null,
    // 起動する Claude Code に、セッションの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly sessionsMcp: () => McpLaunch | null = () => null,
    // 起動する Claude Code に、チェックリストの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly checklistMcp: () => McpLaunch | null = () => null,
    // 起動する Claude Code に、ウォークスルーの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly walkthroughMcp: () => McpLaunch | null = () => null,
    // プロファイルの Claude Code の設定のフォルダ（CLAUDE_CONFIG_DIR として渡し、会話ログもその中を読む）。null は既定のプロファイル
    private readonly claudeDir: string | null = null,
    // 起動する Claude Code に、人のターミナルの MCP サーバーを足すときの材料（起動のたびに聞く。メニューでオフなら null）
    private readonly terminalMcp: () => McpLaunch | null = () => null,
  ) {}

  // 答えを待っている AskUserQuestion（セッションごと。stream-json の can_use_tool の要求）
  private readonly questions = new PendingQuestions((id) => this.questionsChanged(id));

  // 状態が変わったかもしれないセッション（イベント・操作待ち・バックグラウンドの数・アーカイブ）を知らせる先
  private readonly stateListeners = new Set<(id: string) => void>();
  // 最後に一覧で画面へ渡した、セッションごとの状態
  private readonly shownStates = new Map<string, SessionState | null>();

  watchState(listener: (id: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private changed(id: string): void {
    // 状態が一覧で渡したものから変わったら、一覧を送り直す（画面は、チャットの状態を一覧の state から決める）
    if (this.shownStates.has(id) && this.shownStates.get(id) !== this.stateOf(id)) this.emitSessions();
    for (const listener of this.stateListeners) listener(id);
    this.restartForFoldersIfIdle(id);
  }

  // 外から見た状態が変わった（最適化圧縮の流れが始まった・終わった）ことを、見張っている先に知らせる
  notifyState(id: string): void {
    this.changed(id);
  }

  // 最適化圧縮の流れが、そのセッションに /clear を打って、新しい会話になるのを待っているか（profile.ts がつなぐ）。
  // その /clear で会話が替わったときは、reset に印を付ける（チャットの画面を消さない）
  compactClearing: (id: string) => boolean = () => false;

  // 今 Claude Code の自動の圧縮が始まろうとしたら、アプリの圧縮の前のフックが止めるか（自動の最適化圧縮がオンのセッション。
  // profile.ts が AutoCompact.blocks をつなぐ）。止める圧縮は、作業中の表示で圧縮中にしない
  compactBlocked: (id: string) => boolean = () => false;

  // 残った claude を止める（leftover-claude.ts。テストで差し替える）
  stopLeftover: (claude: ClaudeProcess) => Promise<boolean> = stopLeftoverClaude;

  // ターンの終わり（result）のあと、そのターンの最後の応答が会話ログに出るのを待つ上限（テストで変える）
  turnEndWaitMs = TURN_END_WAIT_MS;
  // initialize の返事が無いまま、起動に時間がかかっていると知らせるまで（テストで変える）
  slowStartMs = SLOW_START_MS;
  // 起動し直すときに止める、各段の待ち時間（end_session → SIGTERM → SIGKILL。テストで縮める。無ければ ClaudeSession の既定）
  stopStepMs: number | undefined = undefined;
  // 再起動の途中に送った発言が、claude が受け付けるようになるのを待つ上限（テストで縮める）
  restartSendWaitMs = RESTART_SEND_WAIT_MS;
  // stop_task のあと、タスクが終わった知らせを待つ上限（テストで縮める）
  taskStopWaitMs = TASK_STOP_WAIT_MS;

  // ターンが終わったときに、人に出す通知の種類（null なら出さない。profile.ts がつなぐ）。最適化圧縮の流れの途中のターンでは出さず、
  // 流れの最後のターンでは「コンテキストの最適化が完了しました」にする（compact-notice.ts）。ターンの終わりごとに、1 回だけ呼ぶ。
  // starter: 終わったターンを始めたもの
  turnNotice: (id: string, starter: TurnStarter) => TurnNotice | null = () => 'work';

  // 終わったターンで、Claude が人への報告（report_result）を預けたか（profile.ts がつなぐ）。報告があれば、バックグラウンドのタスクが
  // 動いていても、ターンの終わりに通知する（報告は、どう終わったかを伝えるもの）
  turnReported: (id: string) => boolean = () => false;

  // チェックリストのファイルを読めず、変更を保存しないセッションか（profile.ts がつなぐ。一覧の印で、チェックリストのパネルが知らせる）
  checklistUnsaved: (id: string) => boolean = () => false;

  // チェックリストを保存しないと分かった（一覧の印を送り直す）
  checklistUnsavedChanged(id: string): void {
    if (this.store.get(id)) this.emitSessions();
  }

  // 最後に終わったターンが、人の中断で終わったか
  lastTurnInterrupted(id: string): boolean {
    const events = this.runtimes.get(id)?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'turn-end') return event.interrupted === true;
    }
    return false;
  }

  // 消した worktree を作り直している途中のセッション（まだ Claude Code を起動していない）
  private readonly restoring = new Set<string>();
  // Claude がアプリ内ブラウザでユーザーに操作を頼んでいるセッション（browser-control が知らせてくる）
  private readonly browserAsks = new Set<string>();

  list(): SessionSummary[] {
    return [...this.store.all()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => {
        const rt = this.runtimes.get(r.id);
        return {
          id: r.id,
          title: r.title,
          cwd: r.cwd,
          archived: r.archived,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          running: !!rt?.process,
          state: this.stateOf(r.id),
          mode: rt?.process ? (rt.knownMode ?? null) : null,
          // 止まっていても、ターミナルモードで起動したセッションはターミナルモードのまま（記録の terminal。チャットには人が戻す）
          terminal: rt?.process ? rt.terminal : !!r.terminal && !r.archived,
          terminalWorking: !!rt?.process && rt.terminal && rt.tuiTurn,
          unread: !!rt?.unread,
          attention: rt?.process ? (rt.attention ?? (this.browserAsks.has(r.id) ? 'browser' : null)) : null,
          backgroundTasks: rt?.process ? rt.background : 0,
          model: r.model ?? null,
          effort: r.effort ?? null,
          settingsFile: r.settingsFile ?? null,
          remoteControl: this.wantsRemote(r),
          autoCompact: r.autoCompact !== false,
          worktree: r.worktree
            ? { ...r.worktree, preparing: this.restoring.has(r.id) ? 'restoring' : rt?.process ? rt.preparing : null }
            : null,
          parentId: r.parentId ?? null,
          addedFolders: r.addedFolders ?? [],
          ...(this.checklistUnsaved(r.id) ? { checklistUnsaved: true } : {}),
        };
      });
  }

  // Claude Code が動いている、アーカイブしていないセッションと、その状態（一覧の文言と同じ）。アプリを終了するときの確認に使う
  liveSessions(): { title: string; state: string }[] {
    return this.store
      .all()
      .filter((r) => !r.archived && this.runtimes.get(r.id)?.process)
      .map((r) => ({ title: r.title ?? t('main.session.untitled'), state: stateLabel(this.runtimes.get(r.id)!, this.browserAsks.has(r.id)) }));
  }

  summary(id: string): SessionSummary | undefined {
    return this.list().find((s) => s.id === id);
  }

  cwdOf(id: string): string {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    return record.cwd;
  }

  // parentId: 親の Claude が start_session で起動する子セッションなら、親セッションの ID
  create(cwd: string, options: NewSessionOptions, parentId: string | null = null): string {
    // 使えない設定ファイルなら、記録を作る前に断る（使えないまま標準の設定で始めてしまわないように）
    this.checkSettingsFile(options.settingsFile);
    const id = this.addRecord(cwd, options, null, parentId);
    this.start(id, options.mode);
    return id;
  }

  // claude --worktree で、新しい worktree に分けて始める。名前はアプリが決め、セッションのフォルダは worktree のフォルダにする。
  // Claude Code が worktree を作るのは待たずに返す（起動してから作るまでに何秒かかかる。そのあいだ、新規セッションの画面を
  // 止めないため。画面はすぐそのセッションに移り、準備の段階を出して待つ）。
  // created: 作り終えたら true。作っている途中に人がアーカイブした・一覧から消したら false（記録はそのまま）。
  // 作れずに Claude Code が終わったら、記録を消して、そのときの標準エラーを添えて失敗する
  async startInWorktree(cwd: string, options: NewSessionOptions, parentId: string | null = null): Promise<{ id: string; created: Promise<boolean> }> {
    this.checkSettingsFile(options.settingsFile);
    const plan = await planWorktree(cwd);
    // 元のフォルダのソース管理に、worktree が未追跡として出ないようにする
    await hideWorktrees(plan.root).catch(() => {});
    const id = this.addRecord(plan.path, options, { name: plan.name, branch: plan.branch, root: plan.root }, parentId);
    this.start(id, options.mode);
    return { id, created: this.untilWorktreeCreated(id) };
  }

  // worktree で始めて、Claude Code が worktree を作るまで待ってから返す（親の Claude が子セッションを始めるとき。
  // 作れなかった理由を、ツールの結果として返せるように）
  async createInWorktree(cwd: string, options: NewSessionOptions, parentId: string | null = null): Promise<string> {
    const { id, created } = await this.startInWorktree(cwd, options, parentId);
    if (!(await created)) throw new Error(t('main.worktree.closedWhileCreating'));
    return id;
  }

  private async untilWorktreeCreated(id: string): Promise<boolean> {
    let waiting = this.runtimes.get(id)?.worktreeCreated ?? null;
    while (waiting) {
      if (await waiting) return true;
      // 作っている途中に起動し直していたら（再起動）、新しい起動のほうを待つ
      const next = this.runtimes.get(id)?.worktreeCreated ?? null;
      if (next === waiting) break;
      waiting = next;
    }
    // 人がアーカイブした・一覧から消したのは、作れなかったのではない
    const record = this.store.get(id);
    if (!record || record.archived) return false;
    // 作れなかった理由は、Claude Code の標準エラー（「Error creating worktree」など）と終了コードで分かる
    const stderr = this.runtimes.get(id)?.stderr.trim() ?? '';
    await this.archive(id).catch(() => null);
    this.store.remove(id);
    this.emitSessions();
    throw new Error(`${t('main.worktree.createFailed')}${stderr ? `\n\n${stderr.split('\n').slice(-8).join('\n')}` : ''}`);
  }

  private addRecord(cwd: string, options: NewSessionOptions, worktree: SessionRecord['worktree'], parentId: string | null): string {
    const now = Date.now();
    const id = randomUUID();
    this.store.add({
      id,
      claudeSessionId: randomUUID(),
      cwd,
      title: null,
      titlePriority: 0,
      archived: false,
      model: options.model,
      effort: options.effort,
      settingsFile: options.settingsFile,
      remoteControl: options.remoteControl,
      worktree,
      ...(parentId ? { parentId } : {}),
      // 子と、Claude が始めた独立したセッションは、起動のモードを、開き直すときの上限として残す
      ...(parentId || options.capMode ? { launchMode: options.mode } : {}),
      ...(options.addedFolders?.length ? { addedFolders: options.addedFolders } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  parentOf(id: string): string | null {
    return this.store.get(id)?.parentId ?? null;
  }

  // 子セッション（アーカイブしたものも）の ID
  childrenOf(id: string): string[] {
    return this.store
      .all()
      .filter((r) => r.parentId === id)
      .map((r) => r.id);
  }

  // 既存の会話（アプリの外で作られたもの）を取り込んで再開する
  importSession(claudeSessionId: string, cwd: string, title: string): string {
    const now = Date.now();
    const id = randomUUID();
    // タイトルは会話ログから読み直すので、仮の優先度（最初の発言相当）にしておく
    this.store.add({ id, claudeSessionId, cwd, title, titlePriority: 1, archived: false, createdAt: now, updatedAt: now });
    this.start(id);
    return id;
  }

  claudeSessionIds(): Set<string> {
    return new Set(this.store.all().map((r) => r.claudeSessionId));
  }

  // ユーザーが付けた名前は会話ログのタイトル（custom-title / ai-title）より優先する
  rename(id: string, title: string): void {
    const trimmed = title.trim();
    this.store.update(id, trimmed ? { title: trimmed, titlePriority: USER_TITLE_PRIORITY } : { title: null, titlePriority: 0 });
    this.emitSessions();
  }

  // 一覧から消す。worktree を消せなかったら、一覧には（アーカイブして）残したまま、理由を添えて失敗する
  // 子セッションは一緒にアーカイブしない（アーカイブした親を消すときに、戻しておいた子を止めないため）
  async remove(id: string, options?: ArchiveOptions): Promise<WorktreeRemoval | null> {
    const removal = await this.archive(id, options, false);
    void rm(this.statusLines.fileFor(id), { force: true });
    void rm(this.statusLines.askFileFor(id), { force: true });
    // stream-json の送受信の控えも消す
    new LineLog(this.streamLogFor(id)).remove();
    this.store.remove(id);
    this.emitSessions();
    return removal;
  }

  // 最近使ったセッションのフォルダ（裏で Claude Code を起動するときに使う。信頼済みなので確認が出ない）
  recentCwd(): string {
    return this.list().find((s) => !s.archived)?.cwd ?? this.list()[0]?.cwd ?? homedir();
  }

  // 今の会話ログのパス
  transcriptOf(id: string): string | null {
    const record = this.store.get(id);
    return record ? transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir) : null;
  }

  history(id: string): Promise<ChatEvent[]> {
    const record = this.store.get(id);
    if (!record) return Promise.resolve([]);
    return readChatLog(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir), record.cwd);
  }

  // 作業の書き出しの材料。動いているセッションも、会話ログを最初から読み直す（画像も画像置き場に入れ直す）
  async exportSource(id: string): Promise<ExportSource> {
    const record = this.store.get(id);
    if (!record) throw new Error(t('main.session.notFound'));
    const live = !!this.runtimes.get(id)?.process;
    const { events, branches } = await readExportLog(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir), record.cwd, live);
    return { events, branches, home: homedir() };
  }

  // 未起動・終了済みなら起動（再開）する。起動中なら何もしない。
  // worktree のセッションで、worktree を消していたら（アーカイブのときに消した）、残したブランチから作り直してから再開する。
  // まだ会話が無ければ、元のフォルダで claude --worktree <名前> を起動し、Claude Code は作り直した worktree をそのまま使う（実測）
  async open(id: string): Promise<void> {
    if (this.runtimes.get(id)?.process || this.restoring.has(id)) return;
    const record = this.store.get(id);
    if (record?.archived) this.store.update(id, { archived: false });
    // 前に起動した claude が残っていれば（ホストが止める間もなく落ちた）、止めてから起動する（同じ会話を 2 つのプロセスが書かないように）
    if (record?.claudeProcess) {
      this.restoring.add(id);
      try {
        if (await this.stopLeftover(record.claudeProcess)) console.warn(`残っていた claude を止めました: ${id} pid=${record.claudeProcess.pid}`);
      } finally {
        this.restoring.delete(id);
      }
      // 待つ間に起動した・アーカイブや一覧からの削除で片付けたなら、起動しない
      if (this.runtimes.get(id)?.process || !this.stillOpen(id)) return;
    }
    if (record?.worktree && !existsSync(record.cwd)) {
      // 作り直してから起動するまで、一覧では「準備中」にする
      this.restoring.add(id);
      this.emitSessions();
      try {
        await restoreWorktree(record.worktree, record.cwd);
      } finally {
        this.restoring.delete(id);
        this.emitSessions();
      }
      if (!this.stillOpen(id)) return;
      this.start(id, record.launchMode ?? null, null, record.terminal ? 'tui' : 'stream');
      void this.prepareWorktree(id, 'restored');
      return;
    }
    // 子セッションは起動のモードで。ほかのセッションは、新しいセッションと同じ決まり（設定の既定か auto。startMode）。
    // ターミナルモードで止まったセッションは、ターミナルモードで起動する（記録の terminal）
    this.start(id, record?.launchMode ?? null, null, record?.terminal ? 'tui' : 'stream');
  }

  // まだ一覧にあり、アーカイブされていないか（open が待つ間に、人が片付けたら起動しない）
  private stillOpen(id: string): boolean {
    const record = this.store.get(id);
    return !!record && !record.archived;
  }

  // アーカイブする。removeWorktree: worktree のセッションなら、Claude Code が終わるのを待ってから worktree も消す。
  // children: 子セッションも一緒にアーカイブする（親だけをアーカイブしない）
  async archive(id: string, options?: ArchiveOptions, children = true): Promise<WorktreeRemoval | null> {
    const rt = this.runtimes.get(id);
    const record = this.store.get(id);
    const removing = !!options?.removeWorktree && !!record?.worktree;
    // 消すときは、消している途中に Claude Code が書き込まないよう、終わるのを待つ。その間に、再起動・切り替えが止めたあとに
    // 起動し直さないよう、片付けの印を付ける（起動し直すと、消した worktree で、誰も持たない claude が動き続ける）
    if (rt) {
      rt.switchedFrom = null;
      rt.closing = true;
    }
    if (removing) await rt?.process?.stop();
    else {
      // 終わりの知らせはあとで届くが、片付けはここでするので、届いても使わない（先にランタイムを外しておく）
      if (rt && this.runtimes.get(id) === rt) this.runtimes.delete(id);
      rt?.process?.kill();
    }
    this.settingsFiles?.release(id);
    this.questions.releaseAll(id);
    if (rt) this.releaseRequests(id, rt);
    rt?.workflows.dispose();
    rt?.subagents.dispose();
    rt?.bashTasks.dispose();
    if (rt) this.stopProgress(id, rt);
    if (rt) this.stopStartWatch(id, rt);
    if (rt?.turnEnding) clearTimeout(rt.turnEnding.timer);
    if (rt?.watched) this.watchers.release(rt.watched);
    if (rt) this.watchFolders(rt, []);
    if (this.runtimes.get(id) === rt) this.runtimes.delete(id);
    this.store.update(id, { archived: true });
    this.emitSessions();
    this.changed(id);
    // 親だけをアーカイブしない。子も一緒にアーカイブする（子の worktree は消さない）
    for (const child of children ? this.childrenOf(id) : []) {
      if (!this.store.get(child)?.archived) await this.archive(child);
    }
    if (!removing || !record?.worktree) return null;
    return removeWorktree(record.worktree, record.cwd);
  }

  // worktree を消す前に、残っているもの（worktree のセッションでなければ null）
  async worktreeLeftovers(id: string): Promise<WorktreeLeftovers | null> {
    const record = this.store.get(id);
    return record?.worktree ? worktreeLeftovers(record.worktree, record.cwd) : null;
  }

  unarchive(id: string): void {
    this.store.update(id, { archived: false, updatedAt: Date.now() });
    this.emitSessions();
  }

  focus(id: string | null): void {
    this.focusedId = id;
    const rt = id ? this.runtimes.get(id) : undefined;
    if (rt?.unread) {
      rt.unread = false;
      this.emitSessions();
    }
  }

  // ツールで返す、今の状態（知らないセッションは null）。main が 1 つだけ持ち、画面にも一覧で渡す（設計書 7 節）
  stateOf(id: string): SessionState | null {
    const record = this.store.get(id);
    if (!record) return null;
    if (record.archived) return 'archived';
    if (this.restoring.has(id)) return 'starting';
    const rt = this.runtimes.get(id);
    // チャットとターミナルモードの切り替え・再起動で、アプリが止めて起動し直している途中は起動中
    // （止めた claude が終わってから、次を起動するまでの間も。一瞬でも終了と見せると、画面が送信を止める）
    if (rt?.switching || rt?.restarting) return 'starting';
    if (!rt?.process) return 'exited';
    // ターミナルモードの間は、人が TUI で操作している
    if (rt.terminal) return 'terminal';
    // Claude Code が答えを待っている要求（AskUserQuestion は質問、ほかは許可の確認）
    const request = firstRequest(rt);
    if (request) return request.tool_name === 'AskUserQuestion' ? 'question' : 'permission';
    // 答えを待っている質問（AskUserQuestion の要求を、PendingQuestions で預かっているもの）と、MCP サーバーの質問
    if (this.questions.first(id) || rt.elicitations.size > 0) return 'question';
    if (!rt.ready || rt.preparing) return 'starting';
    // result のあと、そのターンの最後の応答が会話ログに出るまで（turnEnding）も作業中。チャットのターンの終わりと揃える。
    // 送信中・順番待ちの発言が残っていれば、ターンとターンの間も作業中（作業中の始まりは、送った発言の queued・started。設計書 7 節）
    if (rt.pendingSubmits > 0 || rt.turnOpen || rt.turnEnding || rt.unsent.size > 0) return 'working';
    if (rt.background > 0) return 'background';
    return 'idle';
  }

  // 子セッションの権限モードの上限にする、今の権限モード（分かっていなければ manual）
  modeOf(id: string): PermissionMode | null {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    return rt.knownMode ?? 'manual';
  }

  // 今のモデル（--model に渡せる ID）とエフォート。start_session で省いたときに、呼んだセッションに合わせるために使う。
  // Claude Code が知らせた今の値があればそれ、無ければ起動の指定（アプリで選んだもの）。どちらも無ければ null（Claude Code の既定のまま）
  currentModel(id: string): string | null {
    return this.runtimes.get(id)?.statusLine?.model?.id ?? this.store.get(id)?.model ?? null;
  }

  currentEffort(id: string): string | null {
    return this.runtimes.get(id)?.statusLine?.effort ?? this.store.get(id)?.effort ?? null;
  }

  // 会話（動かしたことがあれば直近の起動からのイベント、なければ会話ログから作ったもの）
  async conversation(id: string): Promise<ChatEvent[]> {
    const rt = this.runtimes.get(id);
    return rt ? [...rt.events] : this.history(id);
  }

  snapshot(id: string): SessionSnapshot {
    const rt = this.runtimes.get(id);
    if (!rt) return { sessionId: id, fromSeq: 0, events: [] };
    return { sessionId: id, fromSeq: rt.seq - rt.events.length, events: rt.events, partial: rt.partial.view() };
  }

  subagents(id: string): SubagentRun[] {
    return this.runtimes.get(id)?.subagents.all() ?? [];
  }

  statusLine(id: string): StatusLineInfo | null {
    return this.runtimes.get(id)?.statusLine ?? null;
  }

  // Claude がアプリ内ブラウザでユーザーに操作を頼んだ・頼み終わった（一覧は「ブラウザでの操作待ち」）。
  // 状態の見張りにも知らせる（親の Claude には、子の状態 browser として見せて知らせる。sessions-control.ts）
  browserAskChanged(id: string, asking: boolean): void {
    if (asking === this.browserAsks.has(id)) return;
    if (asking) this.browserAsks.add(id);
    else this.browserAsks.delete(id);
    this.emitSessions();
    this.changed(id);
  }

  // Claude がアプリ内ブラウザでユーザーに操作を頼んでいるか
  browserAsking(id: string): boolean {
    return this.browserAsks.has(id);
  }

  // 許可の確認を出す直前に、フックがそのツールの名前と入力をファイルに書いた
  permissionRequested(id: string, raw: unknown, at: number): void {
    const rt = this.runtimes.get(id);
    const request = raw as { tool_name?: unknown; tool_input?: unknown } | null;
    if (!rt || !request || typeof request.tool_name !== 'string' || !request.tool_input || typeof request.tool_input !== 'object') return;
    // ファイルの変化は、1 回の書き込みで何度か知らされることがある。同じ書き込み（同じ時刻）は数え直さない
    if (rt.permissionAt === at) return;
    rt.permissionAt = at;
    // ターミナルモードの間は、TUI が出した確認・質問を、通知と一覧の印にする（答えたことは、会話ログの行で分かる）
    if (rt.terminal && rt.process) {
      this.noteHookMode(id, rt, raw);
      const input = request.tool_input as Record<string, unknown>;
      const ask = { tool_name: request.tool_name, input } as CanUseToolRequest;
      rt.tuiAsk = { kind: request.tool_name === 'AskUserQuestion' ? 'question' : 'permission', menu: requestMenu(ask) };
      this.updateAttention(id, rt);
    }
    this.changed(id);
  }

  // チャットとターミナルモードを切り替えている途中か
  switchingTerminal(id: string): boolean {
    return !!this.runtimes.get(id)?.switching;
  }

  // TUI の権限モードを、書くだけのフックの入力（permission_mode）からも知る（会話ログの permission-mode の行は、発言のときにしか
  // 書かれないことがあるため。チャットに戻すとき、TUI で変えたモードを渡す）
  private noteHookMode(id: string, rt: Runtime, input: unknown): void {
    const mode = input && typeof input === 'object' ? (input as { permission_mode?: unknown }).permission_mode : undefined;
    const known = typeof mode === 'string' ? appMode(mode) : null;
    if (known) this.noteMode(id, rt, known);
  }

  // ターミナルモードの TUI の入力欄に貼る（ブラケットペースト。Enter は送らない。人が押す）。ターミナルモードでなければ false
  // TUI が確認・質問のメニューを出している間も false（貼った文字がメニューの選択になるため。閉じたら changed で知らせる）
  pasteIntoTerminal(id: string, text: string): boolean {
    const rt = this.runtimes.get(id);
    if (!rt?.terminal || rt.switching || !rt.process || rt.tuiAsk) return false;
    rt.process.write(bracketedPaste(stripControlChars(text)));
    return true;
  }

  // 書くだけの Stop のフックが、TUI のターンの終わりを知らせた（ターミナルモード）。input: フックの入力（permission_mode）
  tuiIdle(id: string, input: unknown = null): void {
    const rt = this.runtimes.get(id);
    if (rt?.terminal) this.noteHookMode(id, rt, input);
    if (!rt?.terminal || (!rt.tuiTurn && !rt.tuiAsk)) return;
    rt.tuiTurn = false;
    rt.tuiAsk = null;
    this.updateAttention(id, rt);
    this.emitSessions();
    this.changed(id);
  }

  // チャットとターミナルモードを切り替える（設計書 9 節）。今の claude を止めて終わりを確かめ、もう片方で --resume する
  // （同じ会話を 2 つのプロセスで同時に開かない）。手が空いているときだけ（チャットはターン・答え待ちの要求・送る予定の発言が無い、
  // TUI はターンの外）。裏のタスクが動いていれば、止まることを人が確かめた（stopTasks）ときだけ。切り替えられなければ理由を投げる。
  // 権限モードは今のもの（TUI で変えたものは会話ログから分かる）を渡す。bypassPermissions は、起動し直しと同じく引き継がない。
  // TUI で変えたモデル・エフォート・Remote Control は、チャットに戻すときに指定へ写す。
  // もう片方を起動できなかった・起動を終える前に終わったら、元の種類で開き直す（起動できなかったわけは投げる・チャットに出す）
  async setTerminalMode(id: string, on: boolean, { stopTasks = false }: { stopTasks?: boolean } = {}): Promise<void> {
    const rt = this.runtimes.get(id);
    const process = rt?.process;
    const record = this.store.get(id);
    // 止まっている（ターミナルモードで終わったなど）なら、種類を変えて「再開」と同じく起動する（止めるものが無いので、確かめは要らない）
    if (record && !record.archived && !process && !rt?.switching) {
      this.store.update(id, { terminal: on });
      this.emitSessions();
      await this.open(id);
      return;
    }
    if (!rt || !process || !record) throw new Error(t('main.terminal.notRunning'));
    if (rt.terminal === on) return;
    if (rt.switching) throw new Error(t('main.terminal.switching'));
    if (on ? !this.chatIdle(id, rt) : rt.tuiTurn) throw new Error(t(on ? 'main.terminal.busy' : 'main.terminal.tuiBusy'));
    if (rt.background > 0 && !stopTasks) throw new Error(t('main.terminal.tasksRunning'));
    // 起動し直せないと分かっているのに、動いている claude を止めないよう、先に設定ファイルを確かめる（restart と同じ）
    this.checkSettingsFile(record.settingsFile);
    rt.switching = true;
    this.emitSessions();
    this.changed(id);
    try {
      // Remote Control を使わないセッションは、つながっていなくても切ってから止める（TUI の --resume は、会話ログに残った前のつながりに
      // つなぎ直し、キーを送らない TUI では切れないため）。切れなければ、切り替えない。使えない環境（API キーなど）では送らない
      if (on && !this.wantsRemote(record) && process.client && rt.init?.remote_control_available !== false) {
        const refused = await disableRemoteControl(process.client).then(
          () => null,
          (error: unknown) => (error instanceof ControlError ? error.reason : String(error)),
        );
        // 待っている間に claude が自分で終わった（終了は onExit が出した）。切り替えずに、止まったままにする
        if (rt.process !== process) throw new Error(t('main.terminal.exitedWhileSwitching'));
        if (refused !== null) throw new Error(t('main.terminal.remoteOffFailed', { reason: refused }));
      }
      if (!on) this.adoptTuiChanges(id, rt);
      const mode = this.relaunchMode(id, rt);
      rt.switchStopping = process;
      const stopped = await process.stop(this.stopStepMs).finally(() => {
        rt.switchStopping = null;
      });
      // 止めている間に、ほかで起動し直した・アーカイブした
      if (this.gone(id, rt)) return;
      if (rt.process === process && !stopped) throw new Error(t('main.session.notStopped'));
      if (rt.process) return;
      const from: LaunchKind = on ? 'stream' : 'tui';
      try {
        this.start(id, mode, null, on ? 'tui' : 'stream');
      } catch (error) {
        // もう片方を起動できなければ、元の種類で開き直して、わけを返す
        const reason = error instanceof Error ? error.message : String(error);
        try {
          this.start(id, mode, null, from);
        } catch {
          // 元の種類でも起動できない。止まったまま（チャットの「再開」で開き直せる）
          this.pushEvents(id, [{ type: 'process-exit', exitCode: 0 }]);
          throw new Error(t('main.terminal.startFailedStopped', { reason }));
        }
        throw new Error(t('main.terminal.startFailed', { reason }));
      }
      // 起動を終える前に終わったら（TUI のフォルダの信頼の確認で「No, exit」を選んだなど）、onExit で元の種類に戻す
      rt.switchedFrom = from;
    } finally {
      rt.switching = false;
      this.emitSessions();
      this.changed(id);
    }
  }

  // ターミナルモードで、会話ログに行が増えた。人の発言でターンが始まり、ターンの終わりの行で終わる（終わりは完了の知らせを出す）。
  // TUI が出した確認・質問は、答え（ツールの結果などの user の行）が書かれたら済んだことにする
  // isHistory: 起動したときに読み直した行（アプリを起動し直して TUI を引き継いだときは、済んだターンの行も読み直す）。
  // 読み直した行では、今がターンの途中かを組み立てるだけにして、完了は知らせない（流し直した行は通知しない。設計書 5 節）
  private tuiEntry(id: string, rt: Runtime, entry: TranscriptEntry, events: ChatEvent[], isHistory: boolean): void {
    let changed = false;
    // TUI が新しい行を書いた＝起動を終えた（切り替えた先として、元の種類に戻すことはもう無い）
    if (!isHistory) rt.switchedFrom = null;
    if (entry.type === 'user' && rt.tuiAsk) {
      rt.tuiAsk = null;
      changed = true;
    }
    // ターンの始まり: 人の発言か、モデルの応答（スキル・カスタムコマンド・裏のタスクの完了の知らせで始まるターンは、発言の行が
    // コマンドや知らせになるので、応答で分かる）。モデルを呼ばないコマンド（/model など）は応答もターンの終わりの行も無いので数えない
    if (events.some((e) => (e.type === 'user' && !e.command) || e.type === 'assistant-text' || e.type === 'thinking' || e.type === 'tool-use')) {
      rt.tuiTurn = true;
      changed = true;
    }
    if (events.some((e) => e.type === 'turn-end')) {
      rt.tuiTurn = false;
      changed = true;
      if (!isHistory) this.turnCompleted(id, rt);
    }
    if (!changed) return;
    this.updateAttention(id, rt);
    // 一覧の「ターミナルモード・作業中」を出し直し、待っている知らせ（TUI に貼るもの）に、メニューが閉じた・手が空いたことを知らせる
    this.emitSessions();
    this.changed(id);
  }

  // 起動し直すときの権限モード。今のモードを渡すが、子は起動したときのモードより強くしない。bypassPermissions は引き継がない
  private relaunchMode(id: string, rt: Runtime): PermissionMode | null {
    let mode = rt.knownMode;
    const launchMode = this.store.get(id)?.launchMode;
    if (launchMode && mode && !modeWithin(mode, launchMode)) mode = launchMode;
    return mode && mode !== 'bypassPermissions' ? mode : null;
  }

  // ターミナルモードからチャットに戻す前に、TUI で変えたもの（/model・/effort・/remote-control）を、次に起動するときの指定に写す
  // （チャットは指定で起動するので、写さないと黙って元に戻る）。モデル・エフォートは statusLine、Remote Control は会話ログで分かる
  private adoptTuiChanges(id: string, rt: Runtime): void {
    const record = this.store.get(id);
    if (!record) return;
    const now = rt.statusLine;
    const base = rt.tuiBaseline;
    const patch: Partial<SessionRecord> = {};
    if (now && base && now.model && now.model.id !== base.model) patch.model = now.model.id;
    if (now && base && now.effort !== base.effort) patch.effort = now.effort;
    if (rt.tuiRemoteSeen && this.remoteControlAvailable && rt.remoteConnected !== (record.remoteControl !== false)) patch.remoteControl = rt.remoteConnected;
    if (Object.keys(patch).length > 0) this.store.update(id, patch);
  }

  // チャットの手が空いている（ターン・答え待ちの要求・送る予定の発言が無い）
  private chatIdle(id: string, rt: Runtime): boolean {
    return rt.ready && !rt.preparing && !rt.turnOpen && !rt.turnEnding && rt.requests.size === 0 && rt.elicitations.size === 0 && rt.unsent.size === 0 && rt.pendingSubmits === 0 && !this.questions.first(id);
  }

  // 答えを待っている、質問でない要求（許可の確認・プランの承認）のうち、いちばん前のもの。無ければ null。
  // プランの本文を読めていなければ、読み直す（引き継いだときは、会話ログを読む前に要求が出る）。読めなければ空
  pendingPermission(id: string): PendingPermission | null {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    for (const [requestId, request] of rt.requests) {
      if (request.tool_name === 'AskUserQuestion') continue;
      const plan = request.tool_name === PLAN_TOOL ? (rt.plans.get(requestId) ?? this.planOf(id, rt, request) ?? '') : null;
      return permissionOf(requestId, request, plan);
    }
    return null;
  }

  // 許可の確認に答える（カード・親の answer_permission）。その要求をもう待っていなければ false
  replyPermission(id: string, requestId: string, reply: PermissionReply): boolean {
    const rt = this.runtimes.get(id);
    const request = rt?.requests.get(requestId);
    if (!rt || !request || request.tool_name === 'AskUserQuestion') return false;
    if (!rt.process?.client?.respond(requestId, permissionResult(request, reply))) return false;
    this.requestRemoved(id, rt, requestId);
    return true;
  }

  // フックが答えを待っている質問（いちばん前のもの）。無ければ null
  pendingQuestion(id: string): PendingQuestion | null {
    return this.questions.first(id);
  }

  // 待っている質問に返事をする（質問のカード）。その質問をもう待っていなければ false
  replyQuestion(id: string, questionId: string, reply: QuestionReply): boolean {
    return this.questions.reply(id, questionId, reply);
  }

  // 待っている質問のうち 1 問に答える（親の answer_question）。全部そろったら返事にする（sent）。もう待っていなければ null
  answerPendingQuestion(id: string, questionId: string, question: string, answer: string): 'sent' | 'waiting' | null {
    return this.questions.answerOne(id, questionId, question, answer);
  }

  // 答えを待っている MCP サーバーの質問（いちばん前のもの）。無ければ、ページを開いて完了を待っている URL の形の質問。どちらも無ければ null
  pendingElicitation(id: string): PendingElicitation | null {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    return (rt.elicitations.values().next().value ?? rt.openedUrls.values().next().value)?.pending ?? null;
  }

  // MCP サーバーの質問に答える（カード）。その質問をもう待っていなければ false。形に合わない答え（フォームの中身が項目に合わない・
  // 開けないページを開く・出せない項目のあるフォームを送る）も送らずに false
  replyElicitation(id: string, elicitationId: string, reply: ElicitationReply): boolean {
    const rt = this.runtimes.get(id);
    if (!rt) return false;
    const opened = rt.openedUrls.get(elicitationId);
    if (opened) {
      // 完了待ちのカード: もう一度開く・閉じる（Claude Code には、開いたときにもう答えた）
      if (reply.kind === 'reopen' && opened.pending.url) this.listeners.onOpenExternal?.(opened.pending.url);
      else if (reply.kind === 'dismiss') rt.openedUrls.delete(elicitationId);
      else return false;
      this.updateAttention(id, rt);
      return true;
    }
    const waiting = rt.elicitations.get(elicitationId);
    if (!waiting) return false;
    const { pending, request } = waiting;
    if (reply.kind === 'accept' && (pending.mode !== 'form' || pending.unsupported.length > 0 || !checkedContent(pending.fields, reply.content))) return false;
    if (reply.kind === 'open' && (pending.mode !== 'url' || !pending.openable)) return false;
    const result = elicitationResult(reply);
    if (!result || !rt.process?.client?.respondElicitation(elicitationId, result)) return false;
    rt.elicitations.delete(elicitationId);
    if (reply.kind === 'open' && pending.url) {
      this.listeners.onOpenExternal?.(pending.url);
      // 完了の知らせと結べる（elicitation_id がある）ときだけ、完了を待つカードにする
      if (request.elicitation_id) {
        const key = `opened:${elicitationId}`;
        rt.openedUrls.set(key, { pending: { ...pending, id: key, opened: true }, request });
      }
    }
    this.updateAttention(id, rt);
    return true;
  }

  // statusLine のファイルが書き換わった（ターミナルモードの TUI の間だけ動く。stream-json では、行から作る）
  statusLineChanged(id: string, info: StatusLineInfo): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.statusLine = info;
    // TUI が statusLine を出した＝起動を終えた（フォルダの信頼の確認の間は出ない）
    if (rt.terminal) rt.switchedFrom = null;
    this.listeners.onStatusLine(id, info);
    // /clear で新しい会話になると、statusLine の会話ログのパスが変わる
    if (info.transcriptPath) rt.process?.followTranscript(info.transcriptPath);
  }

  // このセッションの Remote Control を切り替える。動いていれば、制御の要求 remote_control でその場でつなぐ・切る。
  // 止まっている・起動の途中なら、指定だけ変える（起動が終わったら合わせる。reconcileRemote）。切り替えられなかったら指定を戻して、理由を返す
  async setRemoteControl(id: string, on: boolean): Promise<string | null> {
    if (!this.remoteControlAvailable) return t('main.remote.unavailable');
    const record = this.store.get(id);
    if (!record) return t('main.session.notFound');
    this.store.update(id, { remoteControl: on });
    this.emitSessions();
    const rt = this.runtimes.get(id);
    if (!rt?.process?.client || !rt.ready || rt.remoteConnected === on) return null;
    if (rt.remoteSwitching) {
      this.store.update(id, { remoteControl: !on });
      this.emitSessions();
      return t('main.remote.switching');
    }
    const reason = await this.switchRemote(id, rt, record.cwd, on);
    if (reason === null) return null;
    this.store.update(id, { remoteControl: !on });
    this.emitSessions();
    return reason;
  }

  // 指定と、実際につながっているかがずれていたら合わせる（起動が終わったとき）。失敗は知らせない（一覧の印で分かる）
  private reconcileRemote(id: string, rt: Runtime): void {
    const record = this.store.get(id);
    if (!record || !rt.process?.client || !rt.ready || rt.remoteSwitching) return;
    const want = this.wantsRemote(record);
    if (want === rt.remoteConnected) return;
    // Remote Control を使えない環境（API キー・Bedrock など。initialize の remote_control_available）では、つなぎに行かない
    if (want && rt.init?.remote_control_available === false) return;
    void this.switchRemote(id, rt, record.cwd, want);
  }

  // Remote Control をつなぐ・切る。できたら null、できなければ理由
  private async switchRemote(id: string, rt: Runtime, cwd: string, on: boolean): Promise<string | null> {
    const process = rt.process;
    const client = process?.client;
    if (!client) return t('main.send.notRunning');
    rt.remoteSwitching = true;
    try {
      if (on) {
        const session = await enableRemoteControl(client, remoteName(cwd), rt.bridgeSessionId);
        if (rt.process !== process) return null;
        this.noteBridgeSession(id, rt, session.bridgeSessionId);
        rt.remoteConnected = true;
        if (session.sessionUrl) this.pushEvents(id, [{ type: 'remote-control', url: session.sessionUrl }]);
      } else {
        await disableRemoteControl(client);
        if (rt.process !== process) return null;
        rt.remoteConnected = false;
        this.pushEvents(id, [{ type: 'remote-control', url: null }]);
      }
      this.emitSessions();
      return null;
    } catch (error) {
      return t('main.remote.failed', { reason: error instanceof ControlError ? error.reason : String(error) });
    } finally {
      rt.remoteSwitching = false;
    }
  }

  // つないだ Remote Control のセッションの ID を覚える（開き直したときに付け直すため、記録にも残す）
  private noteBridgeSession(id: string, rt: Runtime, bridgeSessionId: string | null | undefined): void {
    if (!bridgeSessionId || bridgeSessionId === rt.bridgeSessionId) return;
    rt.bridgeSessionId = bridgeSessionId;
    this.store.update(id, { bridgeSessionId });
  }

  // このセッションで、最適化圧縮を自動で始めるか（チャットのヘッダーの「自動」のトグル）
  setAutoCompact(id: string, on: boolean): void {
    if (!this.store.get(id)) return;
    this.store.update(id, { autoCompact: on });
    this.emitSessions();
    this.changed(id);
  }

  remoteAvailable(): boolean {
    return this.remoteControlAvailable;
  }

  // Remote Control が今つながっているか。null: つなぐ・切るのを待っている（remote_control の返事を待っている）。
  // Claude Code が動いていなければ false
  remoteConnectedOf(id: string): boolean | null {
    const rt = this.runtimes.get(id);
    if (!rt?.process) return false;
    return rt.remoteSwitching ? null : rt.remoteConnected;
  }

  // このセッションで Remote Control を使うか（開発版では使わない）
  private wantsRemote(record: SessionRecord): boolean {
    return this.remoteControlAvailable && record.remoteControl !== false;
  }

  knowledge(id: string): SessionKnowledge {
    return this.runtimes.get(id)?.knowledge.current() ?? { files: {}, contextTokens: null };
  }

  // コンテキストの中身（見ているときだけ取りに来る。使用量が変わったら取り直す）。
  // 起動していないセッション（アーカイブ済みなど）は、会話ログから読む
  async context(id: string): Promise<SessionContext> {
    const rt = this.runtimes.get(id);
    if (rt) return rt.context.current();
    const record = this.store.get(id);
    return record ? readContext(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir), record.cwd) : { items: [] };
  }

  // 今の Claude Code の会話の ID（/clear で新しい会話になると変わる）。知らないセッションは null
  claudeSessionOf(id: string): string | null {
    return this.store.get(id)?.claudeSessionId ?? null;
  }

  // このセッションの Claude Code に、チェックリストの MCP サーバーを足して起動したか。動いていない・引き継いだもの（分からない）は null
  hasChecklistMcp(id: string): boolean | null {
    const rt = this.runtimes.get(id);
    return rt?.process ? rt.checklistMcp : null;
  }

  // 裏で動いているもの（最適化圧縮の再開の文で、新しい会話に伝える）
  runningTasks(id: string): CarriedTask[] {
    const rt = this.runtimes.get(id);
    if (!rt) return [];
    return [
      ...rt.bashTasks.all().filter((task) => task.state === 'running').map((task) => ({ kind: 'bash' as const, label: task.description ? `${task.command} (${task.description})` : task.command })),
      ...rt.subagents.all().filter((r) => r.background && r.state === 'running').map((r) => ({ kind: 'agent' as const, label: r.description ?? r.agentId ?? '' })),
      ...rt.workflows.all().filter((r) => r.status === 'running').map((r) => ({ kind: 'workflow' as const, label: r.name })),
    ];
  }

  // 入力欄の / の候補。動いている Claude Code の initialize の commands。起動の前（返事が来るまで）・止まっているときは null
  // （呼び出し側が、フォルダと会話ログから集める）
  commandsOf(id: string): SlashCommand[] | null {
    const rt = this.runtimes.get(id);
    return rt?.process && rt.init ? commandsFromInitialize(rt.init.commands) : null;
  }

  // モデルの選択肢のうち、動いている Claude Code がその場で切り替えられるもの（initialize の models）。起動の前・止まっているときは null
  // （画面は、モデルの一覧の控えだけで選ばせる）
  modelsOf(id: string): SessionModel[] | null {
    const rt = this.runtimes.get(id);
    if (!rt?.process || !rt.init || rt.terminal) return null;
    return rt.init.models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel ?? null, name: m.displayName, efforts: effortsOf(m) }));
  }

  bashTasks(id: string): BashTask[] {
    return this.runtimes.get(id)?.bashTasks.all() ?? [];
  }

  // 動いているバックグラウンドのもの（サブエージェント・ワークフロー・Bash）を止める（stop_task）。止められなかったら理由を返す。
  // stop_task は知らない ID にも success を返すので（実測）、Claude Code がそのタスクの終わり（task_notification）を知らせるまで待って確かめる
  async stopTask(id: string, ref: TaskRef): Promise<string | null> {
    const rt = this.runtimes.get(id);
    const client = rt?.process?.client;
    // ターミナルモードの TUI には要求を送れない（人が画面の /tasks で止める）
    if (rt?.process && rt.terminal) return t('main.task.terminalMode');
    if (!rt || !client) return t('main.task.notRunning');
    if (!taskRunning(rt, ref)) return t('main.task.nothingToStop');
    const taskId = rt.taskIds.get(ref.toolUseId) ?? (ref.kind === 'bash' ? (rt.bashTasks.all().find((task) => task.toolUseId === ref.toolUseId)?.taskId ?? null) : null);
    if (!taskId) return t('main.task.notFound');
    let ended = () => {};
    const end = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.taskStopWaitMs);
      ended = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    rt.taskEnds.set(taskId, ended);
    try {
      await client.request('stop_task', { task_id: taskId });
      return (await end) ? null : t('main.task.notStopped');
    } catch (error) {
      return t('main.task.failed', { reason: error instanceof ControlError ? error.reason : String(error) });
    } finally {
      if (rt.taskEnds.get(taskId) === ended) rt.taskEnds.delete(taskId);
    }
  }

  // サブエージェント・ワークフローのエージェントの会話
  agentLog(id: string, ref: AgentLogRef): Promise<ChatEvent[]> {
    const rt = this.runtimes.get(id);
    const record = this.store.get(id);
    if (!rt || !record) return Promise.resolve([]);
    const file =
      ref.kind === 'subagent'
        ? rt.subagents.logFile(ref.toolUseId, join(this.sessionDir(id), 'subagents'))
        : rt.workflows.agentLogFile(ref.toolUseId, ref.agentId);
    return file ? readAgentLog(file, record.cwd) : Promise.resolve([]);
  }

  workflows(id: string): WorkflowRun[] {
    return this.runtimes.get(id)?.workflows.all() ?? [];
  }

  // 作業中の進み具合（作業中でなければ null）
  progress(id: string): Activity | null {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    return rt.progress?.current(Date.now()) ?? slowStartActivity(rt, Date.now());
  }

  // 権限モードを切り替える（画面のモード欄・親の configure_session。set_permission_mode。作業中でも変えられる）。子セッションは、
  // 起動し直しても切り替えたモードで起動するよう、起動のモード（launchMode）も変える。Claude Code が動いていない子は、次に起動するときの
  // モードだけを変える。bypassPermissions は、起動したときに許したときだけ通る（実測）
  async setMode(id: string, mode: PermissionMode): Promise<boolean> {
    const rt = this.runtimes.get(id);
    // 起動のモードを上限にしているセッション（子と、Claude が始めた独立したセッション）
    const record = this.store.get(id);
    const child = !!record?.parentId || record?.launchMode !== undefined;
    if (!rt?.process) {
      if (child) this.store.update(id, { launchMode: mode });
      return child;
    }
    const process = rt.process;
    const client = process.client;
    if (!client || !rt.ready) return false;
    const response = await client.request<{ mode?: unknown }>('set_permission_mode', { mode: streamMode(mode) }).catch(() => null);
    if (!response || rt.process !== process) return false;
    // 返事の mode が、実際に切り替わったモード（実測。無ければ頼んだモード）
    const applied = (typeof response.mode === 'string' ? appMode(response.mode) : null) ?? mode;
    this.noteMode(id, rt, applied);
    if (child) this.store.update(id, { launchMode: applied });
    return applied === mode;
  }

  // messageId の発言の前まで巻き戻す前に、コードを戻すと変わるファイルを調べる（rewind_files の dry_run）。
  // 動いていない・その発言が今の会話に無ければ null
  async rewindPreview(id: string, messageId: string): Promise<RewindPreview | null> {
    const rt = this.runtimes.get(id);
    const client = rt?.process?.client;
    if (!rt || !client || !rt.ready || !rt.chain.some((c) => c.uuid === messageId)) return null;
    const result = await client.request<RewindFilesResult>('rewind_files', { user_message_id: messageId, dry_run: true }).catch(
      (error: unknown): RewindFilesResult => ({ canRewind: false, error: error instanceof ControlError ? error.reason : String(error) }),
    );
    return result.canRewind
      ? { files: result.filesChanged ?? [], insertions: result.insertions ?? 0, deletions: result.deletions ?? 0, codeError: null }
      : { files: null, insertions: 0, deletions: 0, codeError: result.error ?? null };
  }

  // messageId の発言の前まで巻き戻す。code: ファイルを、その発言を送った時点に戻す（rewind_files）/ conversation: 会話をその発言の前に戻す
  // （rewind_conversation。会話ログは消されず、次の発言から枝分かれする）。会話を戻したら、チャットの表示もその発言の前の時点にする。
  // 「ここから要約」は作らない（決めたこと）
  async rewind(id: string, messageId: string, choice: RewindChoice): Promise<RewindOutcome> {
    const rt = this.runtimes.get(id);
    const process = rt?.process;
    const client = process?.client;
    const failed = (error: string | null, codeRewound = false): RewindOutcome => ({ ok: false, prefillText: null, error: error ?? t('chat.pane.rewindNotFound'), codeRewound });
    if (!rt || !client || !rt.ready) return failed(t('main.send.notRunning'));
    // 会話を戻せない（作業中・答え待ち・送る予定の発言がある）と分かっていれば、コードも戻さずに断る（Claude Code も turn_running・
    // commands_queued で断る）。コードを先に戻すのは、会話を戻したあとでは、その発言のファイルの控えを探せるか確かめていないため
    if (choice.conversation && !this.chatIdle(id, rt)) return failed(rewindReasonText('turn_running', null));
    if (choice.code) {
      const result = await client.request<RewindFilesResult>('rewind_files', { user_message_id: messageId }).catch(
        (error: unknown): RewindFilesResult => ({ canRewind: false, error: error instanceof ControlError ? error.reason : String(error) }),
      );
      if (!result.canRewind) return failed(result.error ?? null);
    }
    if (!choice.conversation) return { ok: true, prefillText: null, error: null };
    // アプリが読んだ会話ログの、いちばん新しい user の行（無いと stale_target、それより後の発言があると unseen_later_turn で断られる。
    // 知らせ・スラッシュコマンドの行も含めるため、チャットの発言ではなく会話ログの行から選ぶ）
    const lastSeen = [...rt.chain].reverse().find((c) => c.type === 'user')?.uuid ?? messageId;
    const result = await rewindConversation(client, messageId, lastSeen).catch(
      (error: unknown): RewindResult => ({ rewound: false, prefillText: null, reason: null, error: error instanceof ControlError ? error.reason : String(error) }),
    );
    if (!result.rewound) return failed(rewindReasonText(result.reason, result.error), choice.code);
    if (rt.process === process) this.cutBefore(id, rt, messageId);
    return { ok: true, prefillText: result.prefillText, error: null };
  }

  // チャットの表示を、uuid の行の前の時点に戻す（巻き戻したとき。次の発言の枝分かれを待たずに、表示を合わせる）
  private cutBefore(id: string, rt: Runtime, uuid: string): void {
    const at = rt.chain.findIndex((c) => c.uuid === uuid);
    if (at === -1) return;
    const kept = rt.events.slice(0, rt.chain[at].eventStart);
    rt.chain = rt.chain.slice(0, at);
    rt.events = kept;
    const fromSeq = rt.seq;
    rt.seq += 1;
    this.listeners.onChat({ sessionId: id, fromSeq, events: [{ type: 'replace', events: kept }], live: true });
    this.changed(id);
  }

  addedFoldersOf(id: string): string[] {
    return this.store.get(id)?.addedFolders ?? [];
  }

  // ワークスペースに追加したフォルダを変える（確かめは呼ぶ側で済ませる）。エクスプローラーのために見張りも合わせる。
  // 動いている claude には、手が空いたときに --resume で起動し直して渡す（作業中・確認待ち・バックグラウンドのタスクがあるうちは止めない）
  setAddedFolders(id: string, folders: string[]): void {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    const rt = this.runtimes.get(id);
    this.store.update(id, { addedFolders: folders, ...(rt?.process ? { addedFoldersPending: true } : {}) });
    if (rt && !record.archived) this.watchFolders(rt, folders);
    this.emitSessions();
    this.restartForFoldersIfIdle(id);
  }

  // 追加フォルダを渡すための起動し直しを待っていて、手が空いていれば起動し直す。
  // 状態の知らせの途中（会話ログの行を読んでいるところなど）で止めないよう、今の処理が終わってから確かめ直す
  private restartForFoldersIfIdle(id: string): void {
    if (!this.store.get(id)?.addedFoldersPending || this.stateOf(id) !== 'idle') return;
    setImmediate(() => {
      if (this.closed || !this.store.get(id)?.addedFoldersPending || this.stateOf(id) !== 'idle') return;
      // 登録した設定ファイルが読めないなどで起動し直せなければ、動いている claude はそのまま（次に手が空いたとき、また試す）
      this.restart(id).catch(() => {});
    });
  }

  // モデル・エフォート・設定ファイルを変える。動いている Claude Code は、モデルとエフォートだけならその場で切り替え（set_model・
  // apply_flag_settings。次の応答から）、設定ファイルを変えたとき・起動の途中・initialize の models に無いモデル（控えにある旧モデルなど。
  // set_model は知らない名前も黙って受け付けるため）は起動し直す（--resume と --model）。止まっていれば、次に起動するときの指定
  async configure(id: string, options: SessionOptions): Promise<void> {
    const record = this.store.get(id);
    const settingsFile = options.settingsFile ?? null;
    const settingsChanged = (record?.settingsFile ?? null) !== settingsFile;
    if (settingsChanged) this.checkSettingsFile(settingsFile);
    // 設定ファイルを変えたら、モデルとエフォートは新しい設定の既定に戻す（前の設定のモデルが、新しい設定で使えるとは限らない）
    const model = settingsChanged ? null : options.model;
    const effort = settingsChanged ? null : options.effort;
    const rt = this.runtimes.get(id);
    if (rt?.process?.client && rt.ready && !settingsChanged && (!rt.init || !model || modelEntry(rt.init, model))) {
      await this.switchModel(id, rt, model, effort);
      return;
    }
    this.store.update(id, { model, effort, settingsFile });
    if (rt?.process) return this.restart(id);
    this.emitSessions();
  }

  // 動いている Claude Code のモデルとエフォートを、その場で切り替える。モデルは initialize の models の中からだけ、エフォートは
  // そのモデルの supportedEffortLevels の中からだけ選ぶ（どちらも、知らない値を黙って受け付けるため。実測）。できなければ理由を添えて投げる
  private async switchModel(id: string, rt: Runtime, model: string | null, effort: string | null): Promise<void> {
    const record = this.store.get(id)!;
    const process = rt.process!;
    const client = process.client!;
    const entry = rt.init ? (model ? modelEntry(rt.init, model) : modelEntry(rt.init, 'default')) : undefined;
    if (model && rt.init && !entry) throw new Error(t('main.model.unknown', { model }));
    const modelChanged = (record.model ?? null) !== model;
    // モデルだけを変えたとき、今のエフォートを新しいモデルで選べなければ、エフォートの指定を外す（そのモデルの既定にする）
    if (modelChanged && effort && effort === (record.effort ?? null) && entry && !effortsOf(entry).includes(effort)) effort = null;
    if (effort && entry && !effortsOf(entry).includes(effort)) throw new Error(t('main.model.effortUnsupported', { effort }));
    const fail = (error: unknown) => new Error(t('main.model.failed', { reason: error instanceof ControlError ? error.reason : String(error) }));
    if (modelChanged) {
      await client.request('set_model', { model }).catch((error: unknown) => Promise.reject(fail(error)));
      if (rt.process !== process) return;
      this.store.update(id, { model });
      if (entry?.resolvedModel) this.updateStatus(id, rt, { model: entry.resolvedModel });
    }
    if (modelChanged || (record.effort ?? null) !== effort) {
      await client.request('apply_flag_settings', { settings: { effortLevel: effort } }).catch((error: unknown) => Promise.reject(fail(error)));
      if (rt.process !== process) return;
      this.store.update(id, { effort });
      // 実際に使うエフォート（指定が無ければ、設定の既定）
      const settings = await client.request<SettingsResponse>('get_settings').catch(() => null);
      if (rt.process !== process) return;
      this.updateStatus(id, rt, { effort: settings?.applied?.effort ?? null });
    }
    // 選んだモデルで auto を使えなければ、manual に戻す（起動するときと同じ。設計書 15 節）
    if (modelChanged && rt.init && rt.knownMode === 'auto' && !autoAvailable(rt.init, model)) {
      await client.request('set_permission_mode', { mode: streamMode('manual') }).catch(() => {});
      if (rt.process === process) this.noteMode(id, rt, 'manual');
    }
    this.emitSessions();
  }

  // 登録した設定ファイルを使えるか確かめる。使えなければ理由を添えて投げる
  private checkSettingsFile(settingsFile: string | null | undefined): void {
    if (!settingsFile) return;
    if (!this.settingsFiles) throw new Error(t('main.settingsFile.unavailable'));
    this.settingsFiles.check(settingsFile);
  }

  // 設定ファイルを選んでいるセッションの起動前に、アプリの設定と登録した設定を合わせたファイルを書く。選んでいなければ null
  // browser: アプリ内ブラウザの MCP サーバーを足すか（合わせる設定に、JavaScript の実行の確認のフックを入れる）
  // sessions: セッションの MCP サーバーを足すか（合わせる設定に、子セッションの起動の確認のフックを入れる）
  // checklist: チェックリストの MCP サーバーを足すか（合わせる設定に、チェックリストを使い続けさせるフックを入れる）
  // terminal: 人のターミナルの MCP サーバーを、打つツールごと足すか（合わせる設定に、打つ前の確認のフックを入れる）
  private prepareSettings(
    id: string,
    settingsFile: string | null | undefined,
    browser: boolean,
    sessions: boolean,
    checklist: boolean,
    terminal: boolean,
  ): PreparedSettings | null {
    if (!settingsFile) {
      // 標準の設定に戻した（または初めから標準）。前の設定ファイルで合わせたファイルが残っていれば消す
      this.settingsFiles?.release(id);
      return null;
    }
    if (!this.settingsFiles) throw new Error(t('main.settingsFile.unavailable'));
    return this.settingsFiles.prepare(id, settingsFile, browser, sessions, checklist, terminal);
  }

  // Claude Code を起動し直して同じ会話を続ける（--resume）。スキル・CLAUDE.md・設定・MCP などを読み込み直すため。
  // 前の Claude Code が終わったのを確かめてから起動する（同じ会話を 2 つのプロセスが書かないように）。
  // 権限モードは、今のモードを --permission-mode で渡す（bypassPermissions は引き継がない）
  async restart(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    const process = rt?.process;
    if (!rt || !process) {
      await this.open(id);
      return;
    }
    // 起動し直せないと分かっているのに、動いている claude を止めないよう、先に設定ファイルを確かめる
    this.checkSettingsFile(this.store.get(id)?.settingsFile);
    const mode = this.relaunchMode(id, rt);
    // 自分で止めるので、切り替えた先の起動の途中の終わりとはみなさない（元の種類に戻さない）
    rt.switchedFrom = null;
    // 止めている間は起動中にする（送った発言が、閉じかけの claude に入って消えないよう、画面は起動が終わるまで預かる。
    // 止めた claude が終わってから次を起動するまでの間も起動中にし、終了は出さない。その間に送ったものは、起動し直した claude に送る）
    const wasReady = rt.ready;
    rt.ready = false;
    let finish = () => {};
    rt.restarting = { process, done: new Promise<void>((resolve) => (finish = resolve)) };
    this.emitSessions();
    this.changed(id);
    try {
      const stopped = await process.stop(this.stopStepMs);
      // 止めている間に、ほかで起動し直した・アーカイブした
      if (this.gone(id, rt)) return;
      if (rt.process === process && !stopped) {
        // 止められなかった（終わりの知らせが来ない）。動いている claude をそのまま使えるように戻し、黙らずに理由を返す
        if (wasReady) this.markReady(id, rt);
        throw new Error(t('main.session.notStopped'));
      }
      if (rt.process) return;
      try {
        // ターミナルモードなら、TUI で起動し直す
        this.start(id, mode, null, rt.terminal ? 'tui' : 'stream');
      } catch (error) {
        // 起動し直せなかった。止めた claude の終わりは出していないので、ここで出す（チャットの「再開」で開き直せる）
        this.pushEvents(id, [{ type: 'process-exit', exitCode: 0 }]);
        throw error;
      }
    } finally {
      rt.restarting = null;
      finish();
      this.emitSessions();
      this.changed(id);
    }
  }

  // ターミナルモードの TUI に打つ（人が画面で打った文字）
  write(id: string, data: string): void {
    this.runtimes.get(id)?.process?.write(data);
  }

  // 発言を送る（stream-json の user の行 1 つ）。画像は image のブロックに、入力欄に貼り付けた長い文（札）は pasted_content に入れる
  // （CLI が TUI と同じ <pasted_content> の囲みに入れる。実測）。同じセッションへの送信は、送った順に届ける（画像を読む間に追い越さない）。
  // priority: later はターンが終わってから別のターンにする（親からの指示・知らせ・予約）。省くと、作業中なら今のターンに取り込まれる
  submit(id: string, rawText: string, attachments: string[] = [], pastes: string[] = [], priority?: 'later'): Promise<void> {
    const rt = this.runtimes.get(id);
    // claude がいない（終わった直後など。画面の状態が遅れて届く）。黙って成功にせず、失敗を返す（画面は、送れなかった発言を預かりに戻す）
    if (!rt || (!rt.process && !rt.restarting)) return Promise.reject(new SendError('notRunning'));
    // ターミナルモードの間は、人が TUI で打つ（チャットからは送らない）
    if (rt.terminal || rt.switching) return Promise.reject(new SendError('terminalMode'));
    const run = async () => {
      const text = stripControlChars(rawText);
      const kept = pastes.map(stripControlChars).filter((p) => p.trim());
      const read = await Promise.all(attachments.map(imageBlock));
      // 再起動で止めている claude には書かない（閉じかけで消える。止め終わるまで rt.process に残る）。画像を読んでいる間に再起動が
      // 始まったときも、起動し直した claude が受け付けるようになるまで待ち、書く先を取り直す
      if (rt.restarting || !rt.ready) await this.untilRestarted(id, rt);
      const process = rt.process;
      const client = process?.client;
      if (!process || !client) throw new SendError('notRunning');
      const images = read.flatMap((r) => ('block' in r ? [r.block] : []));
      // 送れない画像（形式が違う・読めない）は、黙って落とさず、チャットに知らせる
      const skipped = read.flatMap((r) => ('skipped' in r ? [r.skipped] : []));
      if (skipped.length > 0) this.pushEvents(id, [{ type: 'info', id: `images-skipped:${randomUUID()}`, text: t('main.send.imagesSkipped', { names: skipped.join(', ') }) }]);
      if (!text && images.length === 0 && kept.length === 0) return;
      const content: string | ContentBlock[] = images.length === 0 ? text : [...images, ...(text ? [{ type: 'text' as const, text }] : [])];
      const uuid = randomUUID();
      // スラッシュコマンドは発言として残らないものが多いので、送信中に入れない。親の指示などは、会話に出たときと同じ形で出す
      // （子セッション・予約・チェックリストの知らせや最適化圧縮の文は出さないが、会話に出るまでは作業中に数える）
      if (!text.trimStart().startsWith('/')) {
        const view = unsentView(text);
        rt.unsent.set(uuid, {
          id: uuid,
          text: view?.text ?? text,
          pastes: [...(view?.pastes ?? []), ...kept],
          images: images.length,
          state: 'sending',
          ...(view?.parent ? { parent: view.parent } : {}),
          at: Date.now(),
          shown: view !== null,
        });
        this.emitQueue(id, rt);
      }
      client.send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid, ...(kept.length > 0 ? { pasted_content: kept } : {}), ...(priority ? { priority } : {}) });
      this.changed(id);
      this.expireSending(id, rt, uuid);
    };
    const next = rt.sendChain.then(run, run);
    rt.sendChain = next.catch(() => {});
    return next;
  }

  // 再起動の途中に送った発言を、起動し直した claude（止められなかったときは、止めようとした claude）が受け付けるようになるまで待たせる。
  // 止めている間にアーカイブ・一覧から削除した・起動し直せなかった・受け付ける前に終わった（claude がいない）ときと、待ちきれないときは、
  // 送らずに失敗する（止めた claude のまま待ち続けて、送信が返らなくならないように）。また再起動して claude が変わっても、受け付けるまで待つ
  private async untilRestarted(id: string, rt: Runtime): Promise<void> {
    // 受け付けるまでの期限（再起動が終わるたびに数え直す）
    let deadline: number | null = null;
    for (;;) {
      // 待つ間に、また再起動が始まったら（起動の途中にモデルを変えたなど）、それも待つ。claude が変わっても、受け付けるまで書かない
      // （initialize の返事のあとの処理より先に、ターンを始めさせない）
      if (rt.restarting) {
        await rt.restarting.done;
        deadline = null;
      }
      if (this.gone(id, rt) || !rt.process) throw new SendError('exited');
      if (rt.ready) return;
      deadline ??= Date.now() + this.restartSendWaitMs;
      if (Date.now() > deadline) throw new SendError('notReady');
      await sleep(100);
    }
  }

  // この runtime がもう使われない（一覧から外した・アーカイブや削除で片付けている途中）
  private gone(id: string, rt: Runtime): boolean {
    return this.runtimes.get(id) !== rt || rt.closing;
  }

  // 受け付けの知らせも会話ログの行も来ないまま、送信中が残らないよう、時間を区切る
  private expireSending(id: string, rt: Runtime, uuid: string): void {
    setTimeout(() => {
      if (rt.unsent.get(uuid)?.state !== 'sending') return;
      rt.unsent.delete(uuid);
      this.emitQueue(id, rt);
      this.changed(id);
    }, SENDING_TIMEOUT_MS).unref?.();
  }

  // 起動が終わる（入力を受け付けられる）のを待ってから、ターンが終わってから届く発言（priority: later）として送る
  // （子セッションへの指示・親への知らせ・予約）。作業中に送っても、作業中のターンには入らない（Claude Code が順番待ちにする。実測）。
  // 待っている間も、ツールで返す状態は作業中にする。待ちきれない・終わったときは、理由を添えて失敗する。
  // attachments: 画像のパス・pastes: 入力欄の札（submit と同じ）/ signal: 待っている間に取りやめる（予約の取り消し）
  async submitWhenReady(
    id: string,
    text: string,
    timeoutMs: number,
    { attachments = [], pastes = [], signal }: { attachments?: string[]; pastes?: string[]; signal?: AbortSignal } = {},
  ): Promise<void> {
    const rt = this.runtimes.get(id);
    let process = rt?.process ?? null;
    if (!rt || (!process && !rt.restarting)) throw new SendError('notRunning');
    // ターミナルモードの間に来た親の指示・予約・知らせは、預からずに断る（決めたこと）
    if (rt.terminal || rt.switching) throw new SendError('terminalMode');
    rt.pendingSubmits += 1;
    this.changed(id);
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // 待つ間にアーカイブ・一覧から削除した（止めた claude からは終わりの知らせが来ず、受け付けるようにもならない）
        if (this.gone(id, rt)) throw new SendError('exited');
        // 再起動の途中なら、起動し直した claude を待つ
        if (rt.restarting) {
          await rt.restarting.done;
          process = rt.process;
          if (!process) throw new SendError('exited');
          continue;
        }
        if (rt.process !== process) throw new SendError('exited');
        if (signal?.aborted) throw new SendError('cancelled');
        if (rt.ready && !rt.preparing) break;
        if (Date.now() > deadline) throw new SendError('busy');
        await sleep(100);
      }
      await this.submit(id, text, attachments, pastes, 'later');
    } finally {
      rt.pendingSubmits -= 1;
      this.changed(id);
    }
  }

  // 作業を中断する（interrupt。応答待ち・ツールの実行中・許可の確認待ちのどれでも止まる。裏のタスクは止めない。実測）
  interrupt(id: string): void {
    const client = this.runtimes.get(id)?.process?.client;
    void client?.request('interrupt').catch(() => {});
  }

  resize(id: string, cols: number, rows: number): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.size = { cols, rows };
    const process = rt.process;
    if (!process) return;
    process.resize(cols, rows);
    // 引き継いだ TUI の画面は、前のアプリが描いたもので、今の画面には届いていない（画面の用意より前に送った）。最初に画面を出したとき、
    // 常駐のホストが持つ今の画面を取り直して流す（時間に頼らずに描き直す）
    if (rt.redrawFromHost && rt.terminal) {
      const ptyId = rt.redrawFromHost;
      rt.redrawFromHost = null;
      void this.redrawFromHost(id, rt, process, ptyId);
    }
  }

  // ホストは pty の出力を自分の画面に書き終えてから送るので、一覧（list）の画面の控えには、それまでに送った出力がいつも入っている。
  // 端末を初期化（RIS）してから控えを書くと、そのあとに届く出力と、続いた画面になる
  private async redrawFromHost(id: string, rt: Runtime, process: ClaudeSession, ptyId: string): Promise<void> {
    const hosted = await this.host.list().catch(() => [] as HostedInfo[]);
    if (rt.process !== process) return;
    const info = hosted.find((h) => h.id === ptyId);
    if (info?.kind === 'pty') this.listeners.onPtyData(id, `\x1bc${info.screen}`);
  }

  // 前のアプリが起動して、アプリの再起動をまたいで動いている claude を引き継ぐ
  async adopt(): Promise<void> {
    for (const info of await this.host.list()) {
      const record = this.store.get(info.tag);
      if (info.exitCode !== null) {
        this.host.forget(info.id);
        continue;
      }
      if (!record || record.archived || this.runtimes.get(record.id)?.process) {
        if (info.kind === 'pty') this.host.attach(info).kill();
        else this.host.attachPipe(info).kill('SIGTERM');
        continue;
      }
      // pty の claude は、前のアプリがターミナルモードで起動したもの（PROTOCOL 3 のホストには、ほかに pty の claude はいない）
      this.start(record.id, null, info);
    }
  }

  // アプリの終了時。claude は止めずに見るのをやめる（次に起動したアプリが引き継ぐ）。stop: claude も止める
  closeAll(stop: boolean): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, rt] of this.runtimes) {
      if (stop) {
        rt.process?.kill();
        this.settingsFiles?.release(id);
      } else {
        // 次のアプリが claude を引き継いだときに、送信中・順番待ちを戻せるよう残す
        const unsent = rt.process ? [...rt.unsent.values()].map(({ at: _, ...prompt }) => prompt) : [];
        this.store.update(id, { unsent: unsent.length > 0 ? unsent : null });
        rt.process?.detach();
      }
      rt.workflows.dispose();
      rt.subagents.dispose();
      rt.bashTasks.dispose();
      if (rt.progressTimer) clearInterval(rt.progressTimer);
      if (rt.startWatch) clearInterval(rt.startWatch.timer);
      if (rt.turnEnding) clearTimeout(rt.turnEnding.timer);
    }
    this.watchers.closeAll();
    this.store.flush();
  }

  isFocused(id: string): boolean {
    return this.focusedId === id;
  }

  // stream-json の送受信の控えのファイル（userData/stream-logs/<セッション ID>.log）
  private streamLogFor(id: string): string {
    return join(dirname(this.statusLines.dir), 'stream-logs', `${id}.log`);
  }

  // 起動するときの権限モード。指定（新規セッションの画面・子の起動のモード・起動し直すときの今のモード）があればそれ。
  // 無ければ設定の defaultMode、それも無ければ auto（決めたこと。設計書 15 節）。止まっていたセッションを開き直すときも同じで、
  // 前回のモードは使わない（今のアプリの動きのまま）。bypassPermissions は引き継がない（起動し直しと同じ）
  private startMode(record: SessionRecord, requested: PermissionMode | null, settings: PreparedSettings | null): PermissionMode {
    if (requested) return requested;
    const configured = appMode(settingsDefaultMode(record.cwd, settings?.settingsFile ?? null, this.claudeDir));
    if (configured && configured !== 'bypassPermissions') return configured;
    return 'auto';
  }

  // mode: --permission-mode で渡す権限モード（このセッションだけ）。null なら startMode で決める。
  // adopted: 起動せずに引き継ぐ、動いている claude
  // kind: 起動の種類（チャットは stream、ターミナルモードは tui）。引き継ぐ claude は、ホストのプロセスの種類（pipe・pty）で決まる
  private start(id: string, mode: PermissionMode | null = null, adopted: HostedPipeInfo | HostedPtyInfo | null = null, kind: LaunchKind = 'stream'): void {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    const tui = adopted ? adopted.kind === 'pty' : kind === 'tui';

    // 設定ファイルを使えなければ、何も変えずにここで断る（標準の設定に黙って切り替わらないように）。
    // 引き継ぐ claude は、前のアプリが起動したままなので、書き直さない
    const browser = adopted ? null : this.browser();
    const launch = adopted ? null : this.sessionsMcp();
    const checklist = adopted ? null : this.checklistMcp();
    const walkthrough = adopted ? null : this.walkthroughMcp();
    const terminalLaunch = adopted ? null : this.terminalMcp();
    // 子セッションには、子を動かすツールを見せない（孫は作れない）。人のターミナルも、読むツールだけ（打てるのは、人が見ている親だけ）
    const sessions = launch && record.parentId ? { ...launch, child: true } : launch;
    const terminal: TerminalMcpLaunch | null = terminalLaunch && record.parentId ? { ...terminalLaunch, child: true } : terminalLaunch;
    const settings = adopted ? null : this.prepareSettings(id, record.settingsFile, !!browser, !!sessions, !!checklist, !!terminal && !terminal.child);
    // 引き継ぐ claude は起動しないので、渡すモードは使わない（前のアプリが渡したモードのまま動いている）
    const permissionMode = adopted ? (record.knownMode ?? 'manual') : this.startMode(record, mode, settings);

    // 会話が一度も無いセッションは --resume できないため、新しいセッション ID で始め直す
    const resume = !!adopted || hasConversation(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir));
    if (!resume) this.store.update(id, { claudeSessionId: randomUUID() });
    const claudeSessionId = this.store.get(id)!.claudeSessionId;

    let rt = this.runtimes.get(id);
    if (!rt) {
      const workflows = new WorkflowTracker((runs) => {
        this.listeners.onWorkflows(id, runs);
        this.countBackground(id);
      });
      const subagents = new SubagentTracker(record.cwd, (runs) => {
        this.listeners.onSubagents(id, runs);
        this.countBackground(id);
      });
      const bashTasks = new BashTaskTracker((tasks) => {
        this.listeners.onBashTasks(id, tasks);
        this.countBackground(id);
      });
      const tasks = new TaskRouter({
        workflows,
        subagents,
        bashTasks,
        sessionDir: () => this.sessionDir(id),
      });
      rt = {
        process: null,
        seq: 0,
        events: [],
        unread: false,
        workflows,
        subagents,
        bashTasks,
        tasks,
        knowledge: new KnowledgeTracker(
          record.cwd,
          (value) => this.listeners.onKnowledge(id, value),
          () => this.store.get(id)?.addedFolders ?? [],
        ),
        context: new ContextTracker(record.cwd),
        statusLine: null,
        chain: [],
        attention: null,
        background: 0,
        permissionAt: null,
        hookStarts: new Map(),
        streamTools: [],
        shownTools: new Set(),
        streamMessages: new Map(),
        heldHooks: new Map(),
        requests: new Map(),
        elicitations: new Map(),
        openedUrls: new Map(),
        questionWaits: new Map(),
        plans: new Map(),
        planFile: null,
        planInputs: new Map(),
        settingsPath: null,
        plansDirectory: null,
        quietAttention: false,
        terminal: false,
        switching: false,
        switchStopping: null,
        restarting: null,
        closing: false,
        switchedFrom: null,
        tuiBaseline: null,
        tuiRemoteSeen: false,
        tuiTurn: false,
        tuiAsk: null,
        redrawFromHost: null,
        init: null,
        ready: false,
        knownMode: null,
        modeAt: 0,
        size: DEFAULT_PTY_SIZE,
        aliveSince: null,
        turnOpen: false,
        lastTurnLine: null,
        turnPrompt: null,
        promptLine: null,
        arrivedPrompts: new Set(),
        turnEnding: null,
        lateTurnEnd: null,
        turnStarter: 'other',
        starterSeen: false,
        progress: null,
        progressTimer: null,
        partial: new PartialText(),
        partialTimer: null,
        startWatch: null,
        unsent: new Map(),
        sendChain: Promise.resolve(),
        caughtUp: true,
        remoteConnected: false,
        remoteSwitching: false,
        bridgeSessionId: record.bridgeSessionId ?? null,
        freshConversation: false,
        contextSize: null,
        taskIds: new Map(),
        taskEnds: new Map(),
        historyLoaded: false,
        lastBridgeUrl: undefined,
        titleRequested: false,
        preparing: null,
        worktreeCreated: null,
        watched: null,
        watchedFolders: [],
        pendingSubmits: 0,
        checklistMcp: null,
        stderr: '',
      };
      this.runtimes.set(id, rt);
    }
    rt.checklistMcp = adopted ? null : !!checklist;
    // worktree は、Claude Code が作るまでフォルダが無い（作ったあとで見張る）
    this.watch(rt, record.cwd);
    this.watchFolders(rt, record.addedFolders ?? []);
    // 新しく起動する claude には、今の追加フォルダを --add-dir で渡す（引き継ぐ claude は前の引数のままなので、待ちを残す）
    if (!adopted && record.addedFoldersPending) this.store.update(id, { addedFoldersPending: false });
    rt.events = [];
    rt.chain = [];
    // 再開すると過去の会話を読み直すので、そこから集め直す
    rt.knowledge.reset();
    rt.context.reset();
    // 前の claude の書きかけの文は捨てる（起動の知らせと一緒に送る）
    rt.partial.clear();
    this.pushEvents(id, [{ type: 'process-start' }]);
    const runtime = rt;
    runtime.attention = null;
    runtime.ready = false;
    runtime.init = null;
    runtime.terminal = tui;
    // 止まっても、アプリを起動し直しても、この種類のまま開く（記録の terminal）
    if (!!record.terminal !== tui) this.store.update(id, { terminal: tui });
    runtime.switchedFrom = null;
    runtime.tuiBaseline = tui ? { model: runtime.statusLine?.model?.id ?? null, effort: runtime.statusLine?.effort ?? null } : null;
    runtime.tuiRemoteSeen = false;
    runtime.tuiTurn = false;
    runtime.tuiAsk = null;
    runtime.redrawFromHost = adopted?.kind === 'pty' ? adopted.id : null;
    runtime.freshConversation = false;
    runtime.requests.clear();
    // 引き継ぐ claude には、前のアプリが送って、まだ会話に出ていなかった発言を戻す（済んだものは、送り直しの行と会話ログで外れる）
    runtime.unsent = new Map(adopted && !tui ? (record.unsent ?? []).map((prompt) => [prompt.id, { ...prompt, at: Date.now() }]) : []);
    if (record.unsent) this.store.update(id, { unsent: null });
    // 引き継ぐ claude は、前のアプリが決めたモードのまま動いているので、記録から戻す（Claude Code が知らせたら、そちらにする）
    runtime.knownMode = adopted ? (record.knownMode ?? null) : permissionMode;
    if (!adopted) this.store.update(id, { knownMode: permissionMode });
    runtime.aliveSince = adopted?.startedAt ?? null;
    runtime.turnOpen = false;
    runtime.lastTurnLine = null;
    if (runtime.turnEnding) clearTimeout(runtime.turnEnding.timer);
    runtime.turnEnding = null;
    runtime.lateTurnEnd = null;
    // 前の claude のツールの呼び出し・待たせていたフック・発言の鍵は持ち越さない（結果が来ないまま止まった呼び出しが、次の同じ名前の
    // 呼び出しのフックを決められなくし、待たせたフックが、関係のない発言のあとに出るため）
    runtime.streamTools = [];
    runtime.streamMessages.clear();
    runtime.heldHooks.clear();
    runtime.hookStarts.clear();
    runtime.turnPrompt = null;
    runtime.promptLine = null;
    runtime.starterSeen = false;
    runtime.titleRequested = false;
    runtime.settingsPath = settings?.settingsFile ?? null;
    runtime.caughtUp = !adopted;
    this.stopProgress(id, runtime);
    this.stopStartWatch(id, runtime);
    // Remote Control のつながりは、会話ログ（bridge-session）と bridge_state で分かる
    runtime.remoteConnected = false;
    runtime.remoteSwitching = false;
    runtime.taskIds.clear();
    // 読み直す会話ログが無ければ（新しい会話）、読み終わりの知らせは来ないので、はじめから読み終えたことにする
    runtime.historyLoaded = fileSize(transcriptPath(record.cwd, claudeSessionId, this.claudeDir)) === 0;
    runtime.lastBridgeUrl = undefined;

    // 新しい worktree で始めるときは、Claude Code が作り終えるまで準備中にする。
    // 前の起動が worktree を作ったあと、起動が終わる前に終わって（起動し直して）いたら、その「作成中」は戻す
    // （戻さないと、起動が終わっても受け付けない。node_modules の用意の途中なら、終わるまで待たせたまま）
    const creating = !!record.worktree && !resume && !adopted && !existsSync(record.cwd);
    if (creating) runtime.preparing = 'creating';
    else if (runtime.preparing === 'creating') runtime.preparing = null;

    const process: ClaudeSession = new ClaudeSession(
      this.host,
      {
        sessionId: id,
        kind: tui ? 'tui' : 'stream',
        cwd: record.cwd,
        worktree: record.worktree?.name ?? null,
        worktreeRoot: record.worktree?.root ?? null,
        claudeSessionId,
        resume,
        // stream-json は、起動したあとに remote_control の要求でつなぐ。TUI は起動の引数で（前のつながりに自動でつなぎ直す。実測）
        remoteControlName: tui && this.wantsRemote(record) ? remoteName(record.cwd) : null,
        model: record.model ?? null,
        effort: record.effort ?? null,
        permissionMode,
        settings,
        statusFile: this.statusLines.fileFor(id),
        askFile: this.statusLines.askFileFor(id),
        browser,
        sessions,
        checklist,
        walkthrough,
        terminal,
        claudeDir: this.claudeDir,
        // 追加したあとで消した・動かしたフォルダは渡さない（エクスプローラーには残し、人が外せるようにする）
        addDirs: (record.addedFolders ?? []).filter((folder) => existsSync(folder)),
        streamLog: tui ? null : this.streamLogFor(id),
        ...rt.size,
      },
      {
        onData: (data) => this.listeners.onPtyData(id, data),
        stream: tui ? undefined : {
          onMessage: (message, past) => {
            if (runtime.process === process) this.handleStream(id, runtime, message, past);
          },
          onPermission: (requestId, request, replayed) => {
            if (runtime.process === process) this.requestAdded(id, runtime, requestId, request, replayed);
          },
          onElicitation: (requestId, request, replayed) => {
            if (runtime.process === process) this.elicitationAdded(id, runtime, requestId, request, replayed);
          },
          onCancel: (requestId) => {
            if (runtime.process === process) this.requestRemoved(id, runtime, requestId);
          },
          onCaughtUp: () => {
            if (runtime.process !== process) return;
            runtime.caughtUp = true;
            this.historySettled(id, runtime, true);
          },
        },
        onExit: (exitCode, stderr) => {
          // アーカイブ（kill）・アプリの終了のあとに届いた終わりは、片付け済み。開き直していれば、新しい起動の表示に流さない
          if (runtime.process !== process || this.runtimes.get(id) !== runtime || this.closed) return;
          runtime.process = null;
          runtime.stderr = stderr ?? '';
          runtime.ready = false;
          this.settingsFiles?.release(id);
          this.questions.releaseAll(id);
          this.releaseRequests(id, runtime);
          rt.workflows.stopRunning();
          rt.subagents.stopRunning();
          rt.bashTasks.stopRunning();
          if (runtime.turnEnding) this.flushTurnEnd(id, runtime);
          runtime.turnOpen = false;
          this.stopProgress(id, runtime);
          this.stopStartWatch(id, runtime);
          // 書きかけのまま終わった文は、会話ログに出ないので捨てる（このあとの終了の知らせと一緒に送る）
          runtime.partial.clear();
          if (runtime.unsent.size > 0) {
            runtime.unsent.clear();
            this.emitQueue(id, runtime);
          }
          runtime.tuiTurn = false;
          runtime.tuiAsk = null;
          // チャットとターミナルモードの切り替え・再起動で、アプリが止めたときは、終了を出さない（すぐ起動し直す。起動できなければ、
          // そこで出す）。切り替えの途中でも、claude が自分で終わった（落ちた）ときは出す（出さないと止まったと分からず、送った発言が黙って消える）
          if (runtime.switchStopping !== process && runtime.restarting?.process !== process) {
            const back = runtime.switchedFrom;
            runtime.switchedFrom = null;
            if (back === 'stream') {
              // ターミナルモードに切り替えた先の TUI が、起動を終える前に終わった（フォルダの信頼の確認で「No, exit」など）。
              // チャットで開き直さず、ターミナルモードのまま止めて、終了の表示にわけだけ出す（チャットは隠れているので、会話には足さない。
              // 「再開」か、切り替えボタンでチャットに戻す。決めたこと）
              this.pushEvents(id, [{ type: 'process-exit', exitCode, reason: t('main.terminal.tuiExited', { code: exitCode }) }]);
            } else if (back) {
              // チャットに戻した先が、起動を終える前に終わった。元の種類（ターミナルモード）で開き直し、わけを出す
              this.pushEvents(id, [{ type: 'info', id: `switch-back:${Date.now()}`, text: t('main.terminal.chatExited', { code: exitCode }) }]);
              try {
                this.start(id, this.relaunchMode(id, runtime), null, back);
              } catch (error) {
                console.error('切り替える前の種類で開き直せませんでした', error);
                this.pushEvents(id, [{ type: 'process-exit', exitCode }]);
              }
            } else {
              this.pushEvents(id, [{ type: 'process-exit', exitCode }]);
            }
          }
          this.emitSessions();
        },
        onEntry: (entry, isHistory) => this.handleEntry(id, entry, isHistory),
        // 再開時、応答のないまま終わった過去のターンを作業中として扱わない。
        // 引き継いだ claude がターンの途中なら、本当に作業中なのでそのままにする（前のアプリの頃の行を読み終えてから決める）
        onHistoryLoaded: () => {
          runtime.historyLoaded = true;
          this.historySettled(id, runtime, adopted !== null);
        },
        onSwitch: (nextClaudeSessionId) => {
          this.store.update(id, { claudeSessionId: nextClaudeSessionId });
          this.changed(id);
          rt.chain = [];
          rt.heldHooks.clear();
          rt.knowledge.reset();
          rt.context.reset();
          this.pushEvents(id, [this.compactClearing(id) ? { type: 'reset', compact: true } : { type: 'reset' }]);
        },
      },
      adopted,
    );
    rt.process = process;
    process.start();
    if (runtime.unsent.size > 0) {
      this.emitQueue(id, runtime);
      for (const prompt of runtime.unsent.values()) if (prompt.state === 'sending') this.expireSending(id, runtime, prompt.id);
    }
    if (tui) {
      // TUI には initialize を送らない（人が画面で操作する）。起動したら受け付けたことにする
      this.markReady(id, runtime);
    } else {
      if (!adopted) this.watchStart(id, runtime, process);
      void this.initialize(id, runtime, process, adopted as HostedPipeInfo | null, claudeSessionId);
    }
    if (creating) {
      // この起動が続いているか。終わった・起動し直した・アーカイブした（止めたときは、終了の知らせが来ない）ら、待つのをやめる
      const alive = () => runtime.process === process && this.runtimes.get(id) === runtime;
      const waiting: Promise<boolean> = waitForWorktree(record.cwd, alive).then((created) => {
        if (created && alive()) {
          this.watch(runtime, record.cwd);
          // .git ができた時点では、git worktree add がまだファイルを書き出している（大きなリポジトリでは、git ls-files が空になる。実測）。
          // Claude Code は worktree を作り終えてから initialize に答えるので、それを待ってから node_modules を用意する
          void this.untilInitialized(runtime, alive).then((ready) => {
            if (ready) void this.prepareWorktree(id, 'created');
          });
        } else if (runtime.worktreeCreated === waiting && runtime.preparing === 'creating') {
          // 作っている途中に起動し直していたら、「作成中」は新しい起動のもの（消さない）
          runtime.preparing = null;
        }
        return created;
      });
      runtime.worktreeCreated = waiting;
    }
    this.emitSessions();
  }

  // 起動の直後に 1 回だけ initialize を送る。perTaskStopAffordance: 中断で裏のタスクまで止めない（TUI の Esc と同じ。実測）。
  // フックと MCP は initialize では渡さず、--settings・--mcp-config で渡す（ターミナルモードで開き直しても同じ設定にするため）。
  // 引き継いだ claude には送らない（前のアプリが済ませている）。返事のあと、形の違う設定ファイル（-p は黙って無視する）を確かめる。
  // conversation: 起動したときの会話の ID（残った claude を見分けるため、pid と一緒に記録する）
  private async initialize(id: string, rt: Runtime, process: ClaudeSession, adopted: HostedPipeInfo | null, conversation: string): Promise<void> {
    const client = process.client;
    if (!client) return;
    if (adopted) {
      // initialize の返事は、前のアプリが受け取ったものを記録から戻す（同じ claude には送り直さない）
      const saved = this.store.get(id)?.claudeInit;
      if (saved) rt.init = { ...saved, account: {} };
      // モード・モデルは、控えの種類ごとの最新の行（init・status）から組み立て直す。エフォートだけ聞き直す
      const settings = await client.request<SettingsResponse>('get_settings').catch(() => null);
      if (rt.process !== process) return;
      if (settings) this.updateStatus(id, rt, { effort: settings.applied?.effort ?? null });
      this.notePlansDirectory(id, rt, settings);
      this.markReady(id, rt);
      void this.refreshContext(id, rt);
      return;
    }
    let init: InitializeResponse;
    try {
      // MCP サーバー・SessionStart のフック・worktree の作成を待ってから答えるので、時間を区切らない（起動が遅いことは watchStart で知らせる）
      init = await client.request<InitializeResponse>('initialize', { perTaskStopAffordance: true }, null);
    } catch (error) {
      // 答えずに終わった。終わりの知らせ（理由は標準エラー）で片付ける
      console.error('initialize に答えがありませんでした', error);
      return;
    }
    if (rt.process !== process) return;
    rt.init = init;
    this.stopStartWatch(id, rt);
    if (typeof init.pid === 'number') this.store.update(id, { claudeProcess: { pid: init.pid, conversation } });
    this.store.update(id, { claudeInit: { commands: init.commands, models: init.models, remote_control_available: init.remote_control_available } });
    if (init.current_permission_mode) this.noteMode(id, rt, appMode(init.current_permission_mode));
    const settings = await client.request<SettingsResponse>('get_settings').catch(() => null);
    if (rt.process !== process) return;
    this.notePlansDirectory(id, rt, settings);
    // 読めない項目のある設定ファイルは、Claude Code がその項目を黙って使わない（get_settings の errors。どのファイルかは file）。
    // 登録した設定ファイル（合わせて --settings に渡したもの）なら、登録した設定を黙って標準に切り替えないよう、止めて理由を出す。
    // ほかの設定ファイル（ユーザー・プロジェクトの設定）なら、Claude Code の TUI と同じく、知らせて続ける
    const errors = settings?.errors ?? [];
    const registered = errors.filter((e) => rt.settingsPath !== null && settingsErrorFile(e) === rt.settingsPath);
    const others = errors.filter((e) => !registered.includes(e));
    if (others.length > 0) {
      const details = others.map((e) => describeSettingsError(e)).join('\n');
      this.pushEvents(id, [{ type: 'info', id: `settings-warning:${Date.now()}`, text: t('main.settingsFile.ignored', { details }) }]);
    }
    if (registered.length > 0) {
      const details = registered.map((e) => describeSettingsError(e)).join('\n');
      this.pushEvents(id, [{ type: 'info', id: `settings-error:${Date.now()}`, text: t('main.settingsFile.rejected', { details }) }]);
      void process.stop();
      return;
    }
    // system/init は最初の発言まで届かないので、モデル（解決済みの ID）と Claude Code のバージョンは、ここで分かるものを先に出す（ヘッダーが最初から埋まる）
    const applied = settings?.applied;
    this.updateStatus(id, rt, {
      effort: applied?.effort ?? null,
      ...(applied?.model ? { model: applied.model } : {}),
      ...(init.claude_code_version ? { version: init.claude_code_version } : {}),
    });
    // 選んだモデルで auto を使えなければ、manual に戻す（決めたこと。設計書 15 節）
    if (rt.knownMode === 'auto' && !autoAvailable(init, this.store.get(id)?.model ?? null)) {
      await client.request('set_permission_mode', { mode: streamMode('manual') }).catch(() => {});
      this.noteMode(id, rt, 'manual');
    }
    this.markReady(id, rt);
    // コンテキストの使用量は、次のターンの終わりを待たずに聞く（再開した会話は、はじめから使っている）
    void this.refreshContext(id, rt);
  }

  // 起動を見張る。initialize の返事が無いまま slowStartMs を過ぎたら、経過と標準エラーの末尾を進み具合（starting）で知らせ続ける
  private watchStart(id: string, rt: Runtime, process: ClaudeSession): void {
    this.stopStartWatch(id, rt);
    const since = Date.now();
    const after = this.slowStartMs;
    const timer = setInterval(() => {
      const watch = rt.startWatch;
      if (watch?.timer !== timer) return;
      if (rt.process !== process || rt.init) {
        this.stopStartWatch(id, rt);
        return;
      }
      if (Date.now() - since < after) return;
      // 標準エラーは、ホストが控えている末尾（起動の途中では、ほかに読む道が無い）
      void this.host.list().then(
        (hosted) => {
          if (rt.startWatch !== watch) return;
          const info = hosted.filter((h) => h.kind === 'pipe' && h.tag === id && h.exitCode === null).at(-1);
          if (info?.kind === 'pipe') watch.stderr = info.stderr;
          this.listeners.onProgress(id, slowStartActivity(rt, Date.now()));
        },
        () => {},
      );
    }, Math.min(PROGRESS_TICK_MS, after));
    timer.unref?.();
    rt.startWatch = { since, after, timer, stderr: '' };
  }

  private stopStartWatch(id: string, rt: Runtime): void {
    const watch = rt.startWatch;
    if (!watch) return;
    clearInterval(watch.timer);
    rt.startWatch = null;
    // 知らせていたら消す
    if (!rt.progress && Date.now() - watch.since >= watch.after) this.listeners.onProgress(id, null);
  }

  // 受け付けられるようになった（worktree の準備の途中なら、準備が終わってから）
  private markReady(id: string, rt: Runtime): void {
    if (!rt.terminal) rt.switchedFrom = null;
    if (!rt.preparing && !rt.ready) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
      this.reconcileRemote(id, rt);
    }
    this.emitSessions();
  }

  // initialize の返事が来るまで待つ。その前に終わった・起動し直した・アーカイブしたら（alive が false）false
  private async untilInitialized(rt: Runtime, alive: () => boolean): Promise<boolean> {
    for (;;) {
      if (!alive()) return false;
      if (rt.init || rt.ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // 見張る追加フォルダを folders に合わせる（増えたものを見張り、外したものをやめる）
  private watchFolders(rt: Runtime, folders: string[]): void {
    for (const folder of folders) if (!rt.watchedFolders.includes(folder)) this.watchers.retain(folder);
    for (const folder of rt.watchedFolders) if (!folders.includes(folder)) this.watchers.release(folder);
    rt.watchedFolders = [...folders];
  }

  // ファイルの変更を見張る（フォルダがあれば。同じセッションでは一度だけ）
  private watch(rt: Runtime, cwd: string): void {
    if (rt.watched || !existsSync(cwd)) return;
    this.watchers.retain(cwd);
    rt.watched = cwd;
  }

  // worktree に node_modules を用意する。終わるまで ready を配信しない（最初の指示は、準備が終わってから送られる）
  private async prepareWorktree(id: string, how: 'created' | 'restored'): Promise<void> {
    const record = this.store.get(id);
    const rt = this.runtimes.get(id);
    if (!record?.worktree || !rt) return;
    const { root, name, branch } = record.worktree;
    // 起動した Claude Code が先に起動を終えても、準備が終わるまで待たせる（await より前に決める）
    rt.preparing = 'copying';
    this.emitSessions();
    const step = (preparing: WorktreePreparing) => {
      if (this.runtimes.get(id) !== rt) return;
      rt.preparing = preparing;
      this.emitSessions();
    };
    const result = await prepareNodeModules(root, record.cwd, {
      onStep: step,
      install: (cwd, dir, command) => this.runTask(id, cwd, command, dir ? t('main.worktree.commandAt', { command, dir }) : command),
    }).catch((error: unknown): NodeModulesResult => {
      console.error('node_modules を用意できませんでした', error);
      return { cloned: [], failed: [], installs: [] };
    });
    if (this.runtimes.get(id) !== rt) return;
    rt.preparing = null;
    const notes = [t(how === 'created' ? 'main.worktree.started' : 'main.worktree.restored', { name, branch }), ...nodeModulesNotes(result)];
    this.pushEvents(id, [{ type: 'info', id: `worktree:${Date.now()}`, text: sentences(notes) }]);
    // 準備の間に起動を終えていたら、ここで受け付けられるようになったことにする
    if (!rt.ready && rt.init && rt.process) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
      this.reconcileRemote(id, rt);
    }
    this.emitSessions();
  }

  // 会話ログを読み終え、引き継いだ claude なら前のアプリの頃の行も読み終えたら、過去の会話の終わりを決める
  private historySettled(id: string, rt: Runtime, adopted: boolean): void {
    if (!rt.historyLoaded || !rt.caughtUp) return;
    if (!rt.turnOpen) this.pushEvents(id, [{ type: 'turn-end' }]);
    // 前のアプリの頃に始まったターンの途中なら、進み具合を始める（経過はここから数える）
    else if (!rt.progress && rt.process) this.startProgress(id, rt);
    // 引き継いだ claude は、最後の bridge-session 行のつながりのまま動いている
    // （以前つないでいた会話を再開すると、フラグが無くてもつなぎ直すため）
    if (adopted && rt.lastBridgeUrl !== undefined) {
      rt.remoteConnected = rt.lastBridgeUrl !== null;
      this.pushEvents(id, [{ type: 'remote-control', url: rt.lastBridgeUrl }]);
    }
  }

  // stream-json の出力の 1 行（制御の要求と返事は StreamClient が受け持つ）。past: 引き継いだときの、前のアプリの頃の行
  // （状態だけを組み立て直し、通知やチャットの知らせは出さない）。状態は行の種類だけで決め、順番を仮定しない（設計書 6・7 節）
  private handleStream(id: string, rt: Runtime, message: StreamMessage, past: boolean): void {
    // 前のアプリの頃に始まったターンの途中に、今の行が来た（読み終わりより前に来ることもある）
    if (!past && rt.turnOpen && !rt.progress && message.type !== 'result') this.startProgress(id, rt);
    switch (message.type) {
      case 'system':
        this.handleSystem(id, rt, message, past);
        return;
      case 'assistant':
        this.handleAssistant(id, rt, message as AssistantMessage, past);
        return;
      case 'user': {
        const user = message as UserMessage;
        // スマホ・claude.ai から届いた発言（Remote Control）は、それでターンが始まる
        if (user.isReplay && user.origin?.kind === 'human' && !user.parent_tool_use_id) this.openTurn(id, rt, past);
        // 本体のツールの結果は、ターンの最後の行になりうる（ツールの切れ目でフックが止めたとき）
        if (!user.isReplay && !user.parent_tool_use_id && rt.turnOpen && user.uuid && isToolResult(user)) rt.lastTurnLine = user.uuid;
        // 結果が来たツールの呼び出しは、フックを付ける先の候補から外す（quietHook）
        if (!past) this.toolsFinished(rt, user);
        return;
      }
      case 'result':
        this.closeTurn(id, rt, message as ResultMessage, past);
        return;
      case 'command_lifecycle':
        this.handleLifecycle(id, rt, message as CommandLifecycleMessage, past);
        return;
      case 'stream_event':
        if (message.parent_tool_use_id || past) return;
        this.openTurn(id, rt, past);
        if (rt.progress?.streamEvent(message)) this.emitProgress(id, rt);
        if (rt.partial.event(message)) this.schedulePartial(id, rt);
        return;
      case 'tool_progress':
        if (message.parent_tool_use_id || past) return;
        if (rt.progress?.tool()) this.emitProgress(id, rt);
        return;
      case 'rate_limit_event': {
        const rateLimits = rateLimitsOf(message);
        if (rateLimits) this.updateStatus(id, rt, { rateLimits });
        return;
      }
      case 'conversation_reset':
        // 新しい会話の ID は、このあとの system/init の session_id（new_conversation_id とは別。実測）。
        // 新しい会話の最初の応答までは、コンテキストの量を分からないとする（ヘッダーのメーターは会話ログの量。無ければ空）
        if (past) return;
        rt.freshConversation = true;
        rt.partial.clear();
        this.updateStatus(id, rt, { context: null });
        return;
    }
  }

  private handleSystem(id: string, rt: Runtime, message: Extract<StreamMessage, { type: 'system' }>, past: boolean): void {
    switch (message.subtype) {
      case 'init': {
        const init = message as Extract<StreamMessage, { subtype: 'init' }>;
        this.noteMode(id, rt, appMode(init.permissionMode));
        this.updateStatus(id, rt, { model: init.model, version: init.claude_code_version, ...(init.effort ? { effort: init.effort } : {}) });
        // /clear のあとの新しい会話（init の session_id が変わる）。会話ログを乗り換える
        const record = this.store.get(id);
        if (record && init.session_id && init.session_id !== record.claudeSessionId) {
          rt.process?.followTranscript(transcriptPath(record.cwd, init.session_id, this.claudeDir));
        }
        return;
      }
      case 'status': {
        const status = message as StatusMessage;
        if (status.permissionMode) this.noteMode(id, rt, appMode(status.permissionMode));
        // 権限モードの変化の行は、圧縮の始まり・終わりに数えない
        else if (!past) this.compactStatus(id, rt, status);
        return;
      }
      case 'permission_check_status': {
        // auto モードの判定を待っている間は、作業中の表示を「安全を確認しています」にする。サブエージェントの中の判定は数えない
        // （進み具合は、本体の行だけで作る）
        const check = message as PermissionCheckStatusMessage;
        if (past || check.agent_id) return;
        if (rt.progress?.checking(check.tool_use_id, check.status === 'checking')) this.emitProgress(id, rt);
        return;
      }
      case 'bridge_state': {
        // Remote Control のつながり（ready・connected はつながっている。failed などは切れた）
        const state = (message as BridgeStateMessage).state;
        const connected = state === 'ready' || state === 'connected';
        if (rt.remoteConnected === connected) return;
        rt.remoteConnected = connected;
        this.emitSessions();
        this.changed(id);
        return;
      }
      case 'task_started': {
        // 裏のタスクを止めるときの ID（tool_use の ID から引く）
        const task = message as TaskStartedMessage;
        if (task.tool_use_id) rt.taskIds.set(task.tool_use_id, task.task_id);
        return;
      }
      case 'task_notification': {
        // 裏のタスクが終わった（止めた・済んだ・失敗した）。止める頼みを送っていれば、止まったことにする
        const taskId = (message as TaskNotificationMessage).task_id;
        rt.taskEnds.get(taskId)?.();
        rt.taskEnds.delete(taskId);
        return;
      }
      case 'hook_started':
        if (past) return;
        rt.hookStarts.set((message as HookStartedMessage).hook_id, Date.now());
        if (rt.hookStarts.size > MAX_HOOK_STARTS) rt.hookStarts.delete(rt.hookStarts.keys().next().value!);
        return;
      case 'hook_response':
        if (!past) this.quietHook(id, rt, message as HookResponseMessage);
        return;
      case 'api_retry': {
        if (past) return;
        // 入力なしで始まったターン（裏のタスクの完了の知らせなど）は、再試行の行だけが続くことがあるので、ターンの始まりに数える。
        // 裏のタスクが動いている間は数えない（裏のクエリが利用枠を待つ間も、同じ形の行が出る。Claude Code 2.1.301 の本体）
        if (rt.background === 0) this.openTurn(id, rt, past);
        const retry = message as Extract<StreamMessage, { subtype: 'api_retry' }>;
        const text = t('chat.transcript.apiErrorRetrying', { message: retry.error_status ? `${retry.error} (${retry.error_status})` : retry.error, attempt: retry.attempt, max: retry.max_retries });
        this.pushEvents(id, [{ type: 'api-error', id: retry.uuid, text, retrying: true }]);
        return;
      }
      case 'notification': {
        // Claude Code の警告。会話ログに残らないので、ここでチャットに出す（起動し直すと消える。api_retry と同じ）。ターンは始めない
        if (past) return;
        const event = notificationEvent(message as NotificationMessage);
        if (event) this.pushEvents(id, [event]);
        return;
      }
      case 'model_refusal_fallback':
        // モデルが断った応答を取り消して、別のモデルで取り直す。お知らせは会話ログの同じ行から出す（handleEntry）。
        // 取り消された応答は会話ログに出ないので、ここで書いている途中の文から外し、ターンの終わりにも待たない
        if (!past) this.retractStreamed(id, rt, (message as ModelRefusalFallbackMessage).retracted_message_uuids ?? []);
        return;
      case 'elicitation_complete':
        this.elicitationCompleted(id, rt, message as ElicitationCompleteMessage);
        return;
      case 'commands_changed': {
        // / のコマンドの一覧が変わった（スキルのファイルを足した・プラグインを読み直したなど）。入力欄は / の候補を開くたびに
        // 読みに来る（commandsOf）ので、差し替えておけば次に開いたときから新しくなる。引き継ぎで戻せるよう記録も直す
        // （前のアプリの頃の行も。initialize の返事は記録から戻すので、引き継いだときはこちらが先に記録を直す）
        const commands = (message as CommandsChangedMessage).commands;
        if (rt.init) rt.init = { ...rt.init, commands };
        const saved = this.store.get(id)?.claudeInit;
        if (saved) this.store.update(id, { claudeInit: { ...saved, commands } });
        return;
      }
    }
  }

  // 圧縮の始まり（compacting。要約を待つ間は 30 秒ごとに出直す）と終わり（null）。圧縮の間は、作業中の表示を
  // 「会話を圧縮しています」にする。失敗（compact_result が failed）は、理由をチャットに出す（会話ログには残らない。手動の /compact の
  // 失敗は、会話ログではローカルのコマンドの標準エラーになり、チャットには出していない）。成功は、会話ログの区切り（compact_boundary）で出る。
  // 自動の最適化圧縮がオンのセッションでは、Claude Code の自動の圧縮をアプリの圧縮の前のフックが止める。Claude Code はフックより先に
  // compacting を出すので、止める自動の圧縮（compact_output_chars が付く）は圧縮中にせず、止めたことの失敗も出さない
  private compactStatus(id: string, rt: Runtime, status: StatusMessage): void {
    if (status.status === 'compacting') {
      if (status.compact_output_chars !== undefined && this.compactBlocked(id)) return;
      if (rt.progress?.compacting(true)) this.emitProgress(id, rt);
      return;
    }
    // requesting（応答を頼んだ）は、圧縮の終わりではない
    if (status.status) return;
    if (rt.progress?.compacting(false)) this.emitProgress(id, rt);
    if (status.compact_result !== 'failed') return;
    const reason = status.compact_error?.trim();
    if (reason && blockedByPreCompact(reason)) return;
    const text = reason ? t('chat.transcript.compactFailed', { message: reason }) : t('chat.transcript.compactFailedNoDetail');
    const event: ChatEvent = { type: 'api-error', id: status.uuid, text, retrying: false };
    // 手動の /compact の発言の行は、圧縮が終わってから会話ログに書かれる（失敗の知らせの方が先に届く。2.1.302 で実測）。
    // 今のターンの送った発言がまだ会話に出ていなければ、発言のときのフックと同じく、その行のあとまで待たせる（closeTurn も待つ）
    const prompt = rt.turnOpen ? rt.promptLine : null;
    if (prompt) rt.heldHooks.set(prompt, [...(rt.heldHooks.get(prompt) ?? []), event]);
    else this.pushEvents(id, [event]);
  }

  // stream に出た応答（uuids）が取り消された。書いている途中の文から外し、ターンの最後の行にしない（会話ログに出るのを待たない）
  private retractStreamed(id: string, rt: Runtime, uuids: string[]): void {
    if (rt.lastTurnLine && uuids.includes(rt.lastTurnLine)) rt.lastTurnLine = null;
    const messageIds = uuids.flatMap((uuid) => rt.streamMessages.get(uuid) ?? []);
    if (rt.partial.drop(messageIds)) this.emitPartial(id, rt);
  }

  private handleAssistant(id: string, rt: Runtime, message: AssistantMessage, past: boolean): void {
    // ツールの前後のフック（hook_response）を付けるカードを探すため、ツールの呼び出しを控える（サブエージェントの中のものも、印を付けて）
    if (!past) {
      for (const block of message.message.content ?? []) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          rt.streamTools.push({ id: block.id, name: block.name, sub: !!message.parent_tool_use_id });
        }
      }
      if (rt.streamTools.length > MAX_STREAM_TOOLS) rt.streamTools.splice(0, rt.streamTools.length - MAX_STREAM_TOOLS);
    }
    // サブエージェントの行は、モデル・コンテキスト・進み具合に使わない
    if (message.parent_tool_use_id) return;
    this.openTurn(id, rt, past);
    rt.lastTurnLine = message.uuid;
    if (!past && message.message.id) {
      rt.streamMessages.set(message.uuid, message.message.id);
      if (rt.streamMessages.size > MAX_STREAM_MESSAGES) rt.streamMessages.delete(rt.streamMessages.keys().next().value!);
    }
    for (const block of message.message.content ?? []) {
      if (block.type === 'tool_use' && block.name === PLAN_TOOL && typeof block.id === 'string') {
        const plan = (block.input as { plan?: unknown } | undefined)?.plan;
        if (typeof plan === 'string') {
          rt.planInputs.set(block.id, plan);
          this.refreshPlans(id, rt);
        }
      }
    }
    const usage = message.message.usage;
    const tokens = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : 0;
    const size = rt.statusLine?.context?.size ?? rt.contextSize;
    if (tokens > 0) rt.freshConversation = false;
    this.updateStatus(id, rt, {
      ...(message.message.model && message.message.model !== '<synthetic>' ? { model: message.message.model } : {}),
      ...(tokens > 0 && size ? { context: { size, tokens, usedPercent: Math.round((tokens / size) * 100) } } : {}),
    });
  }

  // 送った発言の受け付けの知らせ。queued: 順番待ちに入った / started: ターンに取り込まれた / completed・cancelled・discarded: 終わった
  private handleLifecycle(id: string, rt: Runtime, message: CommandLifecycleMessage, past: boolean): void {
    if (message.state === 'started') {
      this.openTurn(id, rt, past);
      rt.turnPrompt = message.command_uuid;
      if (!past) rt.promptLine = message.command_uuid;
    }
    const unsent = rt.unsent.get(message.command_uuid);
    if (!unsent) return;
    if (message.state === 'queued' && unsent.state === 'sending') {
      unsent.state = 'queued';
      this.emitQueue(id, rt);
    } else if (message.state === 'cancelled' || message.state === 'discarded' || message.state === 'completed') {
      rt.unsent.delete(message.command_uuid);
      this.emitQueue(id, rt);
    }
    this.changed(id);
  }

  // ターンが始まった。前のターンの終わりをまだ出していなければ、先に出す（ターンを開いてから出す。終わりの知らせの間に、
  // 手が空いたように見せない）
  private openTurn(id: string, rt: Runtime, past: boolean): void {
    if (rt.turnOpen) return;
    rt.turnOpen = true;
    if (rt.turnEnding) this.flushTurnEnd(id, rt);
    rt.lateTurnEnd = null;
    rt.lastTurnLine = null;
    rt.turnPrompt = null;
    rt.starterSeen = false;
    if (!past) this.startProgress(id, rt);
    this.emitSessions();
    this.changed(id);
  }

  // ターンが終わった（result）。チャットへのターンの終わりは、そのターンの最後の応答が会話ログに出てから出す（時間切れ付き）
  private closeTurn(id: string, rt: Runtime, result: ResultMessage, past: boolean): void {
    const open = rt.turnOpen;
    rt.turnOpen = false;
    this.stopProgress(id, rt);
    // 開いていないターンの result（重ねて届いた知らせなど）では、ターンの終わりも完了の知らせも出さない
    if (past || !open) return;
    // 発言の行を待たせていたフックは、ターンの終わりの前に出す（flushTurnEnd）。次のターンまで鍵を残さない
    rt.promptLine = null;
    // result の時点で、本体のツールの呼び出しはどれも結果が出ている。stream に結果が来なかったもの（中断など）も、フックの付け先の候補から外す
    // （サブエージェントの中のものは、裏で続くことがあるので残す）
    rt.streamTools = rt.streamTools.filter((t) => t.sub);
    if (rt.turnEnding) this.flushTurnEnd(id, rt);
    const interrupted = typeof result.terminal_reason === 'string' && result.terminal_reason.startsWith('aborted');
    // 会話ログに残らない失敗（ターン数・予算の上限、Claude Code の中の失敗など）は、理由をチャットに出す（中断は除く）。
    // ターンの終わりの直前に出す（応答の前に終わったターンでは、始めた発言より前に並べない。最適化圧縮は、仕上げの頼みのあとの失敗を見る）
    const error: ChatEvent | null =
      result.is_error && result.subtype !== 'success' && !interrupted && result.errors?.length
        ? { type: 'api-error', id: result.uuid, text: result.errors.join('\n'), retrying: false }
        : null;
    // /clear・/compact のような Claude Code の中で済むコマンドは、モデルを呼ばずに result を返す（num_turns が 0。実測）。
    // TUI では、これらにターンの終わりが無かった。作業の完了として知らせない（最適化圧縮の /clear で「作業が完了しました」が鳴らない）
    const local = result.num_turns === 0 && result.subtype === 'success';
    // 応答の前に終わったターン（中断・失敗）は、result が会話ログの発言の行より先に届くことがある。先に終わりを出すと、チャットで
    // 発言より前に並ぶ（最適化圧縮は、仕上げの頼みのあとの終わりを待ち続ける）ので、その発言が会話ログに出るのを待つ。
    // モデルを呼ばなかったターンは待たない（/clear の発言の行は新しい会話ログに出ないことがあり、フックが止めた発言は会話に出ない）。
    // ただし、/compact の失敗の知らせを、その発言の行のあとに出すために待たせていれば待つ（/compact の発言の行は、圧縮のあとに必ず書かれる）
    const compactFailed = !!rt.turnPrompt && !!rt.heldHooks.get(rt.turnPrompt)?.some((e) => e.type === 'api-error');
    const prompt = !rt.lastTurnLine && (!local || compactFailed) && rt.turnPrompt && !rt.arrivedPrompts.has(rt.turnPrompt) ? rt.turnPrompt : null;
    const waitFor = rt.lastTurnLine && !rt.chain.some((c) => c.uuid === rt.lastTurnLine) ? rt.lastTurnLine : prompt;
    rt.turnEnding = { interrupted, local, waitFor, error, timer: setTimeout(() => this.turnEndTimedOut(id, rt), this.turnEndWaitMs) };
    if (result.total_cost_usd !== undefined) this.updateStatus(id, rt, { costUsd: result.total_cost_usd });
    if (!waitFor) this.flushTurnEnd(id, rt);
    this.emitSessions();
    this.changed(id);
    void this.refreshContext(id, rt);
    void this.refreshUsage(rt);
  }

  // プランの利用枠を get_usage で聞く（モデル別の週の枠は、rate_limit_event・statusLine に無いため）。サーバーに聞くので、
  // プロファイル（この SessionManager）ごとに USAGE_INTERVAL_MS に 1 回まで。API キーなどで使えなければ何もしない。
  // skip_behaviors: 返事の behaviors（使い方の傾向）は使わない。渡さないと、Claude Code が手元の会話ログ（24 時間・7 日分）を
  // 毎回読んで集計する（2.1.302）
  private async refreshUsage(rt: Runtime): Promise<void> {
    const now = Date.now();
    if (now - this.usageAt < USAGE_INTERVAL_MS) return;
    this.usageAt = now;
    const response = await rt.process?.client?.request<UsageResponse>('get_usage', { skip_behaviors: true }).catch(() => null);
    const report = response ? usageLimitsOf(response) : null;
    if (report && report.limits.length > 0) this.listeners.onUsage?.(report, Date.now());
  }

  // ターンの終わりを待つ時間が切れた。待っていた行を待たずに出し、その行があとで会話ログに出たら、そのあとにもう一度出す（lateTurnEnd）。
  // 時間が切れるのは、待つ行があるときだけ（無ければ closeTurn がすぐ出して、時計を止める。出したら turnEnding を外して時計を止める）
  private turnEndTimedOut(id: string, rt: Runtime): void {
    const ending = rt.turnEnding!;
    rt.lateTurnEnd = { waitFor: ending.waitFor!, interrupted: ending.interrupted, error: ending.error };
    this.flushTurnEnd(id, rt);
  }

  // チャットにターンの終わりを出し、完了を知らせる
  private flushTurnEnd(id: string, rt: Runtime): void {
    const ending = rt.turnEnding;
    if (!ending) return;
    clearTimeout(ending.timer);
    rt.turnEnding = null;
    // カードが会話ログに出ないまま残ったフックは、ターンの終わりの前に、そのまま出す
    const held = [...rt.heldHooks.values()].flat();
    rt.heldHooks.clear();
    // 会話ログに出ないまま残った書きかけの文は捨てる（ターンの終わりと一緒に送る）
    rt.partial.clear();
    this.pushEvents(id, [...held, ...(ending.error ? [ending.error] : []), ending.interrupted ? { type: 'turn-end', interrupted: true } : { type: 'turn-end' }]);
    // モデルを呼ばなかったターンは、未読・通知・タイトルの頼みを出さない。最適化圧縮の通知の数え方（turnNotice。流れの途中で
    // 出さなかった通知を覚えている）にも入れない
    if (ending.local) {
      rt.turnStarter = 'other';
      this.emitSessions();
      return;
    }
    this.turnCompleted(id, rt);
    this.requestTitle(id, rt);
  }

  // 何も出力しなかったフックを、チャットに出す（会話ログに残らないため。--include-hook-events の hook_response で分かる）。
  // 何かを出力したフック（アプリのフックは、いつも suppressOutput を書く。hook-output.ts）と失敗したフックは会話ログに残り、Stop は
  // 出力が無くても会話ログの要約（stop_hook_summary）に載るので、ここでは出さない（2.1.302 で実測）。
  // hook_response にはコマンドもツールの呼び出しの ID も無いので、ツールの前後のフックは、stream で見た同じ名前の、結果がまだ来て
  // いない呼び出しに付け、そのカードが会話ログからチャットに出るまで待たせる（stream の方が先に届く。PostToolUse の返事も、
  // そのツールの結果より先に届く。2.1.302 で実測）。同じ名前の呼び出しが並んでいて 1 つに決められないときは、どのカードにも付けず、
  // ツールに付かない行として出す（取り違えて別のカードに付けない）
  private quietHook(id: string, rt: Runtime, message: HookResponseMessage): void {
    const started = rt.hookStarts.get(message.hook_id);
    rt.hookStarts.delete(message.hook_id);
    // stdout・stderr がどちらも文字列であることは、StreamClient が確かめている（違えば、この行は届かない）
    const output = `${message.stdout}${message.stderr}`.trim();
    if (message.hook_event === 'Stop' || message.outcome !== 'success' || output) return;
    const prefix = `${message.hook_event}:`;
    const toolName = TOOL_HOOK_EVENTS.has(message.hook_event) && message.hook_name.startsWith(prefix) ? message.hook_name.slice(prefix.length) : null;
    const candidates = toolName ? rt.streamTools.filter((t) => t.name === toolName) : [];
    // サブエージェントの中のツールには、チャットにカードが無い
    if (candidates.length > 0 && candidates.every((t) => t.sub)) return;
    const tool = candidates.length === 1 ? candidates[0] : undefined;
    // 1 つに決められないときも、カードより上に出さないよう、本体の最後の呼び出しのカードが出るまで待たせ、そのあとに出す（どのカードにも付けない）
    const anchor = tool ?? [...candidates].reverse().find((t) => !t.sub);
    const run: HookRun = {
      event: message.hook_event,
      name: message.hook_name,
      command: null,
      outcome: 'success',
      exitCode: typeof message.exit_code === 'number' ? message.exit_code : null,
      durationMs: started === undefined ? null : Date.now() - started,
      stdout: '',
      stderr: '',
      message: '',
      toolUseId: tool?.id ?? null,
      hookId: message.hook_id,
    };
    const event: ChatEvent = { type: 'hook', id: `hook:${message.hook_id}`, run };
    // 発言のときのフックは、その発言の行が会話ログからチャットに出るまで待たせる（発言を会話ログに書く前に動くので、すぐ出すと、
    // 発言の上の、前のターンの続きに見える。2.1.302 で実測）。待つのは、開いているターンに取り込まれ、まだ会話に出ていない送った発言
    // （promptLine）。分からないもの（スマホからの発言など）はすぐ出す。発言が会話に出ないまま終わったら（フックが止めたなど）、
    // ターンの終わりの前に出す（flushTurnEnd）
    const prompt = message.hook_event === 'UserPromptSubmit' && rt.turnOpen ? rt.promptLine : null;
    const holdFor = anchor && !rt.shownTools.has(anchor.id) ? anchor.id : prompt;
    if (holdFor) {
      rt.heldHooks.set(holdFor, [...(rt.heldHooks.get(holdFor) ?? []), event]);
      return;
    }
    this.pushEvents(id, [event]);
  }

  // stream でツールの結果が来た。その呼び出しを、フックを付ける先の候補（streamTools）から外す
  private toolsFinished(rt: Runtime, user: UserMessage): void {
    const content = user.message.content;
    if (!Array.isArray(content)) return;
    const done = new Set(content.flatMap((block) => (block.type === 'tool_result' && typeof block.tool_use_id === 'string' ? [block.tool_use_id] : [])));
    if (done.size > 0) rt.streamTools = rt.streamTools.filter((t) => !done.has(t.id));
  }

  // 会話ログからツールのカードをチャットに出した。そのツールに付けるために待たせていたフックを返す
  private shownTool(rt: Runtime, toolUseId: string): ChatEvent[] {
    rt.shownTools.add(toolUseId);
    if (rt.shownTools.size > MAX_SHOWN_TOOLS) rt.shownTools.delete(rt.shownTools.values().next().value!);
    return this.takeHeld(rt, toolUseId);
  }

  // 待たせていたフック（ツールの呼び出しの ID・送った発言の uuid のもの）を取り出す
  private takeHeld(rt: Runtime, key: string): ChatEvent[] {
    const held = rt.heldHooks.get(key) ?? [];
    rt.heldHooks.delete(key);
    return held;
  }

  // ターンが終わったときの未読と通知
  private turnCompleted(id: string, rt: Runtime): void {
    if (!this.isFocused(id)) rt.unread = true;
    const summary = this.summary(id);
    // 通知を出さないとき（下の、バックグラウンドのタスクが動いているあいだなど）も聞く。流れの途中で出さなかったことを、覚えさせる
    const notice = this.turnNotice(id, rt.turnStarter);
    rt.turnStarter = 'other';
    // バックグラウンドのタスクが動いているあいだは、まだ完了ではない（一覧も「完了待ち」）。
    // タスクが終わると Claude Code が続きを始めるので、通知はそのターンの終わりに出す。
    // ブラウザでの操作を頼んでいるあいだも同じ（ターミナルモードの TUI では、2 分を過ぎると Claude Code が呼び出しをバックグラウンドに移し、
    // Claude はターンを終えて返事を待つ。チャット（-p）では移さず、人が答えるまでターンの中で待つ。実測）。
    // ただし Claude が報告を預けていれば、タスクが動いていても出す（タスクを残したまま、作業を終えたと報告している）
    if (notice && summary && summary.attention !== 'browser' && (summary.backgroundTasks === 0 || this.turnReported(id))) this.listeners.onTurnCompleted(summary, notice);
    this.emitSessions();
  }

  // 会話のタイトルを作らせる（-p は自動では作らないため。実測）。会話ログにまだタイトル（ai-title・custom-title）が無く、人が名前を
  // 付けていないセッションで、この起動の最初のターンが終わったあとに 1 回だけ。失敗は黙って捨てる（一覧は最初の発言のまま）。
  // 会話ログを読み終える前（あとの行にタイトルがあるかもしれない）と、まだ最初の発言が無いときは、次のターンの終わりに見直す
  private requestTitle(id: string, rt: Runtime): void {
    const record = this.store.get(id);
    const client = rt.process?.client;
    if (rt.titleRequested || !record || !client || !rt.historyLoaded) return;
    if (record.titlePriority > FIRST_PROMPT_TITLE_PRIORITY) {
      rt.titleRequested = true;
      return;
    }
    if (!record.title) return;
    rt.titleRequested = true;
    void generateTitle(client, record.title).catch(() => null);
  }

  // ターンの終わりに、コンテキストの使用量を聞き直す。/clear のあと、新しい会話の最初の応答までは聞かない（freshConversation）
  private async refreshContext(id: string, rt: Runtime): Promise<void> {
    if (rt.freshConversation) return;
    const process = rt.process;
    const usage = await process?.client?.request<ContextUsageResponse>('get_context_usage').catch(() => null);
    if (!usage || rt.process !== process || typeof usage.maxTokens !== 'number' || rt.freshConversation) return;
    rt.contextSize = usage.maxTokens;
    this.updateStatus(id, rt, { context: { size: usage.maxTokens, tokens: usage.totalTokens, usedPercent: usage.percentage } });
  }

  // モデル・エフォート・コンテキスト・利用枠を変えて、画面に知らせる（ターミナルモードの間の statusLine と同じ形）
  private updateStatus(
    id: string,
    rt: Runtime,
    patch: { model?: string; effort?: string | null; version?: string; context?: StatusLineInfo['context']; rateLimits?: StatusLineInfo['rateLimits']; costUsd?: number },
  ): void {
    const before = rt.statusLine;
    const record = this.store.get(id);
    const modelId = patch.model ?? before?.model?.id ?? null;
    const now = Date.now();
    const next: StatusLineInfo = {
      model: modelId ? { id: modelId, name: modelName(modelId) ?? initModelName(rt.init, modelId) ?? modelId } : null,
      // 実際に使っているエフォート（get_settings の applied・init）。まだ知らせが無ければ、アプリで選んだもの
      effort: patch.effort !== undefined ? patch.effort : before ? before.effort : (record?.effort ?? null),
      version: patch.version ?? before?.version ?? null,
      // null は、分からなくなった（/clear のあと）
      context: patch.context !== undefined ? patch.context : (before?.context ?? null),
      // 値が無いときに空で上書きしない。送り直す前の値には、受け取った時刻を添えたままにする（あとで get_usage で聞いた新しい値を、
      // 古い値で戻さない）
      rateLimits: patch.rateLimits ?? before?.rateLimits ?? null,
      rateLimitsAt: patch.rateLimits ? now : before?.rateLimitsAt,
      costUsd: patch.costUsd ?? before?.costUsd ?? null,
      transcriptPath: null,
      updatedAt: now,
    };
    rt.statusLine = next;
    this.listeners.onStatusLine(id, next);
  }

  // 分かっている権限モードを変える（Claude Code が知らせたモード）。writtenAt: 会話ログの行のモードなら、その行が書かれた時刻。
  // 会話ログは stream より遅れて読むことがある（新しい会話の会話ログは最初の発言でできるので、追い始めるのが遅れる）ため、
  // stream などで知ったモードを、それより前に書かれた行のモードでは戻さない（プランの承認で acceptEdits になったのを、
  // 承認より前の発言の行の plan で戻していた）。stream・フック・set_permission_mode の返事は、受け取った今のモード
  private noteMode(id: string, rt: Runtime, mode: PermissionMode | null, writtenAt?: number): void {
    if (!mode || (writtenAt !== undefined && writtenAt < rt.modeAt)) return;
    rt.modeAt = Math.max(rt.modeAt, writtenAt ?? Date.now());
    if (mode === rt.knownMode) return;
    rt.knownMode = mode;
    this.store.update(id, { knownMode: mode });
    this.emitSessions();
  }

  private startProgress(id: string, rt: Runtime): void {
    this.stopProgress(id, rt);
    rt.progress = new Progress(Date.now());
    rt.progressTimer = setInterval(() => this.emitProgress(id, rt), PROGRESS_TICK_MS);
    rt.progressTimer.unref?.();
    this.emitProgress(id, rt);
  }

  private stopProgress(id: string, rt: Runtime): void {
    if (rt.progressTimer) clearInterval(rt.progressTimer);
    rt.progressTimer = null;
    if (!rt.progress) return;
    rt.progress = null;
    this.listeners.onProgress(id, null);
  }

  private emitProgress(id: string, rt: Runtime): void {
    if (rt.progress) this.listeners.onProgress(id, rt.progress.current(Date.now()));
  }

  // 送ったが、まだ会話に出ていない発言を、チャットに知らせる
  private emitQueue(id: string, rt: Runtime): void {
    const prompts = [...rt.unsent.values()].filter((prompt) => prompt.shown).map(({ at: _, shown: __, ...prompt }) => prompt);
    this.pushEvents(id, [{ type: 'queue', prompts }]);
  }

  // MCP サーバーの質問（elicitation）が来た。カードで答える。replayed: 引き継いだときに出し直した要求（もう一度は通知しない）
  private elicitationAdded(id: string, rt: Runtime, requestId: string, request: ElicitationRequest, replayed = false): void {
    rt.elicitations.set(requestId, { pending: elicitationOf(requestId, request), request });
    this.updateAttention(id, rt, replayed);
  }

  // URL の形の MCP サーバーの質問を、MCP サーバーが終わったと知らせた。完了を待っているカードを閉じる
  private elicitationCompleted(id: string, rt: Runtime, message: ElicitationCompleteMessage): void {
    for (const [key, opened] of rt.openedUrls) {
      if (opened.request.mcp_server_name !== message.mcp_server_name || opened.request.elicitation_id !== message.elicitation_id) continue;
      rt.openedUrls.delete(key);
      this.updateAttention(id, rt);
      return;
    }
  }

  // Claude Code が答えを待つ要求が来た（許可の確認・質問・プランの承認・ワークフローの確認）。
  // 質問（AskUserQuestion）は、質問のカード・親の answer_question の返事を PendingQuestions で待ち、Claude Code に返す
  // replayed: 引き継いだときに出し直した要求（前のアプリが通知したので、もう一度は通知しない）
  private requestAdded(id: string, rt: Runtime, requestId: string, request: CanUseToolRequest, replayed = false): void {
    rt.quietAttention = replayed;
    try {
      this.addRequest(id, rt, requestId, request, replayed);
    } finally {
      rt.quietAttention = false;
    }
  }

  private addRequest(id: string, rt: Runtime, requestId: string, request: CanUseToolRequest, replayed: boolean): void {
    const questions = request.tool_name === 'AskUserQuestion' ? askQuestionsOf(request.input) : null;
    if (request.tool_name === 'AskUserQuestion' && !questions) {
      // 読めない質問は、カードにも親にも出せない（許可の確認として出さない）。断って、Claude に知らせる
      rt.process?.client?.respond(requestId, { behavior: 'deny', message: 'tanacode could not read the questions in this AskUserQuestion call, so it was not shown to the user. Ask again with valid questions.' });
      return;
    }
    rt.requests.set(requestId, request);
    // プランの本文は、プランのファイルから読む（TUI と同じ）。無ければ、Claude が ExitPlanMode に渡した本文。読めなければ、あとで読み直す
    if (request.tool_name === PLAN_TOOL) {
      const plan = this.planOf(id, rt, request);
      if (plan !== null) rt.plans.set(requestId, plan);
    }
    if (questions) {
      const process = rt.process;
      const wait = new AbortController();
      rt.questionWaits.set(requestId, wait);
      void this.questions.wait(id, questions, wait.signal).then((reply) => {
        rt.questionWaits.delete(requestId);
        // 待つのをやめた（取り下げられた・終わった・人がほかで答えた）ときは、何も返さない
        if (!reply || rt.process !== process) return;
        if (process?.client?.respond(requestId, questionResult(request.input, questions, reply))) this.requestRemoved(id, rt, requestId);
      });
    }
    this.updateAttention(id, rt, replayed);
  }

  // プランの承認の本文。プランのファイル（読んでよい場所の、通常のファイルだけ）か、Claude が ExitPlanMode に渡した本文。無ければ null
  private planOf(id: string, rt: Runtime, request: CanUseToolRequest): string | null {
    const record = this.store.get(id);
    const roots = [join(claudeConfigDir(this.claudeDir), 'plans'), ...(record && rt.plansDirectory ? [resolve(record.cwd, rt.plansDirectory)] : [])];
    return readPlanFile(rt.planFile, roots) ?? rt.planInputs.get(request.tool_use_id) ?? null;
  }

  // プランのファイル・Claude の入力が分かった。本文を読めていなかったプランの承認があれば、読み直して画面に出し直す
  private refreshPlans(id: string, rt: Runtime): void {
    let found = false;
    for (const [requestId, request] of rt.requests) {
      if (request.tool_name !== PLAN_TOOL || rt.plans.has(requestId)) continue;
      const plan = this.planOf(id, rt, request);
      if (plan === null) continue;
      rt.plans.set(requestId, plan);
      found = true;
    }
    if (found) this.listeners.onPermission?.(id, this.pendingPermission(id));
  }

  // 設定のプランのフォルダ（get_settings の effective.plansDirectory）
  private notePlansDirectory(id: string, rt: Runtime, settings: SettingsResponse | null): void {
    const dir = settings?.effective?.plansDirectory;
    rt.plansDirectory = typeof dir === 'string' && dir.trim() ? dir : null;
    this.refreshPlans(id, rt);
  }

  // 待っていた要求が無くなった（答えた・Claude Code が取り下げた）
  private requestRemoved(id: string, rt: Runtime, requestId: string): void {
    if (rt.elicitations.delete(requestId)) {
      this.updateAttention(id, rt);
      return;
    }
    if (!rt.requests.delete(requestId)) return;
    rt.plans.delete(requestId);
    rt.questionWaits.get(requestId)?.abort();
    rt.questionWaits.delete(requestId);
    this.updateAttention(id, rt);
  }

  // 待っている要求をすべて捨てる（Claude Code が終わった・アーカイブした）
  private releaseRequests(id: string, rt: Runtime): void {
    if (rt.requests.size === 0 && rt.elicitations.size === 0 && rt.openedUrls.size === 0) return;
    rt.requests.clear();
    // 終わった claude の質問には答えられず、完了の知らせも届かない
    rt.elicitations.clear();
    rt.openedUrls.clear();
    rt.plans.clear();
    for (const wait of rt.questionWaits.values()) wait.abort();
    rt.questionWaits.clear();
    this.updateAttention(id, rt);
  }

  // 操作待ちの種類を、待っている要求と、フックが答えを待っている質問から決める。操作待ちでなかったところから変わったら、通知する
  // quiet: 通知しない（引き継いだときに出し直した要求）
  private updateAttention(id: string, rt: Runtime, quiet = false): void {
    this.listeners.onPermission?.(id, this.pendingPermission(id));
    this.listeners.onElicitation?.(id, this.pendingElicitation(id));
    const request = rt.terminal ? undefined : firstRequest(rt);
    const pending = rt.terminal ? null : this.questions.first(id);
    // 完了を待っている URL の形の質問は、Claude Code が答えを待っていないので、操作待ちにしない
    const elicitation = rt.terminal ? undefined : rt.elicitations.values().next().value?.pending;
    const attention: SessionAttention = rt.terminal
      ? (rt.tuiAsk?.kind ?? null)
      : request
        ? request.tool_name === 'AskUserQuestion'
          ? 'question'
          : 'permission'
        : pending || elicitation
          ? 'question'
          : null;
    if (attention === rt.attention) {
      this.emitSessions();
      this.changed(id);
      return;
    }
    const before = rt.attention;
    rt.attention = attention;
    this.emitSessions();
    this.changed(id);
    const summary = this.summary(id);
    if (!summary || !rt.process || before !== null || attention === null || quiet || rt.quietAttention) return;
    if (rt.terminal && rt.tuiAsk) this.listeners.onAttention(summary, { kind: 'menu', menu: rt.tuiAsk.menu });
    else if (request) this.listeners.onAttention(summary, { kind: 'menu', menu: requestMenu(request) });
    else if (pending) this.listeners.onAttention(summary, { kind: 'menu', menu: pendingMenu(pending) });
    else if (elicitation) this.listeners.onAttention(summary, { kind: 'menu', menu: elicitationMenu(elicitation) });
  }

  // フックが答えを待っている質問が増えた・減った・親が 1 問答えた
  private questionsChanged(id: string): void {
    this.listeners.onQuestion?.(id, this.questions.first(id));
    const rt = this.runtimes.get(id);
    if (rt) this.updateAttention(id, rt);
    else {
      this.emitSessions();
      this.changed(id);
    }
  }

  // 巻き戻しで会話が枝分かれしたら、親より後に表示していたものを捨てて、親の時点の表示に戻す
  private followBranch(id: string, rt: Runtime, entry: TranscriptEntry, isHistory: boolean): void {
    if (!entry.uuid || entry.isSidechain) return;
    const cut = branchCut(rt.chain, entry);
    if (cut) {
      const kept = rt.events.slice(0, cut.eventCut);
      rt.chain = rt.chain.slice(0, cut.chainCut);
      rt.events = kept;
      // replace は events に残さない（kept がそのまま置き換え後の状態）。通し番号だけ進める
      const fromSeq = rt.seq;
      rt.seq += 1;
      this.listeners.onChat({ sessionId: id, fromSeq, events: [{ type: 'replace', events: kept }], live: !isHistory });
    }
    rt.chain.push({ uuid: entry.uuid, type: entry.type, eventStart: rt.events.length });
  }

  // モデルが断って取り消された応答（model_refusal_fallback の retractedMessageUuids）が、もうチャットに出ていたら外す。
  // 2.1.302 は取り消した応答を会話ログに書かない（実測）が、書かれていても、会話ログから作り直したチャット（chat-log.ts）と同じにする
  private followRetraction(id: string, rt: Runtime, entry: TranscriptEntry, isHistory: boolean): void {
    this.retractEntries(id, rt, retractedUuidsOf(entry), isHistory);
  }

  // 会話ログの行（uuids）から作ったイベントを、チャットから外す（取り消された応答。会話ログからいったん書かれて消された行にも使える）
  private retractEntries(id: string, rt: Runtime, uuids: string[], isHistory: boolean): void {
    const retracted = retract(rt.chain, rt.events, uuids);
    if (!retracted) return;
    rt.chain = retracted.chain;
    rt.events = retracted.events;
    // 巻き戻しと同じく、残ったものに置き換える（replace は events に残さず、通し番号だけ進める）
    const fromSeq = rt.seq;
    rt.seq += 1;
    this.listeners.onChat({ sessionId: id, fromSeq, events: [{ type: 'replace', events: [...retracted.events] }], live: !isHistory });
  }

  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある）
  private sessionDir(id: string): string {
    const record = this.store.get(id)!;
    return join(dirname(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir)), record.claudeSessionId);
  }

  // バックグラウンドタスクの数が変わったら、一覧の表示を更新する
  private countBackground(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const count =
      rt.subagents.all().filter((r) => r.background && r.state === 'running').length +
      rt.workflows.all().filter((r) => r.status === 'running').length +
      rt.bashTasks.all().filter((t) => t.state === 'running').length;
    if (count === rt.background) return;
    rt.background = count;
    this.emitSessions();
    this.changed(id);
  }

  private handleEntry(id: string, entry: unknown, isHistory: boolean): void {
    if (!isTranscriptEntry(entry)) return;
    const record = this.store.get(id);
    if (!record) return;

    let changed = false;
    const title = transcriptTitle(entry);
    // 優先度が高いものは常に採用。同じ優先度なら custom / ai タイトルは最新を、最初の発言は最初のものを使う
    const replaces =
      title &&
      title.title !== record.title &&
      (title.priority > record.titlePriority || (title.priority === record.titlePriority && title.priority > 1));
    if (title && replaces) {
      this.store.update(id, { title: title.title, titlePriority: title.priority });
      changed = true;
    }

    const rt = this.runtimes.get(id);
    // 引き継いだ claude が起動してから書いた行は、読み直した履歴でも今動いているもの（バックグラウンドのタスクや質問を追う）
    const past = isHistory && !(rt?.aliveSince && entryTime(entry) >= rt.aliveSince);
    rt?.tasks.track(entry, past);
    const planFile = entry.attachment?.planFilePath;
    if (rt && typeof planFile === 'string' && planFile && planFile !== rt.planFile) {
      rt.planFile = planFile;
      this.refreshPlans(id, rt);
    }
    // 時刻の無い行（TUI の permission-mode の行）は、読んだ今のモードとして扱う
    if (rt && !past) this.noteMode(id, rt, permissionModeOf(entry), entryTime(entry) || undefined);
    rt?.knowledge.handle(entry);
    rt?.context.handle(entry);

    if (rt) this.followBranch(id, rt, entry, isHistory);
    if (rt) this.followRetraction(id, rt, entry, isHistory);
    // 書いている途中の文のうち、この行で会話ログに出たブロックを外す（この行のイベントと同じ配信で送り、同じ場所で入れ替える）
    const covered = !!rt && !past && !rt.terminal && rt.partial.cover(entry);
    // Remote Control の URL は起動ごとに変わる。前に起動した claude の URL（読み直した過去の行）は出さない
    let events = toChatEvents(entry, record.cwd, false, rememberImage).filter((e) => !(past && e.type === 'remote-control'));
    // 今の claude のターンの終わりは、stream-json の result で決める（-p は turn_duration を書かない。ほかの行の終わりと二重にしない）。
    // ターミナルモード（TUI）では result が来ないので、会話ログのターンの終わりを使う
    if (rt && !isHistory && !rt.terminal) events = events.filter((e) => e.type !== 'turn-end');
    if (rt?.terminal && !past) this.tuiEntry(id, rt, entry, events, isHistory);
    if (rt && isHistory) {
      const bridge = bridgeUrlOf(entry);
      if (bridge !== undefined) rt.lastBridgeUrl = bridge;
    }
    // ターミナルモードの TUI（--remote-control）がつないだ Remote Control のセッションも、付け直せるように覚える
    if (rt && entry.type === 'bridge-session' && typeof (entry as { bridgeSessionId?: unknown }).bridgeSessionId === 'string') {
      this.noteBridgeSession(id, rt, (entry as { bridgeSessionId: string }).bridgeSessionId);
    }
    if (rt && !past) {
      const remote = [...events].reverse().find((e) => e.type === 'remote-control');
      if (remote) rt.remoteConnected = remote.url !== null;
      if (remote && rt.terminal) rt.tuiRemoteSeen = true;
      const starter = events.find((e) => e.type === 'user' || e.type === 'notice' || e.type === 'turn-start');
      if (starter) {
        // ターンを始めたもの。人の発言と、最適化圧縮の文（仕上げの頼み・再開の文）は、いつもターンの始まり。
        // ほかの知らせは、開いているターンの途中に届くことがあるので、まだ決めていないときだけ見る
        const compact = starter.type === 'notice' && !!starter.compact;
        if (!rt.starterSeen || starter.type === 'user' || compact) rt.turnStarter = turnStarterOf(starter);
        rt.starterSeen = true;
      }
    }
    // 送った発言の行（作業中に送ったものは queued_command の attachment）。その uuid
    const arrived = rt && !past ? sentUuidOf(entry) : null;
    // ツールのカードを出したら、待たせていたフック（quietHook）を、そのすぐあとに付ける
    if (rt) events = events.flatMap((e) => (e.type === 'tool-use' ? [e, ...this.shownTool(rt, e.id)] : [e]));
    // 発言のときのフックは、その発言の行（送った uuid。作業中に送ったものは attachment）のあとに付ける。違う形で出たとき（uuid の違う
    // 本体の発言の行）もそのあとに、発言の行より先に応答・ツールの行が出たらその前に付ける（応答の全部のあとまで待たせない）
    const promptLine = rt && !past ? rt.promptLine : null;
    if (rt && promptLine) {
      if (arrived === promptLine || events.some((e) => e.type === 'user')) {
        events = [...events, ...this.takeHeld(rt, promptLine)];
        rt.promptLine = null;
      } else if (events.some((e) => e.type === 'assistant-text' || e.type === 'tool-use' || e.type === 'thinking')) {
        events = [...this.takeHeld(rt, promptLine), ...events];
        rt.promptLine = null;
      }
    }
    if (events.length === 0 && covered) this.emitPartial(id, rt!);
    if (events.length > 0) {
      const active = !isHistory && events.some((e) => e.type === 'user' || e.type === 'assistant-text' || e.type === 'tool-use');
      this.pushEvents(id, events, !isHistory);
      if (active) {
        // 一覧は更新の新しい順。すでに先頭なら並びは変わらないので、行ごとに一覧を送り直さない
        const wasFirst = this.list()[0]?.id === id;
        this.store.update(id, { updatedAt: Date.now() });
        if (!wasFirst) changed = true;
      }
    }
    // 送った発言が会話に出たら、送信中の表示から外す（発言を出してから外す。先に外すと、一瞬どちらにも出ない）
    if (rt && arrived) {
      rt.arrivedPrompts.add(arrived);
      if (rt.arrivedPrompts.size > MAX_ARRIVED_PROMPTS) rt.arrivedPrompts.delete(rt.arrivedPrompts.values().next().value!);
    }
    if (rt && arrived && rt.unsent.delete(arrived)) {
      this.emitQueue(id, rt);
      this.changed(id);
    }
    // ターンの最後の応答（応答の前に終わったターンは、始めた発言）が会話ログに出たら、待っていたターンの終わりを出す
    const waitFor = rt?.turnEnding?.waitFor;
    if (rt && waitFor && (entry.uuid === waitFor || arrived === waitFor)) this.flushTurnEnd(id, rt);
    // 待つ時間が切れて、ターンの終わりのあとに出た行（応答の前に終わったターンの発言など）。そのあとにもう一度ターンの終わりを出す
    // （チャットで、終わりを行より前に残さない。最適化圧縮は、仕上げの頼みのあとの終わりを待つ）。次のターンが始まったら印を捨てるので、
    // 出すのはターンの外だけ。完了の知らせ・タイトルの頼みは、もう済んでいるので繰り返さない
    const late = rt?.lateTurnEnd;
    if (rt && late && (entry.uuid === late.waitFor || arrived === late.waitFor)) {
      rt.lateTurnEnd = null;
      // 失敗の理由も出し直す（同じ id。画面は、前の行を外して今の位置に出す）
      this.pushEvents(id, [...(late.error ? [late.error] : []), late.interrupted ? { type: 'turn-end', interrupted: true } : { type: 'turn-end' }]);
    }
    if (changed) this.emitSessions();
  }

  // チャットのイベントを配信する。書いている途中の文が変わっていれば、同じ配信に載せる（会話ログに出た応答と、その書きかけを、
  // 画面で同じときに入れ替える）
  private pushEvents(id: string, events: ChatEvent[], live = true): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const fromSeq = rt.seq;
    rt.seq += events.length;
    rt.events.push(...events);
    const partial = this.takePartial(rt);
    this.listeners.onChat({ sessionId: id, fromSeq, events, live, ...(partial ? { partial } : {}) });
    this.changed(id);
  }

  // 書いている途中の文を、PARTIAL_INTERVAL_MS に 1 回までまとめて送る
  private schedulePartial(id: string, rt: Runtime): void {
    if (rt.partialTimer) return;
    rt.partialTimer = setTimeout(() => {
      rt.partialTimer = null;
      if (this.runtimes.get(id) === rt) this.emitPartial(id, rt);
    }, PARTIAL_INTERVAL_MS);
    rt.partialTimer.unref?.();
  }

  // 書いている途中の文だけを送る（変わっていれば）。イベントは無いので、通し番号は進めない
  private emitPartial(id: string, rt: Runtime): void {
    const partial = this.takePartial(rt);
    if (partial) this.listeners.onChat({ sessionId: id, fromSeq: rt.seq, events: [], live: true, partial });
  }

  // 前に送ったときから変わっていれば、書いている途中の文の今の全部。送るのを待っている時計は止める（ここで送るため）
  private takePartial(rt: Runtime): PartialBlock[] | null {
    if (rt.partialTimer) clearTimeout(rt.partialTimer);
    rt.partialTimer = null;
    return rt.partial.take();
  }

  private emitSessions(): void {
    const sessions = this.list();
    this.shownStates.clear();
    for (const s of sessions) this.shownStates.set(s.id, s.state);
    this.listeners.onSessionsChanged(sessions);
  }
}

// いちばん前の、Claude Code が答えを待っている要求
function firstRequest(rt: Runtime): CanUseToolRequest | null {
  return rt.requests.values().next().value ?? null;
}

// 会話ログの行が、アプリが送った発言のものなら、その uuid（発言の行・作業中に送った発言の queued_command の attachment）
function sentUuidOf(entry: TranscriptEntry): string | null {
  if (entry.isSidechain) return null;
  if (entry.type === 'user' && entry.uuid) return entry.uuid;
  const source = entry.type === 'attachment' ? entry.attachment?.source_uuid : undefined;
  return typeof source === 'string' ? source : null;
}

// 添えた画像のファイルを、発言の image のブロックにする。送れない（Claude に送れる形式でない・読めない）なら、そのファイルの名前。
// 形式は名前でなく中身の頭で決める（貼り付けた画像の名前は、拡張子が無いこともある）。大きな画像は Claude Code が縮めて送る
// （6.7MB の PNG は 474KB の JPEG に、3024x1964 は 2000x1299 に。実測 2.1.301）ので、アプリでは縮めない
async function imageBlock(path: string): Promise<{ block: ContentBlock } | { skipped: string }> {
  const data = await readFile(path).catch(() => null);
  const mediaType = data ? imageMediaType(data) : null;
  if (!data || !mediaType) return { skipped: basename(path) };
  return { block: { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } } };
}

// 画像の中身の頭から、Claude に送れる形式（PNG・JPEG・GIF・WebP）の media_type を決める。ほかの形式なら null
function imageMediaType(data: Buffer): string | null {
  const head = data.subarray(0, 12).toString('latin1');
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// 形の違う設定ファイルの理由（get_settings の errors の 1 つ）
// 設定ファイルの誤りが、どのファイルのものか
function settingsErrorFile(error: unknown): string | null {
  const file = (error as { file?: unknown } | null)?.file;
  return typeof file === 'string' ? file : null;
}

function describeSettingsError(error: unknown): string {
  const e = error as { file?: unknown; path?: unknown; message?: unknown } | null;
  return [e?.file, e?.path, e?.message].filter((v): v is string => typeof v === 'string' && v !== '').join(': ');
}

// 止められる裏のタスク（動いているもの）か
function taskRunning(rt: Runtime, ref: TaskRef): boolean {
  if (ref.kind === 'bash') return rt.bashTasks.all().some((task) => task.toolUseId === ref.toolUseId && task.state === 'running');
  if (ref.kind === 'workflow') return rt.workflows.all().some((run) => run.toolUseId === ref.toolUseId && run.status === 'running');
  return rt.subagents.all().some((run) => run.toolUseId === ref.toolUseId && run.state === 'running' && run.background);
}

// Remote Control の名前（スマホ・claude.ai の一覧に出る）
function remoteName(cwd: string): string {
  return `tanacode-${basename(cwd)}`;
}

// 選んだモデル（--model に渡したもの。null は既定のモデル）で auto を使えるか（initialize の models の supportsAutoMode。
// 分からなければ使えるものとする）
function autoAvailable(init: InitializeResponse, model: string | null): boolean {
  return modelEntry(init, model ?? 'default')?.supportsAutoMode !== false;
}

// 会話の巻き戻しを断られた理由。主なものは画面の言語の文に、ほかは Claude Code の説明（英語）か識別子のまま
const REWIND_REASONS = new Set(['turn_running', 'commands_queued', 'prompt_pending', 'unseen_later_turn', 'stale_target', 'target_not_found', 'expired', 'usage_limited', 'state_changed', 'persist_failed']);
function rewindReasonText(reason: string | null, error: string | null): string | null {
  if (reason && REWIND_REASONS.has(reason)) return t(`main.rewind.${reason}` as MessageKey);
  return error ?? reason;
}

// initialize の models のうち、その値（別名）か、その別名が指すモデル ID が合うもの
function modelEntry(init: InitializeResponse, model: string): ModelInfo | undefined {
  return init.models.find((m) => m.value === model || m.resolvedModel === model);
}

// そのモデルで選べるエフォート。選べないモデルは空
function effortsOf(model: ModelInfo): string[] {
  return model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []);
}

// 名前を知らないモデルの ID（Bedrock の us.anthropic.… など）の、Claude Code が付けた名前（initialize の models の displayName）
function initModelName(init: InitializeResponse | null, modelId: string): string | null {
  const found = init?.models.find((m) => m.value !== 'default' && (m.resolvedModel === modelId || m.value === modelId));
  return found?.displayName || null;
}

// 起動に時間がかかっているときの進み具合（知らせるまでの時間を過ぎるまでは null）
function slowStartActivity(rt: Runtime, now: number): Activity | null {
  const watch = rt.startWatch;
  if (!watch || now - watch.since < watch.after) return null;
  return { phase: 'starting', elapsed: elapsedText(now - watch.since), tokens: null, ...(watch.stderr.trim() ? { stderr: watch.stderr.trimEnd() } : {}) };
}

// 会話ログの権限モードの名前（Claude Code の名前。manual は default）
const TRANSCRIPT_MODES = new Map<string, PermissionMode>([
  ['default', 'manual'],
  ['acceptEdits', 'acceptEdits'],
  ['plan', 'plan'],
  ['auto', 'auto'],
  ['bypassPermissions', 'bypassPermissions'],
]);

// Claude Code が会話ログに書いた、その時点の権限モード（user 行・permission-mode 行）。書いていなければ null。
// サブエージェントの行（sidechain）は読まない（エージェントの定義で、本体と別のモードで動くことがある）。
// 知らない名前（dontAsk など）は、許す操作の多さが分からないので manual にする
function permissionModeOf(entry: TranscriptEntry): PermissionMode | null {
  if (entry.isSidechain || (entry.type !== 'user' && entry.type !== 'permission-mode')) return null;
  if (typeof entry.permissionMode !== 'string' || !entry.permissionMode) return null;
  return TRANSCRIPT_MODES.get(entry.permissionMode) ?? 'manual';
}

// 小さな文字のファイルを読む（プランのファイル）。無い・読めなければ null
// リンクを解いたパス（無いフォルダはそのまま）
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// プランのファイルを読む。読んでよい場所（roots。プランのフォルダ）の下の、リンクでない通常のファイルで、大きすぎないものだけ。
// 場所は会話ログに書かれたもので、Claude Code 以外が書き換えうるので確かめる。読めない・空なら null
const MAX_PLAN_BYTES = 1024 * 1024;
function readPlanFile(file: string | null, roots: string[]): string | null {
  if (!file || !isAbsolute(file)) return null;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > MAX_PLAN_BYTES) return null;
    const real = realpathSync(file);
    if (!roots.some((root) => real.startsWith(`${realPath(root)}/`))) return null;
    const text = readFileSync(real, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

// 文をつないで 1 つの知らせにする。2 文以上なら、最後にも文の終わりの記号を付ける（日本語は付けない・英語はピリオド）
function sentences(notes: string[]): string {
  const text = notes.join(t('main.format.sentenceSeparator'));
  return notes.length > 1 ? text + t('main.format.sentenceEnd') : text;
}

// node_modules の用意の結果の知らせ（チャットに出す。1 つずつの文）。場所は worktree からの相対（'' はいちばん上）
function nodeModulesNotes(result: NodeModulesResult): string[] {
  const separator = t('main.format.shortListSeparator');
  const where = (dirs: string[]) => dirs.map((dir) => (dir ? `${dir}/node_modules` : 'node_modules')).join(separator);
  const notes: string[] = [];
  if (result.cloned.length > 0) notes.push(t('main.worktree.cloned', { paths: where(result.cloned) }));
  if (result.failed.length > 0) notes.push(t('main.worktree.cloneFailed', { paths: where(result.failed) }));
  const at = (dir: string) => dir || t('main.worktree.topDir');
  const ok = result.installs.filter((i) => i.exitCode === 0);
  const failed = result.installs.filter((i) => i.exitCode !== 0);
  if (ok.length > 0) {
    notes.push(t('main.worktree.installed', { commands: ok.map((i) => t('main.worktree.commandAt', { command: i.command, dir: at(i.dir) })).join(separator) }));
  }
  if (failed.length > 0) {
    const commands = failed.map((i) => t('main.worktree.commandFailedAt', { command: i.command, dir: at(i.dir), code: i.exitCode })).join(separator);
    notes.push(t('main.worktree.installFailed', { commands }));
  }
  return notes;
}

// ターミナルに出さずにコマンドを実行する（RunTask の既定。互換性の確認など）
function runQuietly(_owner: string, cwd: string, command: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd }, (err) => resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 動いている Claude Code の状態の文言（セッション一覧の文言にそろえる）
function stateLabel(rt: Runtime, browserAsk: boolean): string {
  if (rt.attention === 'question') return t('main.state.question');
  if (rt.attention === 'permission') return t('main.state.permission');
  if (browserAsk) return t('main.state.browser');
  if (!rt.ready) return t('main.state.starting');
  const count = rt.background;
  if (rt.turnOpen) return count > 0 ? t('main.state.workingWithBackground', { count }) : t('main.state.working');
  if (count > 0) return t('main.state.waitingBackground', { count });
  return t('main.state.idle');
}

function entryTime(entry: TranscriptEntry): number {
  return entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0;
}

// 発言の行があるか。会話ログは 100MB を超えることもあるので、先頭から少しずつ読み、見つかったらやめる
function hasConversation(file: string): boolean {
  const MARK = '"type":"user"';
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const chunk = Buffer.alloc(256 * 1024);
    let position = 0;
    let tail = '';
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) return false;
      position += bytesRead;
      // 区切りをまたいだ目印も見つけられるよう、前の読みの末尾をつなげる（目印は ASCII なので、文字化けした端は影響しない）
      const text = tail + chunk.subarray(0, bytesRead).toString('latin1');
      if (text.includes(MARK)) return true;
      tail = text.slice(-MARK.length);
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// 待っている要求の通知に使うメニュー（通知の本文は、許可ならツールの説明、質問なら質問文）
// stream の user の行が、ツールの結果か
function isToolResult(user: UserMessage): boolean {
  const content = user.message?.content;
  return Array.isArray(content) && content.some((block) => block.type === 'tool_result');
}

function requestMenu(request: CanUseToolRequest): Menu {
  if (request.tool_name === 'AskUserQuestion') {
    const questions = askQuestionsOf(request.input);
    return { kind: 'question', tabs: [], title: questions?.[0]?.question ?? '', context: [], options: [], multiSelect: false, hint: '' };
  }
  const command = typeof request.input.command === 'string' ? request.input.command : null;
  const detail = [request.description ?? request.title ?? request.display_name ?? request.tool_name, command].filter((v): v is string => !!v);
  return { kind: 'permission', tabs: [], title: tanacodeToolLabel(request.tool_name) ?? request.title ?? request.tool_name, context: detail, options: [], multiSelect: false, hint: '' };
}

// 答えを待っている質問の通知に使うメニュー（通知の本文は質問文）
function pendingMenu(pending: PendingQuestion): Menu {
  return { kind: 'question', tabs: [], title: pending.questions[0]?.question ?? '', context: [], options: [], multiSelect: false, hint: '' };
}

// MCP サーバーの質問の通知に使うメニュー（通知の本文は、どのサーバーからかと質問の文）
function elicitationMenu(pending: PendingElicitation): Menu {
  return { kind: 'question', tabs: [], title: t('main.notification.elicitation', { server: pending.server, message: pending.message }), context: [], options: [], multiSelect: false, hint: '' };
}

// MCP サーバーの質問。pending: カードの形 / request: Claude Code の要求（完了の知らせと結ぶ、サーバーの名前と elicitation_id）
type ElicitationWait = { pending: PendingElicitation; request: ElicitationRequest };
