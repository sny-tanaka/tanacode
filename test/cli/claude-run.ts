import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Terminal } from '@xterm/headless';
import * as pty from 'node-pty';
import { ASK_FILE_ENV, isTranscriptEntry, type TranscriptEntry } from '@shared/chat';
import type { Activity, Menu, ScreenInfo, ScreenLine } from '@shared/screen';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import { BashTaskTracker } from '../../src/main/bash-task-tracker';
import { claudeArgs, transcriptPath } from '../../src/main/claude-session';
import { ScreenTracker } from '../../src/main/screen-tracker';
import { STATUS_FILE_ENV, parseStatusLine } from '../../src/main/statusline';
import { SubagentTracker } from '../../src/main/subagent-tracker';
import { TaskRouter } from '../../src/main/task-router';
import { TranscriptFollower } from '../../src/main/transcript-follower';
import { WorkflowTracker } from '../../src/main/workflow-tracker';
import { FIXTURE_ROOT, type ScreenName } from '../scenario';

// アプリと同じ端末の大きさ（Claude Code のタブを開いていないとき）
const COLS = 120;
const ROWS = 40;
// API キーでログインしたことにする（モックの API にしか送らない）
const API_KEY = 'sk-ant-api03-tanacode-cli-check-00000000000000000000';
// statusLine のファイルを見る間隔（アプリはファイルの変更の通知で読む）
const STATUS_POLL_MS = 200;

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

type Options = {
  // ユーザーの設定（~/.claude/settings.json）。hooks を足すのに使う
  settings?: Record<string, unknown>;
  // 作業フォルダに置いておくファイル（パス → 中身）
  files?: Record<string, string>;
};

// 本物の claude を pty で起動し、アプリと同じ部品で読む。
// - 画面: ScreenTracker
// - 会話ログ: TranscriptFollower（/clear で別の会話ログに移ったら、statusLine の transcript_path で追う）
// - バックグラウンドの作業と質問: TaskRouter と、ワークフロー・サブエージェント・Bash のトラッカー
// HOME は使い捨てのフォルダにするので、ふだんの ~/.claude には触らない
export class ClaudeRun {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-cli-')));
  readonly home = join(this.root, 'home');
  readonly cwd = join(this.root, 'work');
  readonly statusFile = join(this.root, 'status.json');
  readonly askFile = join(this.root, 'ask.json');
  // 今の会話の ID（/clear で変わる）
  claudeSessionId: string = randomUUID();
  readonly seen: Seen[] = [];
  // 乗り換えた会話ログ（/clear のあと）
  readonly switches: string[] = [];
  historyLoaded = false;
  readonly activities: (Activity | null)[] = [];
  workflowRuns: WorkflowRun[] = [];
  subagentRuns: SubagentRun[] = [];
  bashTasks: BashTask[] = [];
  // 画面は、起動のたびに作り直す（session-manager と同じ）
  screen = this.newScreen();
  private readonly screens = new Map<ScreenName, ScreenLine[]>();
  private term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  private readonly workflows = new WorkflowTracker((runs) => (this.workflowRuns = runs));
  private readonly subagents = new SubagentTracker(this.cwd, (runs) => (this.subagentRuns = runs));
  private readonly bash = new BashTaskTracker((tasks) => (this.bashTasks = tasks));
  private readonly tasks: TaskRouter;
  private proc: pty.IPty | null = null;
  private follower: TranscriptFollower | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private exited: number | null = null;
  private started = false;
  private readonly oldHome = process.env.HOME;

  constructor(
    private readonly baseUrl: string,
    options: Options = {},
  ) {
    mkdirSync(join(this.home, '.claude'), { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    // 最初の案内（テーマの選択）と API キーの確認は済んだことにする。フォルダの信頼の確認は、アプリでも出るのでそのまま
    writeFileSync(
      join(this.home, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] } }),
    );
    if (options.settings) writeFileSync(join(this.home, '.claude', 'settings.json'), JSON.stringify(options.settings));
    for (const [path, text] of Object.entries(options.files ?? {})) {
      mkdirSync(dirname(join(this.cwd, path)), { recursive: true });
      writeFileSync(join(this.cwd, path), text);
    }
    this.tasks = new TaskRouter({
      workflows: this.workflows,
      subagents: this.subagents,
      bashTasks: this.bash,
      screen: () => this.screen,
      sessionDir: () => this.sessionDir(),
    });
  }

  private newScreen(): ScreenTracker {
    return new ScreenTracker(COLS, ROWS, (data) => this.proc?.write(data), () => {}, false, (a) => this.activities.push(a));
  }

  get entries(): TranscriptEntry[] {
    return this.seen.map((s) => s.entry);
  }

  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある）
  sessionDir(): string {
    return join(dirname(this.transcript()), this.claudeSessionId);
  }

  transcript(): string {
    return transcriptPath(this.cwd, this.claudeSessionId);
  }

  // resume: 今の会話を --resume で再開する（アプリが止まっているセッションを開いたとき）
  start({ resume = false }: { resume?: boolean } = {}): void {
    // sessionSettings（ユーザーの statusLine を探す）と transcriptPath は homedir() を見るので、このプロセスの HOME も差し替える
    process.env.HOME = this.home;
    this.exited = null;
    if (this.started) {
      this.screen.dispose();
      this.term.dispose();
      this.screen = this.newScreen();
      this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    }
    this.started = true;
    const args = claudeArgs({
      claudeSessionId: this.claudeSessionId,
      resume,
      remoteControlName: null,
      model: null,
      effort: null,
      // 許可の確認を出させる（API キーでは既定が auto になり、確認が出ない）
      permissionMode: 'manual',
    });
    // 環境変数は最小限にする（Claude Code の中から動かしたときの子セッションの印などを持ち込まない）
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
      [STATUS_FILE_ENV]: this.statusFile,
      [ASK_FILE_ENV]: this.askFile,
    };
    const proc = pty.spawn(CLAUDE_BIN, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: this.cwd, env });
    this.proc = proc;
    proc.onData((data) => {
      this.term.write(data);
      this.screen.feed(data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.proc === proc) this.exited = exitCode;
    });
    // claude-session.ts と同じく、会話ログを追いかける
    this.follower = new TranscriptFollower(this.transcript(), {
      onEntry: (entry, isHistory) => this.onEntry(entry, isHistory),
      onHistoryLoaded: () => (this.historyLoaded = true),
      onSwitch: (file) => {
        this.switches.push(file);
        this.claudeSessionId = basename(file, '.jsonl');
      },
    });
    this.follower.start();
    // session-manager の statusLineChanged と同じく、statusLine の会話ログのパスを渡す
    this.statusTimer = setInterval(() => {
      const text = this.statusLineText();
      const path = text ? parseStatusLine(text, Date.now())?.transcriptPath : null;
      if (path) void this.follower?.offer(path);
    }, STATUS_POLL_MS);
  }

  // claude だけを止める（--resume で起動し直す前に）
  stopClaude(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.follower?.stop();
    this.follower = null;
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  // session-manager と同じく、会話ログの行をバックグラウンドの作業と質問に振り分ける
  private onEntry(entry: unknown, isHistory: boolean): void {
    if (!isTranscriptEntry(entry)) return;
    this.seen.push({ entry, isHistory });
    this.tasks.track(entry, isHistory, isHistory);
  }

  // フックが書いた AskUserQuestion の入力（statusline.ts の StatusLineWatcher と同じ読み方）
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
    this.proc?.write(text);
  }

  // 入力欄に打って送る。打った文字が入力欄に入ってから Enter を送る（スラッシュコマンドは補完が出るので少し長く待つ）
  async send(text: string): Promise<void> {
    this.type(text);
    await sleep(text.startsWith('/') ? 600 : 300);
    this.type('\r');
  }

  // 起動して、初めてのフォルダで出る信頼の確認に「Yes」で答え、入力欄が使えるようになるまで待つ
  async open(): Promise<void> {
    this.start();
    const trust = await this.waitFor('フォルダの信頼の確認', menuOf('other'));
    await this.answer(trust.title, trust.options.find((o) => /^Yes/.test(o.label))!.id);
    await this.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
  }

  // メニューで選ぶ。Claude Code は許可の確認を出した直後の入力を受け付けない（うっかり押しを防ぐ）ので、
  // 人が読んでから押すのと同じく少し待ち、メニューが閉じなければもう一度送る
  async answer(title: string, optionId: string): Promise<void> {
    const shown = () => {
      const state = this.screen.current.state;
      return state.kind === 'menu' && state.menu.title === title;
    };
    for (let attempt = 0; attempt < 3 && shown(); attempt++) {
      await sleep(800);
      await this.screen.choose(optionId, 'enter');
      await sleep(700);
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
      await sleep(100);
    }
  }

  // 今の画面を控えとして取っておく（ScreenTracker と同じ形の行）
  capture(name: ScreenName): void {
    this.screens.set(name, this.lines());
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
    for (const [name, lines] of this.screens) writeFileSync(join(dir, 'screens', `${name}.json`), this.fixed(`${JSON.stringify(lines, null, 1)}\n`));
  }

  // 使い捨てのフォルダのパスを、決まったパスに置き換える。会話ログのフォルダ名（パスの英数字以外を - にしたもの）も置き換える
  private fixed(text: string): string {
    const dashed = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
    return text.replaceAll(this.root, FIXTURE_ROOT).replaceAll(dashed(this.root), dashed(FIXTURE_ROOT));
  }

  private lines(): ScreenLine[] {
    const buf = this.term.buffer.active;
    const lines: ScreenLine[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push({ text: line?.translateToString(true) ?? '', full: !!line && (line.getCell(this.term.cols - 1)?.getChars() ?? '') !== '' });
    }
    return lines;
  }

  // 今の画面の文字（失敗したときの手がかり）
  dump(): string {
    const rows = this.lines().map((l) => l.text);
    return `---- 画面 ----\n${rows.join('\n').replace(/\n+$/, '')}\n--------------`;
  }

  stop(): void {
    this.stopClaude();
    this.workflows.dispose();
    this.subagents.dispose();
    this.bash.dispose();
    this.screen.dispose();
    this.term.dispose();
    process.env.HOME = this.oldHome;
    rmSync(this.root, { recursive: true, force: true });
  }
}

// waitFor に渡す、選択メニューが出るのを待つ条件
export const menuOf =
  (kind: Menu['kind'], title?: RegExp) =>
  (info: ScreenInfo): Menu | null =>
    info.state.kind === 'menu' && info.state.menu.kind === kind && (!title || title.test(info.state.menu.title)) ? info.state.menu : null;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
