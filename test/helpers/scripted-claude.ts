import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatEvent } from '@shared/chat';
import type { ChatBatch, NewSessionOptions, SessionSummary } from '@shared/ipc';
import type { Activity, Menu, ScreenInfo } from '@shared/screen';
import type { StatusLineInfo } from '@shared/statusline';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import type { BrowserMcpLaunch } from '../../src/main/browser-bridge';
import { transcriptPath } from '../../src/main/claude-session';
import type { McpLaunch } from '../../src/main/mcp-bridge';
import type { PtyHandle, PtyHostApi } from '../../src/main/pty-host-client';
import type { HostedPtyInfo, SpawnRequest } from '../../src/main/pty-host-protocol';
import { DEFAULT_PTY_SIZE, SessionManager, type RunTask } from '../../src/main/session-manager';
import type { SettingsFiles } from '../../src/main/settings-files';
import { SessionStore } from '../../src/main/session-store';
import { StatusLineWatcher } from '../../src/main/statusline';
import { WorkspaceWatchers } from '../../src/main/workspace-watcher';
import type { ScreenName } from '../scenario';

// 本物の Claude Code から取った控え（test/recorded.test.ts と同じ）
const FIXTURES = join(__dirname, '..', 'fixtures', 'claude-code');

// 本物の claude を起動せずに、本物の SessionManager を動かす部品（npm test 用。速く、決まった結果になる）。
// pty ホストを、テストが画面の出力と終了を送る偽物（ScriptedHost）に差し替え、会話ログの行はテストが書き込む。
// 組み立て方は src/main/index.ts・test/cli/claude-run.ts と同じ（SessionStore・StatusLineWatcher・WorkspaceWatchers は本物）。
// 本物の Claude Code での振る舞いは npm run test:cli（test/cli）が確かめる。ここでは、その上の SessionManager の分岐を確かめる

// claude の代わりの pty。打たれたキー・大きさの変更・終了の頼みを控える
export class ScriptedPty implements PtyHandle {
  readonly writes: string[] = [];
  readonly resizes: [number, number][] = [];
  killed = false;
  detached = false;
  // 止めたら、すぐ終わる（終了を知らせる）。本物の claude は止めると終わる。ClaudeSession.stop は終わるのを待つ
  exitOnKill = false;
  // キーを受けたときの claude の反応（テストが決める。画面を描き直すなど）
  onWrite: ((data: string) => void) | null = null;
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((code: number) => void)[] = [];
  // まだ受け手がいない間に送った出力
  private early: string[] = [];

  constructor(
    readonly id: string,
    readonly request: Omit<SpawnRequest, 'id'>,
  ) {}

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
    const early = this.early;
    this.early = [];
    early.forEach(listener);
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener);
  }

  write(data: string): void {
    this.writes.push(data);
    this.onWrite?.(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed = true;
    if (this.exitOnKill) this.exit(0);
  }

  detach(): void {
    this.detached = true;
  }

  // claude が画面に描いた（端末への出力）
  output(data: string): void {
    if (this.dataListeners.length === 0) this.early.push(data);
    else this.dataListeners.forEach((l) => l(data));
  }

  // claude が終わった
  exit(code: number): void {
    this.exitListeners.forEach((l) => l(code));
  }

  // 打たれたキーをつなげたもの
  get typed(): string {
    return this.writes.join('');
  }

  // 起動の引数（--session-id・--resume の値など）
  arg(name: string): string | null {
    const i = this.request.args.indexOf(name);
    return i >= 0 ? (this.request.args[i + 1] ?? null) : null;
  }
}

// pty ホストの代わり。spawn した pty を控え、list で返すもの（引き継ぎ）はテストが決める
export class ScriptedHost implements PtyHostApi {
  readonly spawned: ScriptedPty[] = [];
  readonly attached: ScriptedPty[] = [];
  readonly forgotten: string[] = [];
  hosted: HostedPtyInfo[] = [];

  list(): Promise<HostedPtyInfo[]> {
    return Promise.resolve(this.hosted);
  }

  spawn(request: Omit<SpawnRequest, 'id'>): PtyHandle {
    const pty = new ScriptedPty(randomUUID(), request);
    this.spawned.push(pty);
    return pty;
  }

  attach(info: HostedPtyInfo): PtyHandle {
    const pty = new ScriptedPty(info.id, { tag: info.tag, file: 'claude', args: [], cwd: '', env: {}, cols: info.cols, rows: info.rows });
    this.attached.push(pty);
    return pty;
  }

  forget(id: string): void {
    this.forgotten.push(id);
  }
}

// 動作確認済みのバージョンの控えのうち、いちばん新しいものの画面（.ansi。ScreenTracker に流し込める形）
export function fixtureScreen(name: ScreenName): string {
  const versions = readdirSync(FIXTURES)
    .filter((v) => existsSync(join(FIXTURES, v, 'screens', `${name}.ansi`)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const version = versions.at(-1);
  if (!version) throw new Error(`控えに ${name} の画面がありません`);
  // 画面を消してから描く（前の画面の上に重ねない）
  return `\x1b[H\x1b[2J${readFileSync(join(FIXTURES, version, 'screens', `${name}.ansi`), 'utf8')}`;
}

export type Attention = { kind: 'menu'; menu: Menu } | { kind: 'unsupported' };

// SessionManager の、アプリが組み立てるときに渡す残りの引数（省けば SessionManager の既定）
export type ScriptedOptions = {
  remoteControlAvailable?: boolean;
  settingsFiles?: SettingsFiles | null;
  runTask?: RunTask;
  browser?: () => BrowserMcpLaunch | null;
  sessionsMcp?: () => McpLaunch | null;
  checklistMcp?: () => McpLaunch | null;
  walkthroughMcp?: () => McpLaunch | null;
};

// SessionManager と、それが配信したもの
export class ScriptedApp {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-scripted-')));
  readonly home = join(this.root, 'home');
  readonly cwd = join(this.root, 'work');
  readonly userData = join(this.root, 'userData');
  readonly host = new ScriptedHost();
  readonly chat = new Map<string, ChatEvent[]>();
  readonly batches: ChatBatch[] = [];
  readonly attentions: { id: string; attention: Attention }[] = [];
  readonly turnsCompleted: SessionSummary[] = [];
  readonly screens = new Map<string, ScreenInfo>();
  readonly activities = new Map<string, Activity | null>();
  readonly bashTasks = new Map<string, BashTask[]>();
  readonly workflows = new Map<string, WorkflowRun[]>();
  readonly subagents = new Map<string, SubagentRun[]>();
  readonly statusLineInfos = new Map<string, StatusLineInfo>();
  sessions: SessionSummary[] = [];
  // 一覧を知らせるたびの中身（途中の「準備中」なども見られるように）
  readonly sessionLists: SessionSummary[][] = [];
  readonly manager: SessionManager;
  readonly statusLines: StatusLineWatcher;
  private readonly oldHome = process.env.HOME;

  constructor(options: ScriptedOptions = {}) {
    mkdirSync(join(this.home, '.claude'), { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    // 会話ログのパス（transcriptPath）とユーザーの statusLine（sessionSettings）は homedir() を見る
    process.env.HOME = this.home;
    const statusDir = join(this.userData, 'statusline');
    mkdirSync(statusDir, { recursive: true });
    this.statusLines = new StatusLineWatcher(
      statusDir,
      (id, info) => this.manager.statusLineChanged(id, info),
      (id, input) => this.manager.askQuestionsChanged(id, input),
    );
    this.manager = new SessionManager(
      this.host,
      new SessionStore(join(this.userData, 'sessions.json')),
      new WorkspaceWatchers(() => {}),
      this.statusLines,
      {
        onSessionsChanged: (sessions) => {
          this.sessions = sessions;
          this.sessionLists.push(sessions);
        },
        onChat: (sent) => {
          // アプリの IPC と同じく、送った時点の中身を写して受け取る
          const batch = structuredClone(sent);
          this.batches.push(batch);
          this.chat.set(batch.sessionId, [...(this.chat.get(batch.sessionId) ?? []), ...batch.events]);
        },
        onPtyData: () => {},
        onTurnCompleted: (session) => this.turnsCompleted.push(session),
        onScreen: (id, info) => this.screens.set(id, info),
        onActivity: (id, activity) => this.activities.set(id, activity),
        onWorkflows: (id, runs) => this.workflows.set(id, runs),
        onSubagents: (id, runs) => this.subagents.set(id, runs),
        onBashTasks: (id, tasks) => this.bashTasks.set(id, tasks),
        onKnowledge: () => {},
        onStatusLine: (id, info) => this.statusLineInfos.set(id, info),
        onAttention: (session, attention) => this.attentions.push({ id: session.id, attention }),
      },
      options.remoteControlAvailable,
      options.settingsFiles,
      options.runTask,
      options.browser,
      options.sessionsMcp,
      options.checklistMcp,
      options.walkthroughMcp,
    );
  }

  // 新しいセッションを作る（Claude Code を起動する）。起動した pty を返す
  create(options: Partial<NewSessionOptions> = {}, parentId: string | null = null): { id: string; pty: ScriptedPty } {
    const id = this.manager.create(
      this.cwd,
      { model: null, effort: null, settingsFile: null, mode: null, remoteControl: false, worktree: false, ...options },
      parentId,
    );
    return { id, pty: this.pty(id) };
  }

  // そのセッションでいちばん新しく起動した pty
  pty(id: string): ScriptedPty {
    const pty = [...this.host.spawned].reverse().find((p) => p.request.tag === id);
    if (!pty) throw new Error(`${id} の pty がありません`);
    return pty;
  }

  // 入力欄が出て、入力を受け付けられる画面にする
  ready(id: string): Promise<void> {
    this.pty(id).output(fixtureScreen('prompt'));
    return this.waitFor('入力欄', () => this.manager.summary(id)?.running === true && this.screens.get(id)?.state.kind === 'prompt' && this.screens.get(id)?.ready === true);
  }

  // 入力欄の下の権限モードの表示（例: 「⏵⏵ auto mode on」）を書き換える。画面の文字は claude が描くので、偽ることもできる
  showMode(id: string, text: string): void {
    this.pty(id).output(`\x1b[${DEFAULT_PTY_SIZE.rows};1H\x1b[2K  ${text}`);
  }

  // そのセッションの会話ログ（今の claude の --session-id か --resume の会話）
  transcript(id: string): string {
    const pty = this.pty(id);
    const claudeId = pty.arg('--session-id') ?? pty.arg('--resume');
    if (!claudeId) throw new Error('会話の ID が起動の引数にありません');
    return transcriptPath(this.cwd, claudeId);
  }

  // 会話ログに行を書き足す（claude が書いたことにする）
  append(id: string, ...entries: Record<string, unknown>[]): void {
    const file = this.transcript(id);
    mkdirSync(dirname(file), { recursive: true });
    const claudeId = this.pty(id).arg('--session-id') ?? this.pty(id).arg('--resume');
    appendFileSync(file, entries.map((e) => JSON.stringify({ sessionId: claudeId, cwd: this.cwd, ...e })).join('\n') + '\n');
  }

  events(id: string): ChatEvent[] {
    return this.chat.get(id) ?? [];
  }

  async waitFor(label: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > until) throw new Error(`${label}: 時間切れ`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  dispose(): void {
    this.manager.closeAll(true);
    process.env.HOME = this.oldHome;
    rmSync(this.root, { recursive: true, force: true });
  }
}

// 会話ログの行（Claude Code が書く形のうち、アプリが読むところ）。timestamp は今（起動より後の行は、今動いている claude が書いたもの）
let seq = 0;
const base = () => ({ uuid: randomUUID(), timestamp: new Date(Date.now() + seq++).toISOString(), isSidechain: false, userType: 'external' });

export const line = {
  user: (text: string) => ({ ...base(), type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' } }),
  text: (text: string) => ({ ...base(), type: 'assistant', message: { id: `msg_${seq}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } }),
  toolUse: (id: string, name: string, input: Record<string, unknown>) => ({
    ...base(),
    type: 'assistant',
    message: { id: `msg_${seq}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] },
  }),
  toolResult: (id: string, content: string, extra: Record<string, unknown> = {}) => ({
    ...base(),
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ...extra,
  }),
  turnEnd: () => ({ ...base(), type: 'system', subtype: 'turn_duration', durationMs: 100 }),
};
