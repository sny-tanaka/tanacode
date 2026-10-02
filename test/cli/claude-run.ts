import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ASK_FILE_ENV, isTranscriptEntry, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import type { ChatBatch, SessionSummary } from '@shared/ipc';
import type { SessionKnowledge } from '@shared/knowledge';
import type { Activity, Menu, ScreenInfo, ScreenLine } from '@shared/screen';
import type { StatusLineInfo } from '@shared/statusline';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import { transcriptPath } from '../../src/main/claude-session';
import { ScreenTracker } from '../../src/main/screen-tracker';
import { DEFAULT_PTY_SIZE, SessionManager } from '../../src/main/session-manager';
import { SessionStore } from '../../src/main/session-store';
import { STATUS_FILE_ENV, StatusLineWatcher } from '../../src/main/statusline';
import { WorkspaceWatchers } from '../../src/main/workspace-watcher';
import { FIXTURE_ROOT, type ScreenName } from '../scenario';
import { FakePtyHost } from './fake-pty-host';

// API キーでログインしたことにする（モックの API にしか送らない）
const API_KEY = 'sk-ant-api03-tanacode-cli-check-00000000000000000000';
// 状態を待つときに見直す間隔
const POLL_MS = 50;
// Claude Code は、許可の確認などのメニューを出した直後の入力を受け付けないことがある（うっかり押しを防ぐ）。
// 人が読んでから押すのと同じく、メニューが出てからこれだけたつまでは選ばない。
// 足りなくても、メニューが閉じなければもう一度送る（MENU_CLOSE_MS）
const MENU_GUARD_MS = 300;
// 選んだあと、メニューが閉じるのを待つ時間。閉じなければもう一度送る
const MENU_CLOSE_MS = 1500;
// 打った文字が入力欄に出るのを待つ時間。出なくても Enter は送る（そのあとの確かめで失敗する）
const DRAFT_MS = 3000;
// 入力欄でないところに打ったとき、Enter を送るまで待つ時間（打った文字を画面から読めないので、決まった時間だけ待つ）
const OTHER_INPUT_MS = 300;

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

// 選択メニューが出た・操作できない画面が出たときの、session-manager の知らせ（アプリはこれで通知を出す）
export type Attention = { kind: 'menu'; menu: Menu } | { kind: 'unsupported' };

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
  // 作業フォルダを git のリポジトリにする（files をはじめのコミットにする）。claude --worktree の確認に使う
  git?: boolean;
  // フォルダの信頼の確認を済ませておく（claude --worktree は、信頼していないフォルダでは始まらない）
  trusted?: boolean;
};

// 本物の claude を、アプリと同じ SessionManager で動かして読む。src/main/index.ts と同じ組み立て方で、
// pty ホストだけを node-pty を直に使う偽物（FakePtyHost）に、userData を使い捨てのフォルダに差し替える（electron には頼らない）。
// - 画面: ScreenTracker（session-manager が起動ごとに作るもの）
// - 会話ログ: ClaudeSession の TranscriptFollower から session-manager の行の処理（handleEntry）へ。
//   チャットのイベント（巻き戻しの replace・順番待ちの queue を含む）は、session-manager が配信したものを chatEvents に控える
// - バックグラウンドの作業と質問: session-manager の TaskRouter と各トラッカー
// - statusLine と AskUserQuestion のフック: StatusLineWatcher（<dir>/<id>.json・<id>.ask.json）
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
  // 起動前に返す、何も映っていない画面
  private readonly blank = new ScreenTracker(DEFAULT_PTY_SIZE.cols, DEFAULT_PTY_SIZE.rows, () => {}, () => {});
  private readonly screens = new Map<ScreenName, { lines: ScreenLine[]; serialized: string }>();
  // 今出ている選択メニューの見出しと、出た時刻。menusClosed: メニューが閉じた（別の画面になった）回数
  private menuShown: { title: string; at: number } | null = null;
  private menusClosed = 0;
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
      git('add', '-A');
      git('commit', '-qm', 'init', '--allow-empty');
    }
    // 環境変数は最小限にする（Claude Code の中から動かしたときの子セッションの印などを持ち込まない）。
    // アプリが付ける statusLine・AskUserQuestion のファイルの変数だけは、session-manager が渡すものを使う
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
    this.host = new FakePtyHost(CLAUDE_BIN, env, [STATUS_FILE_ENV, ASK_FILE_ENV]);
  }

  // 今の画面（起動のたびに session-manager が作り直す）
  get screen(): ScreenTracker {
    return this.runtime()?.screen ?? this.blank;
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

  // 順番待ちの発言（session-manager が最後に配信した 'queue' のイベント）
  get queue(): string[] {
    const last = [...this.chatEvents].reverse().find((e) => e.type === 'queue');
    return last?.type === 'queue' ? last.prompts : [];
  }

  // statusLine と AskUserQuestion のフックが書くファイル（StatusLineWatcher の <dir>/<id>.json・<id>.ask.json）
  get statusFile(): string {
    return join(this.userData, 'statusline', `${this.sessionId ?? 'none'}.json`);
  }

  get askFile(): string {
    return join(this.userData, 'statusline', `${this.sessionId ?? 'none'}.ask.json`);
  }

  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある）
  sessionDir(): string {
    return join(dirname(this.transcript()), this.claudeSessionId);
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
      this.sessionId = manager.create(this.cwd, { model: this.options.model ?? null, effort: this.options.effort ?? null, settingsFile: null, mode: 'manual', remoteControl: false, worktree: false });
      return;
    }
    if (this.runtime()?.process) throw new Error('claude が動いています（stopClaude で止めてから start します）');
    // 止まっているセッションを開くのと同じく、会話があれば --resume で再開する（session-manager の start が決める）。
    // 権限モードは、はじめの起動と同じく manual にする（open では既定のままになる）
    if (resume && !this.hasConversation()) throw new Error('再開する会話がまだありません');
    manager['start'](this.sessionId, 'manual');
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
    this.menuShown = null;
    await this.manager.open(this.sessionId!);
  }

  // 同じフォルダで新しいセッションを作って起動する（アプリの新規セッションと同じ）。今の claude は止める
  newSession(): void {
    this.stopClaude();
    this.sessionId = null;
    this.exited = null;
    this.menuShown = null;
    this.start();
  }

  // claude だけを止める（--resume で起動し直す前に）。claude が自分で終わったのと同じく、session-manager の onExit を通る
  stopClaude(): void {
    if (this.sessionId) this.host.terminate(this.sessionId);
  }

  // アプリを終了して起動し直す（claude は止めない）。新しい SessionManager が、動いている claude を引き継ぐ（adopt）。
  // whileClosed: アプリを止めている間にすること（typeWithoutApp で claude に直に打つなど）
  async restartApp(whileClosed?: () => Promise<void>): Promise<void> {
    process.env.HOME = this.home;
    this.closeApp(false);
    await whileClosed?.();
    this.exited = null;
    this.menuShown = null;
    this.launchApp();
    await this.app!.statusLines.start();
    await this.manager.adopt();
  }

  // アプリを止めている間の操作として、claude に直に打つ
  typeWithoutApp(text: string): void {
    if (this.sessionId) this.host.write(this.sessionId, text);
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
      (id, input) => live() && manager.askQuestionsChanged(id, input),
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
        onPtyData: () => {},
        onTurnCompleted: (session) => live() && this.turnsCompleted.push(session),
        onScreen: (id, info) => ours(id) && this.noteScreen(info),
        onActivity: (id, activity) => ours(id) && this.activities.push(activity),
        onWorkflows: (id, runs) => ours(id) && (this.workflowRuns = runs),
        onSubagents: (id, runs) => ours(id) && (this.subagentRuns = runs),
        onBashTasks: (id, tasks) => ours(id) && (this.bashTasks = tasks),
        onKnowledge: (id, knowledge) => ours(id) && (this.knowledge = knowledge),
        onStatusLine: (id, info) => ours(id) && (this.statusLine = info),
        onAttention: (session, attention) => ours(session.id) && this.attentions.push(attention),
      },
      // 開発版と同じく Remote Control は使わない（claude.ai へのログインが要る）
      false,
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

  // 選択メニューが出た時刻と、閉じた回数を数える
  private noteScreen(info: ScreenInfo): void {
    const title = info.state.kind === 'menu' ? info.state.menu.title : null;
    if (this.menuShown && this.menuShown.title !== title) this.menusClosed++;
    if (title === null) this.menuShown = null;
    else if (this.menuShown?.title !== title) this.menuShown = { title, at: Date.now() };
  }

  // フックが書いた AskUserQuestion の入力（StatusLineWatcher が読むファイル）
  askInput(): unknown {
    try {
      return (JSON.parse(readFileSync(this.askFile, 'utf8')) as { tool_input?: unknown }).tool_input;
    } catch {
      return null;
    }
  }

  statusLineText(): string | null {
    return readOrNull(this.statusFile);
  }

  type(text: string): void {
    if (this.sessionId) this.app?.manager.write(this.sessionId, text);
  }

  // 入力欄に打って送る。決まった時間だけ待つのではなく、打った文字が入力欄に出たのを画面で確かめてから Enter を送る。
  // スラッシュコマンドは、補完の候補にそのコマンドが出るのも待つ（候補を出している途中の Enter は、送信にならないことがある）。
  // 入力欄でないところ（質問の「その他」の欄など）に打つときは、画面から打った文字を読めないので、少しだけ待つ
  async send(text: string): Promise<void> {
    const prompt = this.screen.current.state.kind === 'prompt';
    this.type(text);
    if (!prompt) {
      await sleep(OTHER_INPUT_MS);
      this.type('\r');
      return;
    }
    const typed = squash(text);
    const command = text.startsWith('/') ? text.split(/\s/)[0] : null;
    await this.until(
      () =>
        this.screen.current.state.kind === 'prompt' &&
        squash(this.screen.current.draft).endsWith(typed) &&
        (!command || this.lines().some((line) => line.text.trimStart().startsWith(command) && !line.text.includes('❯'))),
      DRAFT_MS,
    );
    this.type('\r');
  }

  // 起動して、初めてのフォルダで出る信頼の確認に「Yes」で答え、入力欄が使えるようになるまで待つ
  async open(): Promise<void> {
    this.start();
    const trust = await this.waitFor('フォルダの信頼の確認', menuOf('other'));
    await this.answer(trust.title, trust.options.find((o) => /^Yes/.test(o.label))!.id);
    await this.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
  }

  // メニューで選ぶ（アプリと同じく session-manager の choose で）。メニューが閉じなければもう一度送る
  async answer(title: string, optionId: string): Promise<void> {
    const shown = () => {
      const state = this.screen.current.state;
      return state.kind === 'menu' && state.menu.title === title;
    };
    for (let attempt = 0; attempt < 3 && shown(); attempt++) {
      // 出た直後の入力は受け付けられないので、出てから MENU_GUARD_MS たつまで待つ（人が読んでから押すのと同じ）
      const since = this.menuShown?.title === title ? this.menuShown.at : Date.now();
      await sleep(since + MENU_GUARD_MS - Date.now());
      const closed = this.menusClosed;
      await this.manager.choose(this.sessionId!, { optionId, key: 'enter' });
      await this.until(() => this.menusClosed > closed, MENU_CLOSE_MS);
    }
    if (shown()) throw new Error(`「${title}」で選んでもメニューが閉じません\n${this.dump()}`);
  }

  // 条件が満たされるまで待つ。時間切れのときは、そのときの画面を付けて失敗させる
  async waitFor<T>(label: string, check: (info: ScreenInfo) => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const value = check(this.screen.current);
      if (value) return value;
      if (this.exited !== null) throw new Error(`${label}: claude が終了しました（${this.exited}）\n${this.dump()}`);
      if (Date.now() > until) throw new Error(`${label}: 時間切れ\n状態: ${JSON.stringify(this.screen.current)}\n${this.dump()}`);
      await sleep(POLL_MS);
    }
  }

  // 条件が満たされるか、時間がたつまで待つ（満たされなくても失敗にしない）
  private async until(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > until || this.exited !== null) return false;
      await sleep(POLL_MS);
    }
    return true;
  }

  // 今の画面を控えとして取っておく。ScreenTracker と同じ形の行と、文字の属性ごとの書き出し（書きかけの読み取りは、薄い字を見分ける）
  capture(name: ScreenName): void {
    this.screens.set(name, { lines: this.lines(), serialized: (this.sessionId && this.host.serialized(this.sessionId)) || '' });
  }

  // 取っておいた画面と、会話ログ・statusLine・フックが書いた質問を dir に書き出す。
  // 使い捨てのフォルダのパスは、決まったパス（FIXTURE_ROOT）に置き換える。
  // 途中で失敗したときは、そこまでにできたものだけを書く（失敗の手がかりにする）
  record(dir: string): void {
    this.recordScreens(dir);
    const transcript = readOrNull(this.transcript())
      ?.split('\n')
      .filter((line) => line && !DROPPED_ATTACHMENTS.includes((JSON.parse(line) as TranscriptEntry).attachment?.type as string))
      .join('\n');
    const files = { 'transcript.jsonl': transcript && `${transcript}\n`, 'statusline.json': this.statusLineText(), 'ask.json': readOrNull(this.askFile) };
    for (const [name, text] of Object.entries(files)) if (text) writeFileSync(join(dir, name), this.fixed(text));
  }

  // 取っておいた画面だけを書き出す（基本の台本でない台本は、画面だけを控えに残す）
  recordScreens(dir: string): void {
    mkdirSync(join(dir, 'screens'), { recursive: true });
    for (const [name, { lines, serialized }] of this.screens) {
      writeFileSync(join(dir, 'screens', `${name}.json`), this.fixed(`${JSON.stringify(lines, null, 1)}\n`));
      writeFileSync(join(dir, 'screens', `${name}.ansi`), this.fixed(serialized));
    }
  }

  // 使い捨てのフォルダのパスを、決まったパスに置き換える。会話ログのフォルダ名（パスの英数字以外を - にしたもの）も置き換える
  private fixed(text: string): string {
    const dashed = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
    return text.replaceAll(this.root, FIXTURE_ROOT).replaceAll(dashed(this.root), dashed(FIXTURE_ROOT));
  }

  // 今の claude の画面（pty ホストの仮想の端末から）
  lines(): ScreenLine[] {
    return (this.sessionId && this.host.lines(this.sessionId)) || [];
  }

  // 今の画面の文字（失敗したときの手がかり）
  dump(): string {
    const rows = this.lines().map((l) => l.text);
    return `---- 画面 ----\n${rows.join('\n').replace(/\n+$/, '')}\n--------------`;
  }

  // claude を止めて、使い捨てのフォルダを消す。claude は終わるときにも設定の控えなどを書くので、
  // 終わるのを待ってからもう一度消す（待たずに呼んでも、すぐ一度は消す）
  async stop(): Promise<void> {
    this.closeApp(true);
    this.app = null;
    const gone = this.host.dispose();
    this.blank.dispose();
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

// waitFor に渡す、選択メニューが出るのを待つ条件
export const menuOf =
  (kind: Menu['kind'], title?: RegExp) =>
  (info: ScreenInfo): Menu | null =>
    info.state.kind === 'menu' && info.state.menu.kind === kind && (!title || title.test(info.state.menu.title)) ? info.state.menu : null;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// 空白を除く（入力欄の折り返しや字下げと比べるため）
function squash(text: string): string {
  return text.replace(/\s+/g, '');
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
