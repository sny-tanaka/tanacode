import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { bridgeUrlOf, isHumanPrompt, isTranscriptEntry, promptDisplayText, toChatEvents, transcriptTitle, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import { bracketedPaste, promptKeyChunks, stripControlChars } from '@shared/prompt-keys';
import { t } from '@shared/i18n';
import { isCompactMessage, type CarriedTask } from '@shared/optimized-compact';
import { isParentMessageDraft, modeWithin, weakerMode, type PermissionRequest, type SessionState } from '@shared/session-tools';
import type {
  ArchiveOptions,
  ChatBatch,
  ExportSource,
  NewSessionOptions,
  ScreenChoice,
  SessionOptions,
  SessionSnapshot,
  SessionAttention,
  SessionSummary,
  WorktreeLeftovers,
  WorktreePreparing,
  WorktreeRemoval,
} from '@shared/ipc';
import type { Activity, AskQuestion, ChooseResult, Menu, PermissionMode, ScreenInfo } from '@shared/screen';
import type { SubagentRun } from '@shared/subagent';
import type { SessionKnowledge } from '@shared/knowledge';
import type { SessionContext } from '@shared/context';
import type { StatusLineInfo } from '@shared/statusline';
import type { AgentLogRef, BashTask, TaskRef } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import type { PendingQuestion, QuestionReply } from '@shared/questions';
import { BashTaskTracker } from './bash-task-tracker';
import { branchCut, pulledBackPastes, pulledBackPrompt, readAgentLog, readChatLog, readExportLog, type ChainEntry } from './chat-log';
import { ClaudeSession, transcriptPath } from './claude-session';
import { turnStarterOf, type TurnNotice, type TurnStarter } from './compact-notice';
import type { BrowserMcpLaunch } from './browser-bridge';
import { textResult, type McpLaunch, type ToolResult } from './mcp-bridge';
import { PendingQuestions } from './pending-questions';
import type { TerminalMcpLaunch } from './terminal-bridge';
import type { PreparedSettings, SettingsFiles } from './settings-files';
import { KnowledgeTracker } from './knowledge-tracker';
import { ContextTracker, readContext } from './context-tracker';
import type { PtyHostApi } from './pty-host-client';
import type { HostedPtyInfo } from './pty-host-protocol';
import { rememberImage } from './image-cache';
import { askQuestionsOf } from './screen-parser';
import { TaskRouter } from './task-router';
import { ScreenTracker, type StopResult } from './screen-tracker';
import type { StatusLineWatcher } from './statusline';
import { SubagentTracker } from './subagent-tracker';
import { WorkflowTracker } from './workflow-tracker';
import type { SessionRecord, SessionStore } from './session-store';
import type { WorkspaceWatchers } from './workspace-watcher';
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

// 送ってから、打ち込んだ文字が Claude Code の入力欄から消えるまでの目安（その間は、入力欄に残った文字としてチャットに移さない）
const TYPING_MS = 5000;
// 送ってから発言が会話ログに出るまで、作業中として扱う上限（スラッシュコマンドなど、発言として残らないものもある）
const SUBMIT_GRACE_MS = 15_000;
// 打った文字が入力欄に出るのを待つ上限と、画面を見直す間隔（submit の untilTyped）。TYPED_MS は TYPING_MS より短くする
const TYPED_MS = 3000;
const TYPED_POLL_MS = 20;

// Claude Code の画面を見ていないときの pty サイズ。低いと、Claude Code は選択肢の一部だけを出す（↑/↓ で送る）ので、
// 画面から読むメニューが欠ける。ターミナルモードで見ているあいだだけ、Claude Code ペインの大きさに合わせる
export const DEFAULT_PTY_SIZE = { cols: 120, rows: 40 };

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
  // 会話ログの行を、上の 3 つと画面の質問に振り分ける
  tasks: TaskRouter;
  // Claude が読んだ・書いたファイルとコンテキストの使用量
  knowledge: KnowledgeTracker;
  // コンテキストの中身（読んだファイル・大きなツールの結果・発言ごとのやりとりなど）
  context: ContextTracker;
  // statusLine から読んだモデル・コンテキスト・利用枠（応答のたびに更新）
  statusLine: StatusLineInfo | null;
  // 今の会話ログの行（uuid を持つもの）と、その行から作ったイベントの events 上の位置。巻き戻しの検出に使う
  chain: ChainEntry[];
  // 起動ごとに作り直す（pty の画面は起動ごとに別物）
  screen: ScreenTracker | null;
  // 選択メニューや認識できない対話画面が出ていて、ユーザーの操作を待っている
  attention: SessionAttention;
  // 実行中のバックグラウンドタスク（サブエージェント・ワークフロー・Bash）の数
  background: number;
  // 許可の確認を出す直前に、フックが書いた入力（親の Claude が子の許可の確認に答えるときに読む。pendingPermission）
  permission: PermissionRequest | null;
  // 許可の確認のメニューが出続けている間の、出はじめの時刻（出ていなければ null）と、その前に出ていたメニューの出はじめの時刻
  permissionSince: number | null;
  permissionBefore: number;
  // 今回の起動で入力を受け付けられるようになった（ready を配信した）
  ready: boolean;
  // 今回の起動で --permission-mode に渡したモード（画面からモードを読めるまでの間、起動し直すときに使う）
  startMode: PermissionMode | null;
  // 分かっている権限モード（起動の引数・アプリでの切り替え・今の claude が会話ログに書いたモードの、いちばん新しいもの）。
  // 子セッションの権限モードの上限に使う。画面の文字は会話の中の文でも読めてしまうので、上限には画面から読んだモードだけを使わない
  knownMode: PermissionMode | null;
  size: { cols: number; rows: number };
  // 引き継いだ claude（前のアプリが起動したもの）が起動した時刻。これ以降の会話ログの行は、今も動いている claude が書いた
  aliveSince: number | null;
  // ターンの途中（Claude Code が作業中）。引き継いだ claude では、読み直した会話の時点でターンの途中だったかも表す
  turnOpen: boolean;
  // 今の（か、最後に始まった）ターンを始めたもの。ターンが終わったら other に戻す（compact-notice.ts）
  turnStarter: TurnStarter;
  // Claude Code の入力の順番待ち（会話ログの queue-operation）。完了通知も入る。human: ユーザーが送った発言
  queue: { text: string; human: boolean }[];
  // Remote Control が実際につながっているか（会話ログの bridge_status・空の bridge-session で分かる）。
  // null: --remote-control を付けて起動した・/remote-control でつないだあと、つながるのを待っている
  remoteConnected: boolean | null;
  // /remote-control で切り替えている途中（そのあいだに出るメニューを、質問や確認として扱わない）
  remoteSwitching: boolean;
  // 会話ログを読み終えた（読み直しの途中の、古いつながりの状態で合わせないため）
  historyLoaded: boolean;
  // 読み直した会話ログの最後の Remote Control の URL（bridge-session 行。切れていれば null、行が無ければ undefined）。
  // bridge-session 行には時刻が無く、引き継いだ claude が書いたものか分からないため、読み終えてから今のつながりとして使う
  lastBridgeUrl: string | null | undefined;
  // 合わせようとして失敗した向き。同じ向きには試し直さない（指定を変えたら、また試す）
  remoteTried: boolean | null;
  // worktree の準備の途中（Claude Code が worktree を作るのを待っている・node_modules の用意）。終わるまで ready を配信しない
  // （最初の指示を、準備が終わる前に送らないため）
  preparing: WorktreePreparing | null;
  // Claude Code が worktree を作り終えたか（新しい worktree で起動したときだけ。作れずに終わったら false）
  worktreeCreated: Promise<boolean> | null;
  // ファイルの変更を見張っているフォルダ（worktree は、Claude Code が作るまで見張れない）
  watched: string | null;
  // 見張っている、ワークスペースに追加したフォルダ
  watchedFolders: string[];
  // 送信の順番待ち。チャットの入力欄からの発言と、親セッションからの指示・知らせを、混ぜずに 1 つずつ打ち込む
  sendChain: Promise<void>;
  // 打ち込んでいる途中の文字（空白を除く）と、打ち込み始めた（打ち終えた）時刻。画面の draft から除いて画面に知らせる（チャットの入力欄に移さないため）
  // writing: まだ打っている途中（長い文は小分けに打つので、何秒もかかる）。そのあいだ入力欄にある文字は、どれも打っている途中のもの
  typing: { text: string; at: number; writing: boolean } | null;
  // 中断で入力欄に戻った発言（空白を除いた draft）に添えてあった札の中身。入力欄では目印（[Pasted text #1 …]）になっていて、
  // 画面からは中身が読めないので、取り消した発言から取っておき、画面に知らせる ScreenInfo に添える（shownScreen）
  pulledBack: { draft: string; pastes: string[] } | null;
  // 起動を待って送る発言の数と、送ってから発言が会話ログに出るまでの時刻（ツールで返す状態で、作業中として扱う）
  pendingSubmits: number;
  submittedAt: number | null;
  // 手が空くのを待っている送信（submitWhenReady）の列。待ち始めた順。先頭だけが打てる（送った順に届ける）
  submitQueue: symbol[];
  // チェックリストの MCP サーバーを足して起動したか（引き継いだ claude は分からないので null）
  checklistMcp: boolean | null;
  // 打ち込んだ最適化圧縮の文（仕上げの頼み・再開の文。空白を除く）。応答が始まるまで覚えておき、応答の前に中断されて
  // Claude Code の入力欄に戻ったものを、人のチャットの入力欄に移さない（compactDraft）
  compactTyped: string | null;
};

// アプリが開くコマンドのターミナル（worktree の npm install・yarn install など）。終了コードを返す。owner: セッションの id
export type RunTask = (owner: string, cwd: string, command: string, name: string) => Promise<number>;

type Listeners = {
  onSessionsChanged: (sessions: SessionSummary[]) => void;
  onChat: (batch: ChatBatch) => void;
  onPtyData: (sessionId: string, data: string) => void;
  onTurnCompleted: (session: SessionSummary, notice: TurnNotice) => void;
  onScreen: (sessionId: string, info: ScreenInfo) => void;
  onActivity: (sessionId: string, activity: Activity | null) => void;
  onWorkflows: (sessionId: string, runs: WorkflowRun[]) => void;
  onSubagents: (sessionId: string, runs: SubagentRun[]) => void;
  onBashTasks: (sessionId: string, tasks: BashTask[]) => void;
  onKnowledge: (sessionId: string, knowledge: SessionKnowledge) => void;
  onStatusLine: (sessionId: string, info: StatusLineInfo) => void;
  // ユーザーの操作待ちになった。menu: 選択メニューが新しく出た（質問・許可確認）、unsupported: チャットでは操作できない画面が出た（ターミナルでの操作が要る）
  onAttention: (session: SessionSummary, attention: { kind: 'menu'; menu: Menu } | { kind: 'unsupported' }) => void;
  // フックが答えを待っている AskUserQuestion（いちばん前のもの）が変わった（無くなったら null）
  onQuestion?: (sessionId: string, question: PendingQuestion | null) => void;
};

export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();
  private focusedId: string | null = null;
  private closed = false;

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
    // 起動する Claude Code に、AskUserQuestion の質問をアプリに渡して答えを待つフック（question-hook.ts）を足すときの材料。
    // 待ち受けを始められなかったら null（質問は、画面を読む道で答える）
    private readonly questionHook: () => McpLaunch | null = () => null,
  ) {}

  // フックが答えを待っている AskUserQuestion（セッションごと）
  private readonly questions = new PendingQuestions((id) => this.questionsChanged(id));

  // 状態が変わったかもしれないセッション（イベント・画面の操作待ち・バックグラウンドの数・アーカイブ）を知らせる先
  private readonly stateListeners = new Set<(id: string) => void>();

  watchState(listener: (id: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private changed(id: string): void {
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

  // ターンが終わったときに、人に出す通知の種類（null なら出さない。profile.ts がつなぐ）。最適化圧縮の流れの途中のターンでは出さず、
  // 流れの最後のターンでは「コンテキストの最適化が完了しました」にする（compact-notice.ts）。ターンの終わりごとに、1 回だけ呼ぶ。
  // starter: 終わったターンを始めたもの
  turnNotice: (id: string, starter: TurnStarter) => TurnNotice | null = () => 'work';

  // 終わったターンで、Claude が人への報告（report_result）を預けたか（profile.ts がつなぐ）。報告があれば、バックグラウンドのタスクが
  // 動いていても、ターンの終わりに通知する（報告は、どう終わったかを伝えるもの）
  turnReported: (id: string) => boolean = () => false;

  // 最後に終わったターンが、人の中断（Esc）で終わったか
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
  // 作れずに Claude Code が終わったら、記録を消して、そのときの画面を添えて失敗する
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
    // 終わる直前の出力（信頼していないという理由など）は、画面があとで文字にする。アプリが忙しいと、終わりに気づくほうが
    // 先になるので、書き終えるのを待ってから読む
    const tracker = this.runtimes.get(id)?.screen;
    await tracker?.flushed();
    // 人がアーカイブした・一覧から消したのは、作れなかったのではない
    const record = this.store.get(id);
    if (!record || record.archived) return false;
    const screen = tracker?.text() ?? '';
    await this.archive(id).catch(() => null);
    this.store.remove(id);
    this.emitSessions();
    // claude --worktree は、まだ信頼していないフォルダでは、信頼の確認を出さずに終わる（実測）
    if (/trust not yet accepted/i.test(screen)) {
      throw new Error(t('main.worktree.untrustedFolder'));
    }
    throw new Error(`${t('main.worktree.createFailed')}${screen ? `\n\n${screen.split('\n').slice(-8).join('\n')}` : ''}`);
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
      ...(parentId ? { parentId, launchMode: options.mode } : {}),
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
      this.start(id, record.launchMode ?? null);
      void this.prepareWorktree(id, 'restored');
      return;
    }
    // 子セッションは起動のモードで（ほかのセッションは、これまでどおり既定のまま）
    this.start(id, record?.launchMode ?? null);
  }

  // アーカイブする。removeWorktree: worktree のセッションなら、Claude Code が終わるのを待ってから worktree も消す。
  // children: 子セッションも一緒にアーカイブする（親だけをアーカイブしない）
  async archive(id: string, options?: ArchiveOptions, children = true): Promise<WorktreeRemoval | null> {
    const rt = this.runtimes.get(id);
    const record = this.store.get(id);
    const removing = !!options?.removeWorktree && !!record?.worktree;
    // 消すときは、消している途中に Claude Code が書き込まないよう、終わるのを待つ
    if (removing) await rt?.process?.stop();
    else rt?.process?.kill();
    this.settingsFiles?.release(id);
    this.questions.releaseAll(id);
    rt?.screen?.dispose();
    rt?.workflows.dispose();
    rt?.subagents.dispose();
    rt?.bashTasks.dispose();
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

  // ツールで返す、今の状態（知らないセッションは null）
  stateOf(id: string): SessionState | null {
    const record = this.store.get(id);
    if (!record) return null;
    if (record.archived) return 'archived';
    if (this.restoring.has(id)) return 'starting';
    const rt = this.runtimes.get(id);
    if (!rt?.process) return 'exited';
    // フックが答えを待っている質問があれば、画面によらず質問中
    if (this.questions.first(id)) return 'question';
    // 質問と読めても、AskUserQuestion を出していなければ質問ではない（コマンドの文字に ☐ があると、許可の確認が質問に見える）。
    // 親が答えられる質問と見せないよう、許可の確認として扱う
    if (rt.attention === 'question') return rt.screen?.askedQuestions ? 'question' : 'permission';
    if (rt.attention === 'permission') return 'permission';
    if (rt.attention === 'other') return 'waiting';
    if (!rt.ready || rt.preparing) return 'starting';
    if (rt.pendingSubmits > 0 || rt.turnOpen) return 'working';
    if (rt.submittedAt !== null && Date.now() - rt.submittedAt < SUBMIT_GRACE_MS) return 'working';
    if (rt.background > 0) return 'background';
    return 'idle';
  }

  // 子セッションの権限モードの上限にする、今の権限モード。分かっているモード（起動の引数・アプリでの切り替え・Claude Code が会話ログに
  // 書いたモード。無ければ manual）と、画面から読んだモードの弱いほう（画面の文字は偽れるので、強くする向きには使わない。ターミナルで下げたときは下げる）
  modeOf(id: string): PermissionMode | null {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    const known = rt.knownMode ?? 'manual';
    const shown = rt.screen?.current.mode;
    return shown ? weakerMode(shown, known) : known;
  }

  // 今のモデル（--model に渡せる ID）とエフォート。start_session で省いたときに、呼んだセッションに合わせるために使う。
  // statusLine（Claude Code が渡す今の値。/model・/effort で変えたあとも追える）があればそれ、無ければ起動の指定（アプリで選んだもの）。
  // どちらも無ければ null（Claude Code の既定のまま）。画面のモデル名は表示名なので、--model には使わない
  currentModel(id: string): string | null {
    return this.runtimes.get(id)?.statusLine?.model?.id ?? this.store.get(id)?.model ?? null;
  }

  currentEffort(id: string): string | null {
    const rt = this.runtimes.get(id);
    return rt?.statusLine?.effort ?? rt?.screen?.current.effort ?? this.store.get(id)?.effort ?? null;
  }

  // 今出している AskUserQuestion の質問。出していなければ null
  askedQuestions(id: string): AskQuestion[] | null {
    return this.runtimes.get(id)?.screen?.askedQuestions ?? null;
  }

  // 会話（動かしたことがあれば直近の起動からのイベント、なければ会話ログから作ったもの）
  async conversation(id: string): Promise<ChatEvent[]> {
    const rt = this.runtimes.get(id);
    return rt ? [...rt.events] : this.history(id);
  }

  snapshot(id: string): SessionSnapshot {
    const rt = this.runtimes.get(id);
    if (!rt) return { sessionId: id, fromSeq: 0, events: [] };
    return { sessionId: id, fromSeq: rt.seq - rt.events.length, events: rt.events };
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
    const request = raw as { tool_name?: unknown; tool_input?: unknown; agent_type?: unknown; agent_id?: unknown } | null;
    if (!rt || !request || typeof request.tool_name !== 'string' || !request.tool_input || typeof request.tool_input !== 'object') return;
    const agent = typeof request.agent_type === 'string' ? request.agent_type : typeof request.agent_id === 'string' ? request.agent_id : null;
    // ファイルの変化は、1 回の書き込みで何度か知らされることがある。同じ書き込み（同じ時刻）は数え直さない
    if (rt.permission?.at === at) return;
    rt.permission = { seq: (rt.permission?.seq ?? 0) + 1, at, tool: request.tool_name, input: request.tool_input as Record<string, unknown>, agent };
    this.changed(id);
  }

  // 今出ている許可の確認の、ツールの名前と入力の全文。フックの入力が、今の確認のものと言えるときだけ返す:
  // 許可の確認のメニューが出ていて、入力が書かれたのが、1 つ前に出ていたメニューの出はじめよりあと
  // （前の確認の入力が残っているだけなら、その確認のメニューが出るより前に書かれている）
  pendingPermission(id: string): PermissionRequest | null {
    const rt = this.runtimes.get(id);
    if (!rt?.process || !rt.permission || rt.permissionSince === null) return null;
    return rt.permission.at > rt.permissionBefore ? rt.permission : null;
  }

  // AskUserQuestion を出す直前に、フックがその入力をファイルに書いた（説明・プレビューを質問のカードに出すため）
  askQuestionsChanged(id: string, input: unknown): void {
    const questions = askQuestionsOf(input);
    if (questions) this.runtimes.get(id)?.screen?.setQuestions(questions);
  }

  // 質問のフック（question-hook.ts）が、AskUserQuestion の入力を渡した。返事（質問のカード・親の answer_question）を待って、
  // フックに返す結果にする。待つのをやめた（人がターミナルで答えた・Claude Code が終わった）ときは kind: none（フックは何も決めない）。
  // signal: フックとのつながりが切れた（Claude Code がフックを止めた）
  async waitQuestion(id: string, input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const questions = askQuestionsOf(input);
    const reply = questions && this.runtimes.get(id)?.process ? await this.questions.wait(id, questions, signal) : null;
    return textResult(JSON.stringify(reply ?? { kind: 'none' }));
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

  // statusLine のファイルが書き換わった
  statusLineChanged(id: string, info: StatusLineInfo): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.statusLine = info;
    this.listeners.onStatusLine(id, info);
    // /clear で新しい会話になると、statusLine の会話ログのパスが変わる（Remote Control を使っていなくても追える）
    if (info.transcriptPath) rt.process?.followTranscript(info.transcriptPath);
  }

  // このセッションの Remote Control を切り替える。動いていれば /remote-control でその場でつなぐ・切る。
  // 止まっていれば、次に起動するときの指定だけ変える。切り替えられなかったら指定を戻して、理由を返す
  async setRemoteControl(id: string, on: boolean): Promise<string | null> {
    if (!this.remoteControlAvailable) return t('main.remote.unavailable');
    const record = this.store.get(id);
    if (!record) return t('main.session.notFound');
    const fail = (reason: string) => {
      this.store.update(id, { remoteControl: !on });
      this.emitSessions();
      return reason;
    };
    this.store.update(id, { remoteControl: on });
    this.emitSessions();
    const rt = this.runtimes.get(id);
    rt && (rt.remoteTried = null);
    // 止まっている・起動の途中・つながるのを待っているときは、起動やつながりが済んでから合わせる（reconcileRemote）
    if (!rt?.process || !rt.screen || !rt.ready || !rt.historyLoaded || rt.remoteConnected === null || rt.remoteConnected === on) return null;
    if (rt.remoteSwitching) return fail(t('main.remote.switching'));
    const screen = rt.screen.current;
    if (screen.state.kind !== 'prompt') return fail(t('main.remote.waitingAnswer'));
    if (screen.draft) return fail(t('main.remote.draft'));
    const ok = await this.switchRemote(id, rt, record.cwd, on);
    // 画面では分からなくても、会話ログで目的の状態になっていれば済んでいる
    if (ok || rt.remoteConnected === on) return null;
    return fail(t('main.remote.failed'));
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

  // Remote Control が今つながっているか。null: つながるのを待っている。Claude Code が動いていなければ false
  remoteConnectedOf(id: string): boolean | null {
    const rt = this.runtimes.get(id);
    return rt?.process ? rt.remoteConnected : false;
  }

  // このセッションで Remote Control を使うか（開発版では使わない）
  private wantsRemote(record: SessionRecord): boolean {
    return this.remoteControlAvailable && record.remoteControl !== false;
  }

  // 指定と、実際につながっているかがずれていたら、/remote-control で合わせる。
  // 切る指定の会話を再開すると、Claude Code が前のつながりを勝手に戻すので、それもここで切る
  private reconcileRemote(id: string): void {
    const rt = this.runtimes.get(id);
    const record = this.store.get(id);
    if (!rt?.process || !rt.screen || !record || !rt.ready || !rt.historyLoaded || rt.remoteSwitching || rt.remoteConnected === null) return;
    const want = this.wantsRemote(record);
    if (want === rt.remoteConnected || rt.remoteTried === want) return;
    const screen = rt.screen.current;
    if (screen.state.kind !== 'prompt' || screen.draft) return;
    void this.switchRemote(id, rt, record.cwd, want);
  }

  private async switchRemote(id: string, rt: Runtime, cwd: string, on: boolean): Promise<boolean> {
    const screen = rt.screen;
    if (!screen) return false;
    rt.remoteSwitching = true;
    rt.remoteTried = on;
    const ok = await screen.setRemoteControl(on ? remoteName(cwd) : null).catch(() => false);
    rt.remoteSwitching = false;
    // つないだときは bridge_status が届くまで待つ。切ったときは空の bridge-session が届くが、先に切れたことにする
    if (ok) rt.remoteConnected = on ? null : false;
    // 切り替えのあいだ止めていた画面の変化を、今の画面で送り直す
    if (rt.screen === screen) this.handleScreen(id, screen, screen.current);
    return ok;
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

  bashTasks(id: string): BashTask[] {
    return this.runtimes.get(id)?.bashTasks.all() ?? [];
  }

  // 動いているバックグラウンドのもの（サブエージェント・ワークフロー・Bash）を止める。止められなかったら理由を返す。
  // 本家と同じ操作（/tasks の画面で選んで x）を、画面にキーを送って行う。止まったかは、Claude Code が会話ログに書く完了通知で分かる
  async stopTask(id: string, ref: TaskRef): Promise<string | null> {
    const rt = this.runtimes.get(id);
    if (!rt?.process || !rt.screen) return t('main.task.notRunning');
    const name = stopName(rt, ref);
    if (name === null) return t('main.task.nothingToStop');
    switch (await rt.screen.stopTask(name).catch((): StopResult => 'failed')) {
      case 'stopped':
        return null;
      case 'busy':
        return t('main.task.busy');
      case 'not-prompt':
        return t('main.task.waitingAnswer');
      case 'draft':
        return t('main.task.draft');
      case 'not-found':
        return t('main.task.notFound');
      case 'ambiguous':
        return t('main.task.ambiguous');
      case 'failed':
        return t('main.task.failed');
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

  screen(id: string): ScreenInfo | null {
    return this.runtimes.get(id)?.screen?.current ?? null;
  }

  // 画面に知らせる ScreenInfo。打ち込んでいる途中の文字は、入力欄に残った文字（draft）から除く
  screenForView(id: string): ScreenInfo | null {
    const rt = this.runtimes.get(id);
    const info = rt?.screen?.current;
    return rt && info ? shownScreen(rt, info) : null;
  }

  activity(id: string): Activity | null {
    return this.runtimes.get(id)?.screen?.currentActivity ?? null;
  }

  // 権限モードを切り替える（画面のモード欄・親の configure_session）。子セッションは、起動し直しても切り替えたモードで起動するよう、
  // 起動のモード（launchMode）も変える。Claude Code が動いていない子は、次に起動するときのモードだけを変える
  async setMode(id: string, mode: PermissionMode): Promise<boolean> {
    const rt = this.runtimes.get(id);
    const child = !!this.store.get(id)?.parentId;
    if (!rt?.process) {
      if (child) this.store.update(id, { launchMode: mode });
      return child;
    }
    const ok = (await rt.screen?.setMode(mode)) ?? false;
    if (ok) {
      rt.knownMode = mode;
      this.store.update(id, { knownMode: mode, ...(child ? { launchMode: mode } : {}) });
    }
    return ok;
  }

  async rewind(id: string, text: string): Promise<boolean> {
    return (await this.runtimes.get(id)?.screen?.rewindTo(text)) ?? false;
  }

  // カードの選択肢を選ぶ。選べなかったときは理由を返す（画面がカードに出す）
  async choose(id: string, choice: ScreenChoice): Promise<ChooseResult> {
    return (await this.runtimes.get(id)?.screen?.choose(choice.optionId, choice.key, choice.text)) ?? 'gone';
  }

  // expect を満たすメニューのあいだだけ選ぶ（親が子の質問に答えるとき。途中で許可の確認などに変わったら、何も押さない）。選べたら chosen
  async chooseIf(id: string, choice: ScreenChoice, expect: (menu: Menu) => boolean): Promise<ChooseResult> {
    return (await this.runtimes.get(id)?.screen?.choose(choice.optionId, choice.key, choice.text, expect)) ?? 'gone';
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
      try {
        this.restart(id);
      } catch {}
    });
  }

  configure(id: string, options: SessionOptions): void {
    const record = this.store.get(id);
    const settingsFile = options.settingsFile ?? null;
    const settingsChanged = (record?.settingsFile ?? null) !== settingsFile;
    if (settingsChanged) this.checkSettingsFile(settingsFile);
    // 設定ファイルを変えたら、モデルとエフォートは新しい設定の既定に戻す（前の設定のモデルが、新しい設定で使えるとは限らない）
    const model = settingsChanged ? null : options.model;
    const effort = settingsChanged ? null : options.effort;
    const modelChanged = (record?.model ?? null) !== model;
    // モデルや設定ファイルを変えたら、1M コンテキストかどうかは起動時の表示で分かり直す
    this.store.update(id, { model, effort, settingsFile, ...(modelChanged || settingsChanged ? { oneMillion: undefined } : {}) });
    if (this.runtimes.get(id)?.process) this.restart(id);
    else this.emitSessions();
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
  // question: AskUserQuestion の質問をアプリに渡すフックを足すか
  private prepareSettings(
    id: string,
    settingsFile: string | null | undefined,
    browser: boolean,
    sessions: boolean,
    checklist: boolean,
    terminal: boolean,
    question: boolean,
  ): PreparedSettings | null {
    if (!settingsFile) {
      // 標準の設定に戻した（または初めから標準）。前の設定ファイルで合わせたファイルが残っていれば消す
      this.settingsFiles?.release(id);
      return null;
    }
    if (!this.settingsFiles) throw new Error(t('main.settingsFile.unavailable'));
    return this.settingsFiles.prepare(id, settingsFile, browser, sessions, checklist, terminal, question);
  }

  // Claude Code を起動し直して同じ会話を続ける（--resume）。スキル・CLAUDE.md・設定・MCP などを読み込み直すため。
  // 権限モードは起動し直すと既定に戻るので、--permission-mode で元のモードを渡す
  restart(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt?.process) {
      void this.open(id);
      return;
    }
    // 起動し直せないと分かっているのに、動いている claude を止めないよう、先に設定ファイルを確かめる
    this.checkSettingsFile(this.store.get(id)?.settingsFile);
    let mode = rt.screen?.current.mode ?? rt.startMode;
    // 子セッションは、起動したときのモードより強くしない（画面の文字は偽れるため）
    const launchMode = this.store.get(id)?.launchMode;
    if (launchMode && mode && !modeWithin(mode, launchMode)) mode = launchMode;
    rt.process.kill();
    rt.process = null;
    // バックグラウンドのタスクは一緒に止まる
    rt.workflows.stopRunning();
    rt.subagents.stopRunning();
    rt.bashTasks.stopRunning();
    this.start(id, mode && mode !== 'bypassPermissions' ? mode : null);
  }

  write(id: string, data: string): void {
    this.runtimes.get(id)?.process?.write(data);
  }

  // Claude Code の入力欄に打ち込んで送る。画像はパスを貼り付けとして送ると [Image #n] として添付される。
  // 同じセッションへの送信は 1 つずつ順に打ち込む（チャットの入力欄からの発言と、親セッションからの指示・知らせが混ざらないように）。
  // guarded: 打つ直前と Enter の直前に、入力欄に打ってよい状態かを確かめ、そうでなければ打たずに失敗する（submitWhenReady）
  // rawPastes: 入力欄に外から貼り付けた長い文（札）。打った文のあとに、1 つずつ丸ごと貼り付けとして打つ。
  // Claude Code は入力欄で [Pasted text #1 …] の目印に置き換え、中身を <pasted_content> の囲みに入れて Claude に渡す（CLI に貼り付けたときと同じ）
  submit(id: string, rawText: string, attachments: string[] = [], guarded = false, rawPastes: string[] = []): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt?.process) return Promise.resolve();
    const run = async () => {
      const process = rt.process;
      if (!process) return;
      if (guarded && !acceptsTyping(rt)) throw new Error(t('main.send.notAccepting'));
      // ESC などが残ると、貼り付けの外に出てキー操作（Enter・Shift+Tab など）として届いてしまうので取り除く
      const text = stripControlChars(rawText);
      const pastes = rawPastes.map(stripControlChars).filter((p) => p.trim());
      // 画面の折り返しで空白が変わるので、空白を除いて覚える（目印にならなかった札は、文字のまま入力欄に入る）
      const typing = { text: [text, ...pastes].join('').replace(/\s/g, ''), at: Date.now(), writing: true };
      rt.typing = typing;
      rt.compactTyped = isCompactMessage(text) ? text.replace(/\s/g, '') : null;
      rt.submittedAt = Date.now();
      try {
      for (const path of attachments) {
        process.write(bracketedPaste(stripControlChars(path)));
        await sleep(300);
        process.write(' ');
      }
      if (text) {
        // 改行を含む入力・長い入力は、行ごとの短い貼り付けとして送る（promptKeys）。長い文は、小さな分に分けて書き、
        // 前の分が入力欄に出てから次を書く（promptKeyChunks。まとめて書くと、貼り付けの合図が読む区切りで割れることがある）。
        // 打った文字が入力欄に出てから Enter を送る。決まった時間だけ待つと、Claude Code が忙しくて読むのが遅れたとき
        // （起動の直後に MCP サーバーがつながる間など）、文字と Enter が 1 度に届く。長い文字は貼り付けとみなされ、Enter は改行として入力欄に入る（送られない）
        // readable: 入力欄の文字を画面から読めている。読めなくなったら（時間切れ・メニューが出た）、残りは待たずに書く
        let readable = true;
        for (const [i, chunk] of promptKeyChunks(text).entries()) {
          // 打っている途中に、質問や確認のメニューが出た（裏のタスクの知らせで始まったターンが、許可を求めたなど）・claude が終わったら、
          // 残りは書かない。メニューに打つと、文字や数字が選択になることがある。Enter を送るかは、下で決める
          if (i > 0 && (rt.process !== process || rt.screen?.current.state.kind === 'menu')) break;
          const before = rt.screen?.current.draft ?? '';
          // 長い文は、打つのに SUBMIT_GRACE_MS より長くかかることがある（4 万文字で 12 秒ほど）。打っている間も、作業中に見せ続ける
          rt.submittedAt = Date.now();
          process.write(chunk.keys);
          // 空白だけの分（空行）は、入力欄に出たかを見分けられないので待たない（合図も入っていない）
          if (readable && chunk.shown.trim()) readable = await this.untilTyped(rt, process, before, chunk.shown);
        }
      } else if (pastes.length === 0) {
        await sleep(50);
      }
      for (const paste of pastes) {
        const before = rt.screen?.current.draft ?? '';
        process.write(bracketedPaste(paste));
        // 目印（か、短くて目印にならなかった文字）が入力欄に出てから、次を打つ（Claude Code が読み終えたのを、札ごとに確かめる）
        await this.untilTyped(rt, process, before, paste);
      }
      } finally {
        // 打ち終えた。ここからしばらく（TYPING_MS）は、打った文字が入力欄に残っていても、チャットの入力欄に移さない
        typing.writing = false;
        typing.at = Date.now();
      }
      // Enter の直前にメニューが出ていたら、Enter はメニューの選択になってしまう
      if (guarded && (rt.screen?.current.state.kind !== 'prompt' || rt.attention !== null)) {
        throw new Error(t('main.send.menuAppeared'));
      }
      // 送ってから発言が会話ログに出るまでの猶予（SUBMIT_GRACE_MS）は、Enter から数える。打ち始めから数えると、打つのに時間のかかる
      // 長い文では、Enter の直後に猶予が切れて、手が空いたように見える（wait_sessions が返る・親に知らせが行く・次の送信が打ち始める）
      rt.submittedAt = Date.now();
      process.write('\r');
      this.changed(id);
      // 発言として残らなかったとき（スラッシュコマンドなど）も、作業中として扱う時間が過ぎたら知らせ直す
      setTimeout(() => this.changed(id), SUBMIT_GRACE_MS + 100);
    };
    const next = rt.sendChain.then(run, run);
    rt.sendChain = next.catch(() => {});
    return next;
  }

  // 打った文字が入力欄に出る（Claude Code が読み終える）のを待つ。出たら true。メニューが出たらやめる（Enter を送るかは submit が決める）。
  // TYPED_MS たっても出なければ、待つのをやめて Enter を送る（画面から読み取れない文字など）
  private async untilTyped(rt: Runtime, process: ClaudeSession, before: string, text: string): Promise<boolean> {
    const until = Date.now() + TYPED_MS;
    while (rt.process === process && Date.now() < until) {
      const info = rt.screen?.current;
      if (!info || info.state.kind === 'menu') return false;
      if (typedShown(info.draft, before, text)) return true;
      await sleep(TYPED_POLL_MS);
    }
    return false;
  }

  // 手が空く（ターンが終わり、入力を受け付けられる）のを待ってから送る（子セッションへの指示・親への知らせ）。
  // 作業中の Claude Code に打つと、そのあいだに出た許可の確認で、Enter や数字が選択になってしまうことがある。
  // 手が空いていれば、新しい確認が急に出ることはない（ツールを使うには、まず応答が要る）。
  // 待っている間も、ツールで返す状態は作業中にする。待ちきれない・終わったときは、理由を添えて失敗する。
  // 待っている送信がいくつもあるときは、待ち始めた順に 1 つずつ打つ（続けて送った指示が、入れ替わって届かないように）。
  // attachments: 画像のパス・pastes: 入力欄の札（submit と同じ）/ signal: 待っている間に取りやめる（予約の取り消し。打ち込み始めたあとは止めない）
  async submitWhenReady(
    id: string,
    text: string,
    timeoutMs: number,
    { attachments = [], pastes = [], signal }: { attachments?: string[]; pastes?: string[]; signal?: AbortSignal } = {},
  ): Promise<void> {
    const rt = this.runtimes.get(id);
    const process = rt?.process;
    if (!rt || !process) throw new Error(t('main.send.notRunning'));
    rt.pendingSubmits += 1;
    const ticket = Symbol('submit');
    rt.submitQueue.push(ticket);
    this.changed(id);
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (rt.process !== process) throw new Error(t('main.send.exited'));
        if (signal?.aborted) throw new Error(t('main.send.cancelled'));
        // 直前に送ったもの（まだ会話ログに出ていない）があれば、それが終わるまで待つ
        const sending = rt.submittedAt !== null && Date.now() - rt.submittedAt < SUBMIT_GRACE_MS;
        // 先に待ち始めた送信があれば、それが打ち終わる（か、待つのをやめる）まで待つ。それぞれが別々に手が空くのを見ているので、
        // 順番を決めておかないと、手が空いた瞬間に先に見たほうが打ち、あとから送った指示が先に届く
        if (rt.submitQueue[0] === ticket && acceptsTyping(rt) && !sending) break;
        if (Date.now() > deadline) {
          const screen = rt.screen?.current;
          if (screen?.state.kind === 'menu') throw new Error(t('main.send.waitingAnswer'));
          if (screen?.draft) throw new Error(t('main.send.draft'));
          throw new Error(t('main.send.busy'));
        }
        await sleep(200);
      }
      // 続けて待っているほかの送信が、同じ隙に打ち込まないよう、すぐに印を付ける
      rt.submittedAt = Date.now();
      await this.submit(id, text, attachments, true, pastes);
    } finally {
      rt.submitQueue.splice(rt.submitQueue.indexOf(ticket), 1);
      rt.pendingSubmits -= 1;
      this.changed(id);
    }
  }

  // 中断で入力欄に戻った親からの指示を消す（親が止めたとき。人のチャットの入力欄に、囲みのまま移さないため）
  withdrawParentDraft(id: string): Promise<void> {
    return this.withdrawDraft(id, isParentMessageDraft);
  }

  // 中断で入力欄に戻った、最適化圧縮の文（仕上げの頼み）が、Claude Code の入力欄に出ているか
  compactDraftShown(id: string): boolean {
    const rt = this.runtimes.get(id);
    return !!rt?.process && rt.screen?.current.state.kind === 'prompt' && compactDraft(rt, rt.screen.current.draft);
  }

  // 中断で入力欄に戻った、最適化圧縮の仕上げの頼みを消す（取りやめたとき）。長い文は入力欄に収まらず、見えているのは一部なので、
  // 入力欄が空になるまで繰り返し消す
  async withdrawCompactDraft(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    await this.withdrawDraft(id, (draft) => compactDraft(rt, draft), true);
    rt.compactTyped = null;
  }

  // repeat: 消したあとも見張り、まだ残っていれば消し直す（出なくなって少したったら終える）
  private async withdrawDraft(id: string, matches: (draft: string) => boolean, repeat = false): Promise<void> {
    const rt = this.runtimes.get(id);
    // 最後に消した回（まだ消していなければ -1）
    let clearedAt = -1;
    for (let i = 0; i < 60 && rt?.process; i++) {
      const draft = rt.screen?.current.draft ?? '';
      if (rt.screen?.current.state.kind === 'prompt' && matches(draft)) {
        rt.process.write('\x15'.repeat(draft.split('\n').length + 1));
        if (!repeat) return;
        clearedAt = i;
      } else if (clearedAt === -1 ? i >= 14 : i - clearedAt >= 5) {
        return;
      }
      await sleep(100);
    }
  }

  // 作業を中断する（Esc）。打ち込んでいる途中の文字はもう無いので、Claude Code が入力欄に戻した発言は、そのままチャットの入力欄に移す
  interrupt(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.typing = null;
    rt.process?.write('\x1b');
  }

  resize(id: string, cols: number, rows: number): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.size = { cols, rows };
    rt.process?.resize(cols, rows);
    rt.screen?.resize(cols, rows);
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
        this.host.attach(info).kill();
        continue;
      }
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
      } else rt.process?.detach();
      rt.screen?.dispose();
      rt.workflows.dispose();
      rt.subagents.dispose();
      rt.bashTasks.dispose();
    }
    this.watchers.closeAll();
    this.store.flush();
  }

  isFocused(id: string): boolean {
    return this.focusedId === id;
  }

  // mode: --permission-mode で渡す権限モード（このセッションだけ）。null なら既定のまま。
  // adopted: 起動せずに引き継ぐ、動いている claude
  private start(id: string, mode: PermissionMode | null = null, adopted: HostedPtyInfo | null = null): void {
    const record = this.store.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);

    // 設定ファイルを使えなければ、何も変えずにここで断る（標準の設定に黙って切り替わらないように）。
    // 引き継ぐ claude は、前のアプリが起動したままなので、書き直さない
    const browser = adopted ? null : this.browser();
    const launch = adopted ? null : this.sessionsMcp();
    const checklist = adopted ? null : this.checklistMcp();
    const walkthrough = adopted ? null : this.walkthroughMcp();
    const terminalLaunch = adopted ? null : this.terminalMcp();
    const question = adopted ? null : this.questionHook();
    // 子セッションには、子を動かすツールを見せない（孫は作れない）。人のターミナルも、読むツールだけ（打てるのは、人が見ている親だけ）
    const sessions = launch && record.parentId ? { ...launch, child: true } : launch;
    const terminal: TerminalMcpLaunch | null = terminalLaunch && record.parentId ? { ...terminalLaunch, child: true } : terminalLaunch;
    const settings = adopted ? null : this.prepareSettings(id, record.settingsFile, !!browser, !!sessions, !!checklist, !!terminal && !terminal.child, !!question);

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
        screen: () => this.runtimes.get(id)?.screen ?? null,
        sessionDir: () => this.sessionDir(id),
        // 人がターミナルや Remote Control で答えたら、その質問を待っているフックを終わらせる
        questionAnswered: (questions) => {
          if (questions) this.questions.answeredElsewhere(id, questions);
        },
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
        screen: null,
        attention: null,
        background: 0,
        permission: null,
        permissionSince: null,
        permissionBefore: 0,
        ready: false,
        startMode: null,
        knownMode: null,
        size: DEFAULT_PTY_SIZE,
        aliveSince: null,
        turnOpen: false,
        turnStarter: 'other',
        queue: [],
        remoteConnected: false,
        remoteSwitching: false,
        historyLoaded: false,
        lastBridgeUrl: undefined,
        remoteTried: null,
        preparing: null,
        worktreeCreated: null,
        watched: null,
        watchedFolders: [],
        sendChain: Promise.resolve(),
        typing: null,
        pulledBack: null,
        pendingSubmits: 0,
        submittedAt: null,
        submitQueue: [],
        checklistMcp: null,
        compactTyped: null,
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
    this.pushEvents(id, [{ type: 'process-start' }]);
    const runtime = rt;
    runtime.screen?.dispose();
    runtime.attention = null;
    runtime.ready = false;
    runtime.startMode = mode;
    // 引き継ぐ claude は、前のアプリが決めたモードのまま動いているので、記録から戻す
    runtime.knownMode = adopted ? (record.knownMode ?? null) : mode;
    if (!adopted) this.store.update(id, { knownMode: mode });
    runtime.aliveSince = adopted?.startedAt ?? null;
    runtime.turnOpen = false;
    runtime.queue = [];
    // --remote-control を付けて起動するなら、つながるのを待つ。
    // 引き継いだ claude は付けて起動したか分からないが、つながった記録は起動のあとに書かれるので、会話ログを読み直すと分かる
    const remote = this.wantsRemote(record);
    runtime.remoteConnected = remote && !adopted ? null : false;
    runtime.remoteSwitching = false;
    // 読み直す会話ログが無ければ（新しい会話）、読み終わりの知らせは来ないので、はじめから読み終えたことにする
    runtime.historyLoaded = fileSize(transcriptPath(record.cwd, claudeSessionId, this.claudeDir)) === 0;
    runtime.lastBridgeUrl = undefined;
    runtime.remoteTried = null;
    // 引き継ぐときは、claude の今の画面の大きさで描き直してから、アプリの大きさに合わせる
    const screen = new ScreenTracker(
      adopted?.cols ?? rt.size.cols,
      adopted?.rows ?? rt.size.rows,
      (data) => runtime.process?.write(data),
      (info) => this.handleScreen(id, screen, info),
      record.oneMillion === true,
      (activity) => {
        if (runtime.screen === screen) this.listeners.onActivity(id, activity);
      },
    );
    rt.screen = screen;
    this.listeners.onActivity(id, null);

    // 新しい worktree で始めるときは、Claude Code が作り終えるまで準備中にする。
    // 前の起動が worktree を作ったあと、入力欄を出す前に終わって（起動し直して）いたら、その「作成中」は戻す
    // （戻さないと、入力欄が出ても受け付けない。node_modules の用意の途中なら、終わるまで待たせたまま）
    const creating = !!record.worktree && !resume && !adopted && !existsSync(record.cwd);
    if (creating) runtime.preparing = 'creating';
    else if (runtime.preparing === 'creating') runtime.preparing = null;

    rt.process = new ClaudeSession(
      this.host,
      {
        sessionId: id,
        cwd: record.cwd,
        worktree: record.worktree?.name ?? null,
        worktreeRoot: record.worktree?.root ?? null,
        claudeSessionId,
        resume,
        remoteControlName: remote ? remoteName(record.worktree?.root ?? record.cwd) : null,
        model: record.model ?? null,
        effort: record.effort ?? null,
        permissionMode: mode,
        settings,
        statusFile: this.statusLines.fileFor(id),
        askFile: this.statusLines.askFileFor(id),
        browser,
        sessions,
        checklist,
        walkthrough,
        terminal,
        question,
        claudeDir: this.claudeDir,
        // 追加したあとで消した・動かしたフォルダは渡さない（エクスプローラーには残し、人が外せるようにする）
        addDirs: (record.addedFolders ?? []).filter((folder) => existsSync(folder)),
        ...rt.size,
      },
      {
        onData: (data) => {
          screen.feed(data);
          this.listeners.onPtyData(id, data);
        },
        onInput: () => screen.noteInput(),
        onExit: (exitCode) => {
          rt.process = null;
          this.settingsFiles?.release(id);
          this.questions.releaseAll(id);
          rt.workflows.stopRunning();
          rt.subagents.stopRunning();
          rt.bashTasks.stopRunning();
          if (rt.queue.length > 0) this.updateQueue(id, rt, () => []);
          this.pushEvents(id, [{ type: 'process-exit', exitCode }]);
          this.emitSessions();
        },
        onEntry: (entry, isHistory) => this.handleEntry(id, entry, isHistory),
        // 再開時、応答のないまま終わった過去のターンを作業中として扱わない。
        // 引き継いだ claude がターンの途中なら、本当に作業中なのでそのままにする
        onHistoryLoaded: () => {
          if (!runtime.turnOpen) this.pushEvents(id, [{ type: 'turn-end' }]);
          // 引き継いだ claude は、最後の bridge-session 行のつながりのまま動いている
          // （以前つないでいた会話を再開すると、フラグが無くてもつなぎ直すため）
          if (adopted && runtime.lastBridgeUrl !== undefined) {
            runtime.remoteConnected = runtime.lastBridgeUrl !== null;
            this.pushEvents(id, [{ type: 'remote-control', url: runtime.lastBridgeUrl }]);
          }
          runtime.historyLoaded = true;
          this.reconcileRemote(id);
        },
        onSwitch: (nextClaudeSessionId) => {
          this.store.update(id, { claudeSessionId: nextClaudeSessionId });
          // 新しい会話になったのは、送った /clear が受け取られたということ。/clear は発言として会話ログに出ないので、ここで消さないと、
          // 送ってから SUBMIT_GRACE_MS のあいだ「送信中」のままになり、次の送信（最適化圧縮の再開の文）が待たされる
          rt.submittedAt = null;
          rt.turnOpen = false;
          this.changed(id);
          rt.chain = [];
          rt.knowledge.reset();
          rt.context.reset();
          this.pushEvents(id, [this.compactClearing(id) ? { type: 'reset', compact: true } : { type: 'reset' }]);
        },
      },
      adopted,
    );
    rt.process.start();
    if (creating) {
      const process = rt.process;
      // この起動が続いているか。終わった・起動し直した・アーカイブした（止めたときは、終了の知らせが来ない）ら、待つのをやめる
      const alive = () => runtime.process === process && this.runtimes.get(id) === runtime;
      const waiting: Promise<boolean> = waitForWorktree(record.cwd, alive).then((created) => {
        if (created && alive()) {
          this.watch(runtime, record.cwd);
          // .git ができた時点では、git worktree add がまだファイルを書き出している（大きなリポジトリでは、git ls-files が空になる。実測）。
          // Claude Code は worktree を作り終えてから入力欄を出すので、それを待ってから node_modules を用意する
          void this.untilScreenReady(runtime, alive).then((ready) => {
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
    if (adopted) void this.catchUpStatusLine(id, rt.process);
    // 引き継いだ claude は前のアプリの頃から動いていて、会話もしている。画面から入力欄を読めるのを待たずに、起動済みとする
    // （入力欄を読むのは画面が描き直されたときなので、読み取りがずれたまま Claude Code が何も描かずに待っていると、いつまでも「起動中」になる）
    if (adopted && hasConversation(transcriptPath(record.cwd, claudeSessionId, this.claudeDir))) screen.markReady();
    if (adopted && (adopted.cols !== rt.size.cols || adopted.rows !== rt.size.rows)) this.resize(id, rt.size.cols, rt.size.rows);
    this.emitSessions();
  }

  // Claude Code が入力欄を出すまで待つ。その前に終わった・起動し直した・アーカイブしたら（alive が false）false
  private async untilScreenReady(rt: Runtime, alive: () => boolean): Promise<boolean> {
    for (;;) {
      if (!alive()) return false;
      if (rt.screen?.current.ready) return true;
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
    // 起動した Claude Code が先に入力欄を出しても、準備が終わるまで待たせる（await より前に決める）
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
    // 準備の間に入力欄が出ていたら、ここで受け付けられるようになったことにする
    if (!rt.ready && rt.screen?.current.ready) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
    }
    this.emitSessions();
  }

  // 引き継いだ claude が、アプリが止まっている間に書いた statusLine を読む。次の応答で書かれるのを待つと、
  // それまでモデル・コンテキストが出ず、アプリが止まっている間の /clear にも追従できない（前の会話を出したままになる）
  private async catchUpStatusLine(id: string, process: ClaudeSession): Promise<void> {
    const info = await this.statusLines.peek(id);
    const rt = this.runtimes.get(id);
    // 読んでいる間に新しいものが届いていれば、そちらを使う
    if (info && rt?.process === process && !rt.statusLine) this.statusLineChanged(id, info);
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

  // 応答の前に Esc で中断した発言は、Claude Code が会話から外して入力欄に戻す。会話ログには何も書かれないので、
  // 入力欄に戻ったのを画面で見て、発言の表示を取り消し、ターンを終える（戻った文字は、チャットの入力欄に移す）
  private withdrawPulledBack(id: string, rt: Runtime, draft: string): void {
    const cut = pulledBackPrompt(rt.events, draft);
    if (cut === null) return;
    const pastes = pulledBackPastes(rt.events[cut], draft);
    rt.pulledBack = pastes.length > 0 ? { draft: draft.replace(/\s/g, ''), pastes } : null;
    const kept = rt.events.slice(0, cut);
    // 発言の行から後の行を、会話のつながりからも外す（発言の前の、イベントの無い行は残す）
    let at = -1;
    rt.chain.forEach((c, i) => {
      if (c.type === 'user' && c.eventStart === cut) at = i;
    });
    if (at !== -1) rt.chain = rt.chain.slice(0, at);
    rt.events = kept;
    // replace は events に残さない（kept がそのまま置き換え後の状態）。通し番号だけ進める
    const fromSeq = rt.seq;
    rt.seq += 1;
    this.listeners.onChat({ sessionId: id, fromSeq, events: [{ type: 'replace', events: kept }], live: true });
    rt.turnOpen = false;
    this.pushEvents(id, [{ type: 'turn-end' }]);
    this.emitSessions();
  }

  // 今の claude が会話ログに書いた権限モードを、分かっているモード（knownMode）にする。アプリがモードを渡さずに起動したとき
  // （止まっていたセッションを開く・既定のモードで始める）に Claude Code が選んだモード（--resume では前回のモードを戻す）や、
  // Remote Control・ターミナルで切り替えたモードも、子の権限モードの上限に使えるように。画面の文字と違い、会話の中の文では偽れない
  private noteMode(id: string, rt: Runtime, entry: TranscriptEntry): void {
    const mode = permissionModeOf(entry);
    if (!mode || mode === rt.knownMode) return;
    rt.knownMode = mode;
    this.store.update(id, { knownMode: mode });
  }

  // 作業中に送った発言は、Claude Code が受け取るまで会話ログに発言として書かれず、順番待ち（queue-operation）にだけ書かれる。
  // それを追って、受け取られるまでチャットに「順番待ち」として出す
  private trackQueue(id: string, rt: Runtime, entry: TranscriptEntry): void {
    const e = entry as TranscriptEntry & { operation?: string; content?: unknown };
    if (entry.type !== 'queue-operation') return;
    const text = queuedText(e.content);
    if (e.operation === 'enqueue' && text !== null) {
      this.updateQueue(id, rt, (queue) => [...queue, { text, human: isHumanPrompt(text) }]);
    } else if (e.operation === 'dequeue') {
      this.updateQueue(id, rt, (queue) => queue.slice(1));
    } else if (e.operation === 'remove' && text !== null) {
      // 作業の途中で差し込まれたとき・入力欄に戻したとき
      this.updateQueue(id, rt, (queue) => {
        const i = queue.findIndex((q) => q.text === text);
        return i === -1 ? queue : [...queue.slice(0, i), ...queue.slice(i + 1)];
      });
    } else if (e.operation === 'popAll') {
      this.updateQueue(id, rt, () => []);
    }
  }

  private updateQueue(id: string, rt: Runtime, change: (queue: Runtime['queue']) => Runtime['queue']): void {
    const human = (queue: Runtime['queue']) => queue.filter((q) => q.human).map((q) => promptDisplayText(q.text));
    const before = human(rt.queue);
    rt.queue = change(rt.queue);
    const after = human(rt.queue);
    if (after.length !== before.length || after.some((t, i) => t !== before[i])) this.pushEvents(id, [{ type: 'queue', prompts: after }]);
  }

  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある）
  private sessionDir(id: string): string {
    const record = this.store.get(id)!;
    return join(dirname(transcriptPath(record.cwd, record.claudeSessionId, this.claudeDir)), record.claudeSessionId);
  }

  private handleScreen(id: string, screen: ScreenTracker, info: ScreenInfo): void {
    const rt = this.runtimes.get(id);
    if (!rt || rt.screen !== screen) return;
    // /remote-control で切り替えている途中に出るメニューは、質問や確認として見せない
    if (rt.remoteSwitching) return;
    // 画面に知らせる前に見る（戻った発言の札の中身を、同じ知らせに添えるため）
    if (info.state.kind === 'prompt' && rt.turnOpen && screen.currentActivity === null) this.withdrawPulledBack(id, rt, info.draft);
    this.listeners.onScreen(id, shownScreen(rt, info));
    if (info.ready && !rt.ready && !rt.preparing) {
      rt.ready = true;
      this.pushEvents(id, [{ type: 'ready' }]);
    }
    const oneMillion = screen.oneMillionSeen;
    if (oneMillion !== null && this.store.get(id)?.oneMillion !== oneMillion) this.store.update(id, { oneMillion });
    if (info.state.kind === 'prompt') this.reconcileRemote(id);
    const shown = shownAttention(info);
    // 許可の確認のメニューの出はじめを覚える（pendingPermission が、フックの入力が今の確認のものかを見分ける）
    if (shown === 'permission' && rt.permissionSince === null) rt.permissionSince = Date.now();
    if (shown !== 'permission' && rt.permissionSince !== null) {
      rt.permissionBefore = rt.permissionSince;
      rt.permissionSince = null;
    }
    this.updateAttention(id, rt, info);
  }

  // 操作待ちの種類を、画面と、フックが答えを待っている質問から決める。待っている質問があれば、画面に許可の確認が出ているとき
  // （質問を待っている間に出た別の確認）のほかは、画面によらず質問（画面を読めない・描き直しの途中でも）。
  // 操作待ちでなかったところから変わったら、通知する
  private updateAttention(id: string, rt: Runtime, info: ScreenInfo | null): void {
    const shown = info ? shownAttention(info) : null;
    const pending = this.questions.first(id);
    const attention = pending && shown !== 'permission' ? 'question' : shown;
    if (attention === rt.attention) return;
    const before = rt.attention;
    rt.attention = attention;
    this.emitSessions();
    this.changed(id);
    const summary = this.summary(id);
    // 終了したセッションは、最後の画面が残っていても通知しない（チャットの「操作できない画面」の案内も、動いているセッションだけ）
    if (!summary || !rt.process || before !== null) return;
    if (pending && attention === 'question') this.listeners.onAttention(summary, { kind: 'menu', menu: pendingMenu(pending) });
    else if (info?.state.kind === 'menu') this.listeners.onAttention(summary, { kind: 'menu', menu: info.state.menu });
    else if (info?.state.kind === 'unknown') this.listeners.onAttention(summary, { kind: 'unsupported' });
  }

  // フックが答えを待っている質問が増えた・減った・親が 1 問答えた
  private questionsChanged(id: string): void {
    this.listeners.onQuestion?.(id, this.questions.first(id));
    const rt = this.runtimes.get(id);
    // /remote-control で切り替えている途中は、画面のメニューを見ない（切り替え終わりの画面で決め直す）
    if (rt && !rt.remoteSwitching) this.updateAttention(id, rt, rt.screen?.current ?? null);
    // 操作待ちの種類が変わらなくても（親が 1 問答えた・続けて次の質問が来た）、一覧と状態の見張りに知らせる
    this.emitSessions();
    this.changed(id);
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

    const model = modelOf(entry);
    if (model) this.runtimes.get(id)?.screen?.noteModel(model, isHistory);

    const rt = this.runtimes.get(id);
    // 引き継いだ claude が起動してから書いた行は、読み直した履歴でも今動いているもの（バックグラウンドのタスクや質問を追う）
    const past = isHistory && !(rt?.aliveSince && entryTime(entry) >= rt.aliveSince);
    rt?.tasks.track(entry, past, isHistory);
    if (rt && !past) this.trackQueue(id, rt, entry);
    if (rt && !past) this.noteMode(id, rt, entry);
    rt?.knowledge.handle(entry);
    rt?.context.handle(entry);

    if (rt) this.followBranch(id, rt, entry, isHistory);
    // Remote Control の URL は起動ごとに変わる。前に起動した claude の URL（読み直した過去の行）は出さない
    const events = toChatEvents(entry, record.cwd, false, rememberImage).filter((e) => !(past && e.type === 'remote-control'));
    if (rt && isHistory) {
      const bridge = bridgeUrlOf(entry);
      if (bridge !== undefined) rt.lastBridgeUrl = bridge;
    }
    if (rt && !past) {
      const remote = [...events].reverse().find((e) => e.type === 'remote-control');
      if (remote) {
        rt.remoteConnected = remote.url !== null;
        this.reconcileRemote(id);
      }
      const starter = events.find((e) => e.type === 'user' || e.type === 'notice' || e.type === 'turn-start');
      if (starter) {
        // ターンを始めたもの。人の発言と、最適化圧縮の文（仕上げの頼み・再開の文）は、いつもターンの始まり。
        // ほかの知らせは、開いているターンの途中に届くことがあるので、ターンが開いていないときだけ見る
        const compact = starter.type === 'notice' && !!starter.compact;
        if (!rt.turnOpen || starter.type === 'user' || compact) rt.turnStarter = turnStarterOf(starter);
        rt.turnOpen = true;
        rt.submittedAt = null;
      }
      if (events.some((e) => e.type === 'turn-end')) rt.turnOpen = false;
      // 応答が始まったら、打ち込んだ最適化圧縮の文は、もう入力欄には戻らない
      if (events.some((e) => e.type === 'assistant-text' || e.type === 'tool-use')) rt.compactTyped = null;
    }
    if (events.length > 0) {
      const active = !isHistory && events.some((e) => e.type === 'user' || e.type === 'assistant-text' || e.type === 'tool-use');
      // 会話が動いているなら、入力欄が読めなくても Claude Code は入力を受け付けている。
      // 発言より先に ready を配信する（起動中の間はチャットの状態を変えないため）。
      // Remote Control の URL などは入力欄が出る前にも書かれるので数えない
      if (active) rt?.screen?.markReady();
      this.pushEvents(id, events, !isHistory);
      if (active) {
        // 一覧は更新の新しい順。すでに先頭なら並びは変わらないので、行ごとに一覧を送り直さない
        const wasFirst = this.list()[0]?.id === id;
        this.store.update(id, { updatedAt: Date.now() });
        if (!wasFirst) changed = true;
      }
      if (!isHistory && events.some((e) => e.type === 'turn-end')) {
        const rt = this.runtimes.get(id);
        if (rt && !this.isFocused(id)) rt.unread = true;
        changed = true;
        const summary = this.summary(id);
        // 通知を出さないとき（下の、バックグラウンドのタスクが動いているあいだなど）も聞く。流れの途中で出さなかったことを、覚えさせる
        const notice = this.turnNotice(id, rt?.turnStarter ?? 'other');
        if (rt) rt.turnStarter = 'other';
        // バックグラウンドのタスクが動いているあいだは、まだ完了ではない（一覧も「完了待ち」）。
        // タスクが終わると Claude Code が続きを始めるので、通知はそのターンの終わりに出す。
        // ブラウザでの操作を頼んでいるあいだも同じ（2 分を過ぎると Claude Code が呼び出しをバックグラウンドに移し、Claude はターンを終えて返事を待つ）。
        // ただし Claude が報告を預けていれば、タスクが動いていても出す（タスクを残したまま、作業を終えたと報告している）
        if (notice && summary && summary.attention !== 'browser' && (summary.backgroundTasks === 0 || this.turnReported(id))) this.listeners.onTurnCompleted(summary, notice);
      }
    }
    if (changed) this.emitSessions();
  }

  private pushEvents(id: string, events: ChatEvent[], live = true): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const fromSeq = rt.seq;
    rt.seq += events.length;
    rt.events.push(...events);
    this.listeners.onChat({ sessionId: id, fromSeq, events, live });
    this.changed(id);
  }

  private emitSessions(): void {
    this.listeners.onSessionsChanged(this.list());
  }
}

// 会話ログの応答のモデル ID を表示名にする（例: claude-sonnet-5 → Sonnet 5、claude-fable-5-1 → Fable 5.1）
function modelOf(entry: TranscriptEntry): string | null {
  const id = entry.type === 'assistant' ? entry.message?.model : undefined;
  // 新しい系統名のモデルにも対応できるよう、名前は決め打ちしない。
  // 小数点以下は 1 桁の数字だけ（claude-sonnet-5-20260101 の日付の先頭の 2 を、小数点以下と読まない）
  const m = id?.match(/^claude-([a-z]+)-(\d+)(?:-(\d)(?!\d))?(?:-\d{8})?/);
  if (!m) return null;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
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

// Remote Control のセッション名（スマホの一覧に出る）
// 止めたいものを、本家の /tasks の画面で見分ける名前にする（Bash はコマンド・エージェントは説明・ワークフローは名前）。
// 動いていない・バックグラウンドでない（本体の作業の中で動いている）・名前が分からないものは null
function stopName(rt: Runtime, ref: TaskRef): string | null {
  if (ref.kind === 'bash') {
    const task = rt.bashTasks.all().find((t) => t.toolUseId === ref.toolUseId);
    return task?.state === 'running' ? task.command || null : null;
  }
  if (ref.kind === 'workflow') {
    const run = rt.workflows.all().find((w) => w.toolUseId === ref.toolUseId);
    return run?.status === 'running' ? run.name || null : null;
  }
  const run = rt.subagents.all().find((r) => r.toolUseId === ref.toolUseId);
  return run?.state === 'running' && run.background ? run.description || null : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 入力欄の文字が、打ち込んだ最適化圧縮の文（応答の前に中断されて戻ったもの）か。
// 戻るのは本文そのもので、長い文は入力欄に収まらず、画面から読めるのは途中の一部だけ（2.1.296 で確かめた）。
// そこで、打ち込んだ文の一部かどうかで見る。短い文字は、人の書きかけと取り違えないよう、当てはめない
const COMPACT_DRAFT_MIN_CHARS = 40;

function compactDraft(rt: Runtime, draft: string): boolean {
  if (!draft.trim()) return false;
  if (isCompactMessage(draft)) return true;
  if (!rt.compactTyped) return false;
  const typed = draft.replace(/\[Pasted text #\d+[^\]]*\]/g, '').replace(/\s/g, '');
  return typed === '' || (typed.length >= COMPACT_DRAFT_MIN_CHARS && rt.compactTyped.includes(typed));
}

// 画面に知らせる ScreenInfo。打ち込んでいる途中の文字（送ったばかりで、まだ Claude Code の入力欄に残っているもの）は、
// 入力欄に残った文字として扱わない（チャットの入力欄に移すと、送った文字を消してしまう）。
// 貼り付けた文字や画像は入力欄では [Pasted text #1 +6 lines]・[Image #1] の目印になるので、除いて比べる
function shownScreen(rt: Runtime, info: ScreenInfo): ScreenInfo {
  // 親からの指示（中断で戻ったもの）は、人のチャットの入力欄に移さない（親が止めたら、withdrawParentDraft が消す）
  // 最適化圧縮の文も同じ（取りやめるときに、withdrawCompactDraft が消す）
  if (isParentMessageDraft(info.draft) || compactDraft(rt, info.draft)) return { ...info, draft: '' };
  const typing = rt.typing;
  // 打っている途中に入力欄にある文字は、打った文字。長い文は [...Truncated text #1 +21 lines...] の目印に置き換わって出るので、
  // 打った文字と比べても合わない。チャットの入力欄に移すと、Claude Code の入力欄を消して、打っている途中の文字が欠ける
  if (typing?.writing && info.draft) return { ...info, draft: '' };
  if (typing && info.draft && Date.now() - typing.at < TYPING_MS) {
    const typed = info.draft.replace(/\[(?:Pasted text #\d+[^\]]*|Image #\d+)\]/g, '').replace(/\s/g, '');
    if (typed === '' || typing.text.includes(typed)) return { ...info, draft: '' };
  }
  // 中断で戻った発言の札。入力欄がそのままの間だけ添える（人が続きを打ったら、目印の文字のまま移る）
  if (rt.pulledBack && !info.draft) rt.pulledBack = null;
  return rt.pulledBack && rt.pulledBack.draft === info.draft.replace(/\s/g, '') ? { ...info, draftPastes: rt.pulledBack.pastes } : info;
}

// 長い入力で、入力欄の終わりと比べる文字の数（typedShown）
const TYPED_TAIL_CHARS = 40;

// 打った文字（text）が、Claude Code の入力欄（画面の draft。打つ前は before）に出たか。画面の折り返しで空白が変わるので、空白を除いて比べる。
// - 丸ごと貼り付けた入力（/ や ! で始まる複数行・/compact の長い引数）は、入力欄では [Pasted text #1 +6 lines] の目印になるので、
//   目印で終わるようになったかで見る
// - 長い複数行の入力は、行ごとの短い貼り付けで送る（promptKeys の pastedLines）。入力欄には文字のまま入るが、長いと全部は映らないので、
//   終わりの TYPED_TAIL_CHARS 文字が入力欄の終わりに出たかで見る（カーソルは終わりにあるので、終わりの行は映っている）
export function typedShown(draft: string, before: string, text: string): boolean {
  if (draft === before) return false;
  if (/\[Pasted text #\d+[^\]]*\]\s*$/.test(draft)) return true;
  const shown = draft.replace(/\s/g, '');
  const typed = text.replace(/\s/g, '');
  return shown.endsWith(typed) || (typed.length > TYPED_TAIL_CHARS && shown.endsWith(typed.slice(-TYPED_TAIL_CHARS)));
}

// 入力欄に打ってよい状態か。手が空いていて（ターンの外・操作待ちでない）、入力欄に書きかけが無く、画面の操作の途中でもない
function acceptsTyping(rt: Runtime): boolean {
  const info = rt.screen?.current;
  return (
    !!rt.process &&
    rt.ready &&
    !rt.preparing &&
    !rt.turnOpen &&
    rt.attention === null &&
    info?.state.kind === 'prompt' &&
    !info.draft &&
    !rt.screen?.operating
  );
}

function remoteName(cwd: string): string {
  return `tanacode-${basename(cwd)}`;
}

// 動いている Claude Code の状態の文言（セッション一覧の文言にそろえる）
function stateLabel(rt: Runtime, browserAsk: boolean): string {
  if (rt.attention === 'question') return t('main.state.question');
  if (rt.attention === 'permission') return t('main.state.permission');
  if (rt.attention === 'other') return t('main.state.other');
  if (browserAsk) return t('main.state.browser');
  if (!rt.ready) return t('main.state.starting');
  const count = rt.background;
  if (rt.turnOpen) return count > 0 ? t('main.state.workingWithBackground', { count }) : t('main.state.working');
  if (count > 0) return t('main.state.waitingBackground', { count });
  return t('main.state.idle');
}



// 順番待ちの発言の文字。画像つきのときは content が配列で来る
function queuedText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.map((b: { type?: unknown; text?: unknown }) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
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

// 画面に出ている操作待ちの種類（メニューの種類・認識できない画面）。操作待ちでなければ null
function shownAttention(info: ScreenInfo): Runtime['attention'] {
  return info.state.kind === 'menu' ? info.state.menu.kind : info.state.kind === 'unknown' ? 'other' : null;
}

// フックが答えを待っている質問の通知に使うメニュー（通知の本文は質問文）
function pendingMenu(pending: PendingQuestion): Menu {
  return { kind: 'question', tabs: [], title: pending.questions[0]?.question ?? '', context: [], options: [], multiSelect: false, hint: '' };
}
