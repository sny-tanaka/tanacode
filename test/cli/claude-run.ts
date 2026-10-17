import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ASK_FILE_ENV, isTranscriptEntry, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import type { ChatBatch, SessionSummary } from '@shared/ipc';
import type { SessionKnowledge } from '@shared/knowledge';
import type { PendingPermission, PendingQuestion, PermissionReply, QuestionReply } from '@shared/questions';
import type { Activity, Menu, PermissionMode } from '@shared/screen';
import type { SessionState } from '@shared/session-tools';
import type { StatusLineInfo } from '@shared/statusline';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import { CHECKLIST_COMMAND_ENV, CHECKLIST_SCRIPT_ENV, CHECKLIST_SESSION_ENV, CHECKLIST_SOCKET_ENV } from '../../src/main/checklist-bridge';
import { BROWSER_COMMAND_ENV, BROWSER_SCRIPT_ENV, BROWSER_SESSION_ENV, BROWSER_SOCKET_ENV, type BrowserMcpLaunch } from '../../src/main/browser-bridge';
import { FILE_CHECKPOINTING_ENV, transcriptPath } from '../../src/main/claude-session';
import type { McpLaunch } from '../../src/main/mcp-bridge';
import { SessionManager } from '../../src/main/session-manager';
import { SessionStore } from '../../src/main/session-store';
import { STATUS_FILE_ENV, StatusLineWatcher } from '../../src/main/statusline';
import { TERMINAL_COMMAND_ENV, TERMINAL_SCRIPT_ENV, TERMINAL_SESSION_ENV, TERMINAL_SOCKET_ENV } from '../../src/main/terminal-bridge';
import { WorkspaceWatchers } from '../../src/main/workspace-watcher';
import { FIXTURE_ROOT } from '../scenario';
import { FakePtyHost } from './fake-pty-host';

// API キーでログインしたことにする（モックの API にしか送らない）
const API_KEY = 'sk-ant-api03-tanacode-cli-check-00000000000000000000';
// 状態を待つときに見直す間隔
const POLL_MS = 50;

// 控えの会話ログに残さない行（attachment の type）。システムプロンプトの全文やツール・スキルの一覧、
// 動かした環境ごとの情報で、アプリは読まない
const DROPPED_ATTACHMENTS = ['prompt_snapshot', 'skill_listing', 'agent_listing_delta', 'remote_session_change'];

// 確かめる claude。TANACODE_CLAUDE_BIN が無ければ PATH の claude
export const CLAUDE_BIN = process.env.TANACODE_CLAUDE_BIN || 'claude';

export function claudeVersion(): string {
  return execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)?.[0] ?? '';
}

// 会話ログの 1 行と、起動したときにもうあった行（--resume で読み直した過去の行）か
export type Seen = { entry: TranscriptEntry; isHistory: boolean };

// 質問・許可の確認を待っているときの、session-manager の知らせ（アプリはこれで通知を出す）
export type Attention = { kind: 'menu'; menu: Menu };

type Options = {
  // ユーザーの設定（~/.claude/settings.json）。hooks を足すのに使う
  settings?: Record<string, unknown>;
  // 作業フォルダに置いておくファイル（パス → 中身）
  files?: Record<string, string>;
  // claude に足す環境変数（API エラーの再試行の回数を減らすなど）
  env?: Record<string, string>;
  // 起動の引数に付けるモデル・エフォート（claudeArgs の model・effort）。無ければ付けない
  model?: string;
  effort?: string;
  // アプリ内ブラウザの MCP サーバー（中継）を足すときの材料（SessionManager の browser）。無ければ足さない
  browser?: BrowserMcpLaunch;
  // セッションの MCP サーバー（中継）を足すときの材料（SessionManager の sessionsMcp）。無ければ足さない
  sessions?: McpLaunch;
  // チェックリストの MCP サーバー（中継）を足すときの材料（SessionManager の checklistMcp）。無ければ足さない
  checklist?: McpLaunch;
  // 人のターミナルの MCP サーバー（中継）を足すときの材料（SessionManager の terminalMcp）。無ければ足さない
  terminal?: McpLaunch;
  // 起動するときの権限モード。無ければ manual（許可の確認を出させる）
  mode?: PermissionMode;
  // 作業フォルダを git のリポジトリにする（files をはじめのコミットにする）。claude --worktree の確認に使う
  git?: boolean;
  // フォルダの信頼の確認を済ませておく（claude --worktree は、信頼していないフォルダでは始まらない）
  trusted?: boolean;
};

// 本物の claude を、アプリと同じ SessionManager で動かして読む。src/main/index.ts と同じ組み立て方で、
// pty ホストだけを node-pty を直に使う偽物（FakePtyHost）に、userData を使い捨てのフォルダに差し替える（electron には頼らない）。
// - stream-json: session-manager の StreamClient（送信・制御の要求・待っている要求）。ターミナルモードの TUI の画面は読まない
// - 会話ログ: ClaudeSession の TranscriptFollower から session-manager の行の処理（handleEntry）へ。
//   チャットのイベント（巻き戻しの replace・順番待ちの queue を含む）は、session-manager が配信したものを chatEvents に控える
// - バックグラウンドの作業と質問: session-manager の TaskRouter と各トラッカー
// - statusLine と書くだけのフック: StatusLineWatcher（<dir>/<id>.json・<id>.permission.json など）
// HOME は使い捨てのフォルダにするので、ふだんの ~/.claude には触らない
export class ClaudeRun {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-cli-')));
  readonly home = join(this.root, 'home');
  readonly cwd = join(this.root, 'work');
  // アプリの userData にあたるもの
  private readonly userData = join(this.root, 'userData');
  readonly seen: Seen[] = [];
  // 乗り換えた会話ログ（/clear のあと）
  readonly switches: string[] = [];
  readonly activities: (Activity | null)[] = [];
  workflowRuns: WorkflowRun[] = [];
  subagentRuns: SubagentRun[] = [];
  bashTasks: BashTask[] = [];
  // session-manager が配信したチャットのイベント（届いた順。ChatBatch をつなげたもの）と、配信そのもの
  readonly chatEvents: ChatEvent[] = [];
  readonly chatBatches: ChatBatch[] = [];
  // 選択メニューなど、ユーザーの操作待ちになったときの知らせ（onAttention）
  readonly attentions: Attention[] = [];
  // 作業が終わったときの知らせ（onTurnCompleted。アプリは「作業が完了しました」の通知を出す）
  readonly turnsCompleted: SessionSummary[] = [];
  // 最後に届いたセッションの一覧（onSessionsChanged）
  sessions: SessionSummary[] = [];
  statusLine: StatusLineInfo | null = null;
  knowledge: SessionKnowledge | null = null;
  // アプリのセッション ID（session-manager が作る。statusLine のファイル名にもなる）
  sessionId: string | null = null;
  private readonly host: FakePtyHost;
  private app: { manager: SessionManager; statusLines: StatusLineWatcher; watchers: WorkspaceWatchers } | null = null;
  // アプリを起動し直した回数。前のアプリの知らせを捨てるのに使う
  private generation = 0;
  // 起動する前の会話の ID（起動すると session-manager の記録のものを使う）
  private readonly firstClaudeSessionId = randomUUID();
  private exited: number | null = null;
  private readonly oldHome = process.env.HOME;

  constructor(
    private readonly baseUrl: string,
    private readonly options: Options = {},
  ) {
    mkdirSync(join(this.home, '.claude'), { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    // 最初の案内（テーマの選択）と API キーの確認は済んだことにする。フォルダの信頼の確認は、アプリでも出るのでそのまま
    writeFileSync(
      join(this.home, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: 'dark',
        customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
        ...(options.trusted ? { projects: { [this.cwd]: { hasTrustDialogAccepted: true } } } : {}),
        // bypassPermissions で起動したときの、はじめの注意は済んだことにする
        ...(options.mode === 'bypassPermissions' ? { bypassPermissionsModeAccepted: true } : {}),
      }),
    );
    if (options.settings) writeFileSync(join(this.home, '.claude', 'settings.json'), JSON.stringify(options.settings));
    for (const [path, text] of Object.entries(options.files ?? {})) {
      mkdirSync(dirname(join(this.cwd, path)), { recursive: true });
      writeFileSync(join(this.cwd, path), text);
    }
    if (options.git) {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=tanacode', '-c', 'user.email=tanacode@localhost', ...args], { cwd: this.cwd, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      // ファイルの多いリポジトリでは、コミットのあとに git が裏で片付け（gc --auto）を始め、終わるまで .git に書き続ける。
      // テストの終わりに一時フォルダを消すのとぶつかる（ENOTEMPTY）ので、このリポジトリでは動かさない
      git('config', 'gc.auto', '0');
      git('add', '-A');
      git('commit', '-qm', 'init', '--allow-empty');
    }
    // 環境変数は最小限にする（Claude Code の中から動かしたときの子セッションの印などを持ち込まない）。
    // アプリが付ける statusLine・書くだけのフックのファイルの変数と、ファイルの控え（巻き戻しに要る）の変数だけは、session-manager が渡すものを使う
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: this.home,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ANTHROPIC_BASE_URL: this.baseUrl,
      ANTHROPIC_API_KEY: API_KEY,
      NO_PROXY: '127.0.0.1,localhost',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // 台本ごとに足す環境変数（再試行の回数など）
      ...this.options.env,
    };
    this.host = new FakePtyHost(CLAUDE_BIN, env, [
      STATUS_FILE_ENV,
      FILE_CHECKPOINTING_ENV,
      ASK_FILE_ENV,
      BROWSER_SOCKET_ENV,
      BROWSER_SESSION_ENV,
      BROWSER_COMMAND_ENV,
      BROWSER_SCRIPT_ENV,
      CHECKLIST_SOCKET_ENV,
      CHECKLIST_SESSION_ENV,
      CHECKLIST_COMMAND_ENV,
      CHECKLIST_SCRIPT_ENV,
      TERMINAL_SOCKET_ENV,
      TERMINAL_SESSION_ENV,
      TERMINAL_COMMAND_ENV,
      TERMINAL_SCRIPT_ENV,
    ]);
  }

  // 動かしている SessionManager（起動するまでは無い）
  get manager(): SessionManager {
    if (!this.app) throw new Error('まだ起動していません');
    return this.app.manager;
  }

  get entries(): TranscriptEntry[] {
    return this.seen.map((s) => s.entry);
  }

  // 今の会話の ID（/clear で変わる）
  get claudeSessionId(): string {
    const id = this.sessionId && this.app?.manager.transcriptOf(this.sessionId);
    return id ? idOf(id) : this.firstClaudeSessionId;
  }

  // 今回の起動で、前からあった会話ログを読み終えたか（新しい会話でははじめから読み終えている）
  get historyLoaded(): boolean {
    return this.runtime()?.historyLoaded ?? false;
  }

  // Claude Code の手が空いている（ターンの外。裏のタスクが動いていてもよい。前は画面の入力欄で見ていたもの）
  get idle(): boolean {
    const state = this.sessionId ? this.manager.stateOf(this.sessionId) : null;
    return state === 'idle' || state === 'background';
  }

  // 順番待ちの発言（session-manager が最後に配信した 'queue' のイベントのうち、Claude Code が順番待ちにしたもの）
  get queue(): string[] {
    const last = [...this.chatEvents].reverse().find((e) => e.type === 'queue');
    return last?.type === 'queue' ? last.prompts.filter((p) => p.state === 'queued').map((p) => p.text) : [];
  }

  // statusLine が書くファイル（StatusLineWatcher の <dir>/<id>.json）
  get statusFile(): string {
    return join(this.userData, 'statusline', `${this.sessionId ?? 'none'}.json`);
  }

  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある）
  sessionDir(): string {
    return join(dirname(this.transcript()), this.claudeSessionId);
  }

  // 起動した TUI（ターミナルモード）の引数。起動した順
  get tuiArgs(): string[][] {
    return this.host.ptyArgs;
  }

  // 今の会話ログ（worktree のセッションでは、worktree のフォルダの側に書かれる）
  transcript(): string {
    return (this.sessionId && this.app?.manager.transcriptOf(this.sessionId)) || transcriptPath(this.cwd, this.claudeSessionId);
  }

  // サブエージェントの会話ログ（session-manager の agentLog と同じく、SubagentTracker に聞く）。まだ分からなければ null
  subagentLog(toolUseId: string): string | null {
    return this.runtime()?.subagents.logFile(toolUseId, join(this.sessionDir(), 'subagents')) ?? null;
  }

  // session-manager が持っている、今のチャットのイベント（巻き戻しのあとは巻き戻した状態。画面がはじめに受け取るもの）
  chat(): ChatEvent[] {
    return this.sessionId && this.app ? this.app.manager.snapshot(this.sessionId).events : [];
  }

  // セッションの一覧の 1 行（状態・操作待ち・バックグラウンドの数）
  summary(): SessionSummary | undefined {
    return this.sessionId && this.app ? this.app.manager.summary(this.sessionId) : undefined;
  }

  // resume: 今の会話を --resume で再開する（アプリが止まっているセッションを開いたとき）
  start({ resume = false }: { resume?: boolean } = {}): void {
    // sessionSettings（ユーザーの statusLine を探す）と transcriptPath は homedir() を見るので、このプロセスの HOME も差し替える
    process.env.HOME = this.home;
    this.exited = null;
    if (!this.app) this.launchApp();
    const manager = this.manager;
    if (!this.sessionId) {
      // 許可の確認を出させる（API キーでは既定が auto になり、確認が出ない）
      this.sessionId = manager.create(this.cwd, {
        model: this.options.model ?? null,
        effort: this.options.effort ?? null,
        settingsFile: null,
        mode: this.options.mode ?? 'manual',
        remoteControl: false,
        worktree: false,
      });
      return;
    }
    if (this.runtime()?.process) throw new Error('claude が動いています（stopClaude で止めてから start します）');
    // 止まっているセッションを開くのと同じく、会話があれば --resume で再開する（session-manager の start が決める）。
    // 権限モードは、はじめの起動と同じく manual にする（open では既定のままになる）
    if (resume && !this.hasConversation()) throw new Error('再開する会話がまだありません');
    manager['start'](this.sessionId, this.options.mode ?? 'manual');
  }

  // 新規セッションの画面で「worktree で始める」をオンにしたのと同じく、claude --worktree で始める。
  // Claude Code が worktree を作るまで待つ（作れなければ、session-manager の理由で失敗する）
  async startInWorktree(): Promise<void> {
    process.env.HOME = this.home;
    this.exited = null;
    if (!this.app) this.launchApp();
    const options = { model: this.options.model ?? null, effort: this.options.effort ?? null, settingsFile: null, mode: 'manual' as const, remoteControl: false, worktree: true };
    this.sessionId = await this.manager.createInWorktree(this.cwd, options);
  }

  // 一覧で選び直したのと同じく、止まっている（アーカイブした）セッションを開く。worktree を消していれば、session-manager が作り直す
  async reopen(): Promise<void> {
    process.env.HOME = this.home;
    this.exited = null;
    await this.manager.open(this.sessionId!);
  }

  // 同じフォルダで新しいセッションを作って起動する（アプリの新規セッションと同じ）。今の claude は止める
  newSession(): void {
    this.stopClaude();
    this.sessionId = null;
    this.exited = null;
    this.start();
  }

  // claude だけを止める（--resume で起動し直す前に）。claude が自分で終わったのと同じく、session-manager の onExit を通る
  stopClaude(): void {
    if (this.sessionId) this.host.terminate(this.sessionId);
  }

  // アプリを終了して起動し直す（claude は止めない）。新しい SessionManager が、動いている claude を引き継ぐ（adopt）。
  // whileClosed: アプリを止めている間にすること（claude だけで進む作業が終わるのを待つなど）
  async restartApp(whileClosed?: () => Promise<void>): Promise<void> {
    process.env.HOME = this.home;
    this.closeApp(false);
    await whileClosed?.();
    this.exited = null;
    this.launchApp();
    await this.app!.statusLines.start();
    await this.manager.adopt();
  }

  // アプリを止めている間の操作として、claude に発言の行（stream-json の user の行）を直に書く
  sendWithoutApp(text: string): void {
    if (this.sessionId) this.host.write(this.sessionId, JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID() }));
  }

  // src/main/index.ts と同じく、StatusLineWatcher と SessionManager を組み立てる
  private launchApp(): void {
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    const ours = (id: string) => live() && id === this.sessionId;
    const statusDir = join(this.userData, 'statusline');
    mkdirSync(statusDir, { recursive: true });
    const statusLines = new StatusLineWatcher(
      statusDir,
      (id, info) => live() && manager.statusLineChanged(id, info),
      (id, request, at) => live() && manager.permissionRequested(id, request, at),
      (id, input) => live() && manager.tuiIdle(id, input),
    );
    const watchers = new WorkspaceWatchers(() => {});
    const store = new SessionStore(join(this.userData, 'sessions.json'));
    const manager: SessionManager = new SessionManager(
      this.host,
      store,
      watchers,
      statusLines,
      {
        onSessionsChanged: (sessions) => live() && (this.sessions = sessions),
        onChat: (sent) => {
          // create の中で最初の配信が届くので、セッション ID はまだ無いことがある（ClaudeRun のセッションは 1 つだけ）
          if (!live()) return;
          // アプリの IPC と同じく、送った時点の中身を写して受け取る（session-manager は配信したあとも同じ配列に書き足す）
          const batch = structuredClone(sent);
          this.chatBatches.push(batch);
          this.chatEvents.push(...batch.events);
          for (const event of batch.events) {
            if (event.type === 'process-exit') this.exited = event.exitCode;
            // /clear などで別の会話ログに乗り換えた（session-manager の onSwitch。記録の会話の ID はもう新しいもの）
            if (event.type === 'reset') this.switches.push(this.transcript());
          }
        },
        // ターミナルモードの TUI の画面は読まない（決めたこと）
        onPtyData: () => {},
        onTurnCompleted: (session) => live() && this.turnsCompleted.push(session),
        onProgress: (id, activity) => ours(id) && this.activities.push(activity),
        onWorkflows: (id, runs) => ours(id) && (this.workflowRuns = runs),
        onSubagents: (id, runs) => ours(id) && (this.subagentRuns = runs),
        onBashTasks: (id, tasks) => ours(id) && (this.bashTasks = tasks),
        onKnowledge: (id, knowledge) => ours(id) && (this.knowledge = knowledge),
        onStatusLine: (id, info) => ours(id) && (this.statusLine = info),
        onAttention: (session, attention) => ours(session.id) && this.attentions.push(attention),
      },
      // 開発版と同じく Remote Control は使わない（claude.ai へのログインが要る）
      false,
      null,
      // worktree の npm install などは、画面に出さずに実行する（既定のまま）
      undefined,
      () => this.options.browser ?? null,
      () => this.options.sessions ?? null,
      () => this.options.checklist ?? null,
      // ウォークスルーは足さない。設定のフォルダは既定のプロファイル
      undefined,
      null,
      () => this.options.terminal ?? null,
    );
    // 会話ログの行を、session-manager が受け取るのと同じ順に控える（行の処理 handleEntry の手前に差し込む）
    const handleEntry = manager['handleEntry'].bind(manager);
    manager['handleEntry'] = (id: string, entry: unknown, isHistory: boolean) => {
      if (live() && isTranscriptEntry(entry)) this.seen.push({ entry, isHistory });
      handleEntry(id, entry, isHistory);
    };
    this.app = { manager, statusLines, watchers };
    if (generation === 1) void statusLines.start();
  }

  private closeApp(stop: boolean): void {
    if (!this.app) return;
    this.app.manager.closeAll(stop);
    this.app.statusLines.close();
  }

  private runtime() {
    return this.sessionId ? this.app?.manager['runtimes'].get(this.sessionId) : undefined;
  }

  private hasConversation(): boolean {
    return this.seen.some((s) => s.entry.type === 'user') || (readOrNull(this.transcript())?.includes('"type":"user"') ?? false);
  }

  statusLineText(): string | null {
    return readOrNull(this.statusFile);
  }

  // アプリのチャットから送るのと同じく、session-manager の submit で送る（stream-json の user の行）
  async send(text: string): Promise<void> {
    await this.manager.submit(this.sessionId!, text);
  }

  // 起動して、Claude Code が受け付けられるようになるまで待つ（信頼していないフォルダでも確認は出ない。stream-json）
  async open(): Promise<void> {
    this.start();
    await this.untilState('起動', (state) => state !== 'starting');
  }

  // session-manager の状態が条件を満たすまで待つ。時間切れ・claude の終了は失敗にする
  async untilState(label: string, check: (state: SessionState | null) => boolean, timeoutMs = 20_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (this.sessionId && check(this.manager.stateOf(this.sessionId))) return;
      if (this.exited !== null) throw new Error(`${label}: claude が終了しました（${this.exited}）\n${this.stderr()}`);
      if (Date.now() > until) throw new Error(`${label}: 時間切れ（状態: ${this.sessionId ? this.manager.stateOf(this.sessionId) : 'なし'}）\n${this.stderr()}`);
      await sleep(POLL_MS);
    }
  }

  // claude の標準エラーの末尾（失敗したときの手がかり）
  stderr(): string {
    return (this.runtime()?.stderr ?? '').split('\n').slice(-20).join('\n');
  }

  // Claude Code が答えを待っている許可の確認・プランの承認（stream-json の can_use_tool。カードに出るもの）が来るまで待つ
  permission(label: string, timeoutMs = 20_000): Promise<PendingPermission> {
    return this.waitUntil(label, () => this.manager.pendingPermission(this.sessionId!), timeoutMs);
  }

  // カードのボタンと同じく、許可の確認に答える（session-manager の replyPermission）。もう待っていなければ失敗させる
  replyPermission(permission: PendingPermission, reply: PermissionReply): void {
    if (!this.manager.replyPermission(this.sessionId!, permission.id, reply)) throw new Error(`許可の確認（${permission.tool}）に答えられません。もう待っていません`);
  }

  // Claude Code が答えを待っている質問（AskUserQuestion。カードに出るもの）が来るまで待つ
  question(label: string, timeoutMs = 20_000): Promise<PendingQuestion> {
    return this.waitUntil(label, () => this.manager.pendingQuestion(this.sessionId!), timeoutMs);
  }

  // カードのボタンと同じく、質問に答える（session-manager の replyQuestion）。もう待っていなければ失敗させる
  replyQuestion(question: PendingQuestion, reply: QuestionReply): void {
    if (!this.manager.replyQuestion(this.sessionId!, question.id, reply)) throw new Error(`質問（${question.questions[0]?.question}）に答えられません。もう待っていません`);
  }

  // get が値を返すまで待つ。時間切れ・claude の終了は失敗にする
  async waitUntil<T>(label: string, get: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const value = get();
      if (value) return value;
      if (this.exited !== null) throw new Error(`${label}: claude が終了しました（${this.exited}）\n${this.stderr()}`);
      if (Date.now() > until) throw new Error(`${label}: 時間切れ（状態: ${this.sessionId ? this.manager.stateOf(this.sessionId) : 'なし'}）\n${this.stderr()}`);
      await sleep(POLL_MS);
    }
  }

  // claude（チャット）が標準出力に書いた stream-json の行。届いた順
  streamLines(): string[] {
    return this.host.stdoutLines;
  }

  // 会話ログ・statusLine・stream-json の行を dir に書き出す（互換性の確認の控え。TANACODE_RECORD=1 のとき）。
  // 会話ログは test/cli/basic.test.ts（チャット）が、statusLine は test/cli/terminal-mode.test.ts（-p では statusLine が動かないので、
  // ターミナルモードの TUI）が書く。files: 書くもの。
  // 使い捨てのフォルダのパスは、決まったパス（FIXTURE_ROOT）に置き換える。途中で失敗したときは、そこまでにできたものだけを書く
  record(dir: string, files: ('transcript.jsonl' | 'statusline.json' | 'stream.jsonl')[]): void {
    mkdirSync(dir, { recursive: true });
    const transcript = () => {
      const lines = readOrNull(this.transcript())
        ?.split('\n')
        .filter((line) => line && !DROPPED_ATTACHMENTS.includes((JSON.parse(line) as TranscriptEntry).attachment?.type as string));
      return lines?.length ? `${lines.join('\n')}\n` : null;
    };
    // stream-json の行は、書いている途中の文（stream_event）を除く（多く、アプリは進み具合にしか使わない）
    const stream = () => {
      const lines = this.streamLines().filter((line) => (JSON.parse(line) as { type?: string }).type !== 'stream_event');
      return lines.length ? `${lines.join('\n')}\n` : null;
    };
    const texts = { 'transcript.jsonl': transcript, 'statusline.json': () => this.statusLineText(), 'stream.jsonl': stream };
    for (const name of files) {
      const text = texts[name]();
      if (text) writeFileSync(join(dir, name), this.fixed(text));
    }
  }

  // 使い捨てのフォルダのパスを、決まったパスに置き換える。会話ログのフォルダ名（パスの英数字以外を - にしたもの）も置き換える
  private fixed(text: string): string {
    const dashed = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
    return text.replaceAll(this.root, FIXTURE_ROOT).replaceAll(dashed(this.root), dashed(FIXTURE_ROOT));
  }

  // claude を止めて、使い捨てのフォルダを消す。claude は終わるときにも設定の控えなどを書くので、
  // 終わるのを待ってからもう一度消す（待たずに呼んでも、すぐ一度は消す）
  async stop(): Promise<void> {
    this.closeApp(true);
    this.app = null;
    const gone = this.host.dispose();
    process.env.HOME = this.oldHome;
    const remove = () => rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    try {
      remove();
    } catch {
      // 終わろうとしている claude が書いている途中。終わってから消す
    }
    await gone;
    remove();
  }
}

// チャットのイベントを、画面（renderer の chatState）と同じく当てたあとに残るもの。
// process-start と reset（/clear などで乗り換えた）で空にし、replace（巻き戻し）で置き換える
export function shown(events: ChatEvent[]): ChatEvent[] {
  return events.reduce<ChatEvent[]>((list, e) => {
    if (e.type === 'process-start' || e.type === 'reset') return [];
    if (e.type === 'replace') return shown(e.events);
    return [...list, e];
  }, []);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// 会話ログのパスから、会話の ID
function idOf(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
