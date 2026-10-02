import type { ChatEvent } from '@shared/chat';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type {
  BranchChanges,
  DirEntry,
  FileChange,
  GitState,
  ScreenChoice,
  SessionSummary,
  TanacodeApi,
  WorkspaceInfo,
} from '@shared/ipc';
import type { FileKnowledge } from '@shared/knowledge';
import type { ModelCatalog } from '@shared/models';
import type { Activity, ScreenInfo } from '@shared/screen';
import type { StatusLineInfo } from '@shared/statusline';
import type { SubagentRun } from '@shared/subagent';
import type { SystemStats } from '@shared/system';
import type { BashTask } from '@shared/task';
import type { UsageLimits } from '@shared/usage';
import type { WorkflowRun } from '@shared/workflow';

// README のデモ動画用の、アプリの API（window.tanacode）の作り物。
// 本物の Claude Code や git を動かさず、メモリに持ったファイル・会話・画面の状態を返す。
// 台本（scenarios/）がこの状態を書き換えると、画面へ通知が飛んでアプリがそのまま描き直す

type Listener<T> = (value: T) => void;

class Channel<T> {
  private readonly listeners = new Set<Listener<T>>();
  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T): void {
    for (const l of [...this.listeners]) l(value);
  }
}

export type DemoSession = {
  summary: SessionSummary;
  events: ChatEvent[];
  screen: ScreenInfo;
  activity: Activity | null;
  knowledge: Record<string, FileKnowledge>;
  contextTokens: number | null;
  statusLine: StatusLineInfo | null;
  workflows: WorkflowRun[];
  subagents: SubagentRun[];
  bash: BashTask[];
  // サブエージェント・ワークフローのエージェントの会話（キーは toolUseId か toolUseId:agentId）
  agentLogs: Record<string, ChatEvent[]>;
};

export type DemoProject = {
  root: string;
  name: string;
  branch: string;
  baseRef: string;
  // 今のファイル（フォルダからの相対パス → 中身）
  files: Record<string, string>;
  // ブランチの基点でのファイル。無いものは基点の後に作られた
  base: Record<string, string>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DemoBackend {
  readonly sessions = new Map<string, DemoSession>();
  // 台本が待つ、アプリからの入力（送った発言・選んだ選択肢）
  // images: 添付した画像の鍵（sessions.image で読める）。本文の中の画像のパスは [Image #n] に置き換えてある
  onUserMessage: (sessionId: string, text: string, images: string[]) => void = () => {};
  onChoose: (sessionId: string, choice: ScreenChoice) => void = () => {};
  // アプリで今見ているセッション（見ていないセッションの応答は「新しい応答」になる）
  focused: string | null = null;

  private readonly ch = {
    sessions: new Channel<SessionSummary[]>(),
    select: new Channel<string>(),
    chat: new Channel<{ sessionId: string; fromSeq: number; events: ChatEvent[]; live: boolean }>(),
    screen: new Channel<{ sessionId: string; info: ScreenInfo }>(),
    activity: new Channel<{ sessionId: string; activity: Activity | null }>(),
    workflows: new Channel<{ sessionId: string; runs: WorkflowRun[] }>(),
    subagents: new Channel<{ sessionId: string; runs: SubagentRun[] }>(),
    bash: new Channel<{ sessionId: string; tasks: BashTask[] }>(),
    usage: new Channel<UsageLimits>(),
    system: new Channel<SystemStats>(),
    statusLine: new Channel<{ sessionId: string; info: StatusLineInfo }>(),
    knowledge: new Channel<{ sessionId: string; knowledge: { files: Record<string, FileKnowledge>; contextTokens: number | null } }>(),
    files: new Channel<{ root: string; paths: string[] }>(),
  };
  private readonly typed = new Map<string, string>();
  // 添付した画像（保存したパス → data URL）
  private readonly images = new Map<string, string>();

  constructor(
    readonly project: DemoProject,
    private usage: UsageLimits,
    private readonly catalog: ModelCatalog,
  ) {}

  // ---- 台本から使う ----

  addSession(id: string, summary: Partial<SessionSummary> & { title: string }, events: ChatEvent[] = []): DemoSession {
    const now = Date.now();
    const session: DemoSession = {
      summary: {
        id,
        cwd: this.project.root,
        archived: false,
        createdAt: now,
        updatedAt: now,
        // Claude Code のプロセスが動いている（作業中かどうかではない）
        running: true,
        unread: false,
        attention: null,
        backgroundTasks: 0,
        model: null,
        effort: null,
        settingsFile: null,
        remoteControl: false,
        ...summary,
      },
      events: [{ type: 'process-start' }, { type: 'ready' }, ...events],
      screen: { state: { kind: 'prompt' }, model: 'Opus 5.5', effort: 'high', mode: 'manual', draft: '', ready: true },
      activity: null,
      knowledge: {},
      contextTokens: 18_000,
      statusLine: null,
      workflows: [],
      subagents: [],
      bash: [],
      agentLogs: {},
    };
    this.sessions.set(id, session);
    this.emitSessions();
    return session;
  }

  select(id: string): void {
    this.ch.select.emit(id);
  }

  push(id: string, ...events: ChatEvent[]): void {
    const s = this.session(id);
    const fromSeq = s.events.length;
    s.events.push(...events);
    this.ch.chat.emit({ sessionId: id, fromSeq, events, live: true });
    // 本物と同じく、会話が動いたとき（発言・応答・ツール）だけ一覧の先頭に上げる
    const active = events.some((e) => e.type === 'user' || e.type === 'assistant-text' || e.type === 'tool-use');
    this.update(id, active ? { updatedAt: Date.now() } : {});
  }

  update(id: string, patch: Partial<SessionSummary>): void {
    const s = this.session(id);
    s.summary = { ...s.summary, ...patch };
    this.emitSessions();
  }

  setScreen(id: string, patch: Partial<ScreenInfo>): void {
    const s = this.session(id);
    s.screen = { ...s.screen, ...patch };
    this.ch.screen.emit({ sessionId: id, info: s.screen });
  }

  setActivity(id: string, activity: Activity | null): void {
    this.session(id).activity = activity;
    this.ch.activity.emit({ sessionId: id, activity });
  }

  know(id: string, files: Record<string, FileKnowledge>, contextTokens?: number): void {
    const s = this.session(id);
    s.knowledge = { ...s.knowledge, ...files };
    if (contextTokens !== undefined) s.contextTokens = contextTokens;
    this.ch.knowledge.emit({ sessionId: id, knowledge: { files: s.knowledge, contextTokens: s.contextTokens } });
  }

  setStatusLine(id: string, info: StatusLineInfo): void {
    this.session(id).statusLine = info;
    this.ch.statusLine.emit({ sessionId: id, info });
  }

  setWorkflows(id: string, runs: WorkflowRun[]): void {
    this.session(id).workflows = runs;
    this.ch.workflows.emit({ sessionId: id, runs });
  }

  setSubagents(id: string, runs: SubagentRun[]): void {
    this.session(id).subagents = runs;
    this.ch.subagents.emit({ sessionId: id, runs });
  }

  setBash(id: string, tasks: BashTask[]): void {
    this.session(id).bash = tasks;
    this.ch.bash.emit({ sessionId: id, tasks });
  }

  setAgentLog(id: string, key: string, events: ChatEvent[]): void {
    this.session(id).agentLogs[key] = events;
  }

  // Claude がファイルを書き換えた
  writeFile(path: string, text: string): void {
    this.project.files[path] = text;
    this.ch.files.emit({ root: this.project.root, paths: [path] });
  }

  setUsage(usage: UsageLimits): void {
    this.usage = usage;
    this.ch.usage.emit(usage);
  }

  // ---- window.tanacode ----

  api(): TanacodeApi {
    const p = this.project;
    const s = (id: string) => this.session(id);
    const ok = <T>(value: T) => Promise.resolve(value);
    const info: WorkspaceInfo = { root: p.root, name: p.name, branch: p.branch };
    return {
      sessions: {
        list: () => ok(this.summaries()),
        create: () => ok(''),
        open: () => ok(undefined),
        archive: () => ok(undefined),
        unarchive: () => ok(undefined),
        focus: (id) => {
          this.focused = id;
          if (id && this.sessions.get(id)?.summary.unread) this.update(id, { unread: false });
        },
        snapshot: (id) => ok({ sessionId: id, fromSeq: 0, events: [...s(id).events] }),
        configure: () => ok(undefined),
        restart: () => ok(undefined),
        setRemoteControl: () => ok(null),
        remoteControlAvailable: () => ok(true),
        rename: () => ok(undefined),
        remove: () => ok(undefined),
        history: (id) => ok([...s(id).events]),
        image: (key) => ok(this.images.get(key) ?? null),
        discover: () => ok([]),
        import: () => ok(''),
        onChanged: (l) => this.ch.sessions.on(l),
        onSelect: (l) => this.ch.select.on(l),
        onNew: () => () => {},
        onChat: (l) => this.ch.chat.on(l),
      },
      screen: {
        get: (id) => ok(this.sessions.get(id)?.screen ?? null),
        choose: async (id, choice) => {
          await sleep(250);
          this.onChoose(id, choice);
        },
        setMode: () => ok(true),
        rewind: () => ok(false),
        onChanged: (l) => this.ch.screen.on(l),
        activity: (id) => ok(this.sessions.get(id)?.activity ?? null),
        onActivity: (l) => this.ch.activity.on(l),
      },
      workflows: { get: (id) => ok(s(id).workflows), onChanged: (l) => this.ch.workflows.on(l) },
      subagents: { get: (id) => ok(s(id).subagents), onChanged: (l) => this.ch.subagents.on(l) },
      usage: { get: () => ok(this.usage), refresh: () => ok(undefined), onChanged: (l) => this.ch.usage.on(l) },
      notifications: { get: () => ok(true), set: () => ok(undefined) },
      system: {
        onStats: (l) => {
          const tick = () =>
            l({ cpuPercent: 18 + Math.round(Math.random() * 10), memUsed: 21.4 * 2 ** 30, memTotal: 36 * 2 ** 30, topCpu: [], topMem: [] });
          tick();
          const timer = setInterval(tick, 2000);
          return () => clearInterval(timer);
        },
      },
      // 動画に警告が映らないよう、動作確認済のバージョンにする
      claudeVersion: { get: () => ok(VERIFIED_CLAUDE_CODE_VERSION), onChanged: () => () => {} },
      // デモ動画には新しいバージョンの印を映さない
      appUpdate: { get: () => ok(null), onChanged: () => () => {} },
      statusLine: { get: (id) => ok(this.sessions.get(id)?.statusLine ?? null), onChanged: (l) => this.ch.statusLine.on(l) },
      // デモ動画では設定ファイルを登録しない（選択欄は「標準」のまま）
      settingsFiles: {
        list: () => ok([]),
        pick: () => ok(null),
        add: () => Promise.reject(new Error('デモでは設定ファイルを登録できません')),
        rename: () => ok(undefined),
        remove: () => ok(undefined),
        onChanged: () => () => {},
      },
      models: { get: () => ok(this.catalog), refresh: () => ok({ catalog: this.catalog }) },
      knowledge: {
        get: (id) => ok({ files: s(id).knowledge, contextTokens: s(id).contextTokens }),
        onChanged: (l) => this.ch.knowledge.on(l),
      },
      tasks: {
        bash: (id) => ok(s(id).bash),
        onBashChanged: (l) => this.ch.bash.on(l),
        agentLog: (id, ref) => ok(s(id).agentLogs[ref.kind === 'workflow' ? `${ref.toolUseId}:${ref.agentId}` : ref.toolUseId] ?? []),
      },
      pty: {
        // 送った発言は、文字のあとに Enter（\r）で届く
        write: (id, data) => {
          if (data === '\r') {
            // 画像はパスを貼り付けて添付する（Claude Code は [Image #n] と出す）
            const images: string[] = [];
            const text = (this.typed.get(id) ?? '')
              .replace(/\x1b\[200~(\/tmp\/[^\x1b]+)\x1b\[201~ ?/g, (_m, path: string) => {
                images.push(path);
                return `[Image #${images.length}] `;
              })
              .replace(/\x1b\[200~|\x1b\[201~/g, '')
              .trim();
            this.typed.delete(id);
            if (text) this.onUserMessage(id, text, images);
            return;
          }
          if (data === '\x1b' || /^\x15+$/.test(data)) return;
          this.typed.set(id, (this.typed.get(id) ?? '') + data);
        },
        resize: () => {},
        resetSize: () => {},
        onData: () => () => {},
      },
      shell: {
        create: () => ok({ id: 'demo-shell', name: 'zsh' }),
        write: () => {},
        resize: () => {},
        kill: () => {},
        onData: () => () => {},
        onExit: () => () => {},
      },
      folders: {
        pick: () => ok(null),
        info: () => ok(info),
        listFiles: () => ok(Object.keys(p.files).sort()),
        commands: () => ok([]),
        open: () => ok('folder:demo'),
        close: () => {},
      },
      workspace: {
        info: () => ok(info),
        listDir: (_id, rel) => ok(this.listDir(rel)),
        readFile: (_id, rel) => ok(rel in p.files ? { kind: 'text' as const, text: p.files[rel] } : { kind: 'binary' as const }),
        readImage: () => ok(null),
        writeFile: (_id, rel, text) => {
          p.files[rel] = text;
          return ok(undefined);
        },
        onFilesChanged: (l) => this.ch.files.on(l),
        listFiles: () => ok(Object.keys(p.files).sort()),
        search: () => ok({ files: [], truncated: false }),
      },
      git: {
        state: () => ok(this.gitState()),
        branches: () => ok({ local: [p.branch, 'main'], remote: ['origin/main'], defaultBranch: 'main' }),
        run: () => ok(null),
        diffSides: (_id, rel) => ok({ original: p.base[rel] ?? '', modified: p.files[rel] ?? '' }),
        branchDiffSides: (_id, _base, rel) => ok({ original: p.base[rel] ?? '', modified: p.files[rel] ?? '' }),
        baseline: (_id, _base, rel) => ok({ exists: rel in p.base, text: p.base[rel] ?? '' }),
        lastCommitMessage: () => ok(''),
      },
      commands: { list: () => ok([]) },
      attachments: {
        save: (name, bytes) => {
          const path = `/tmp/${(this.images.size + 1).toString(16).padStart(8, '0')}-${name}`;
          let binary = '';
          bytes.forEach((b) => (binary += String.fromCharCode(b)));
          this.images.set(path, `data:image/png;base64,${btoa(binary)}`);
          return ok(path);
        },
      },
      browser: {
        attach: () => {},
        onOpen: () => () => {},
        onActivity: () => () => {},
        onViewport: () => () => {},
        hosts: () => ok([]),
        setHosts: (hosts) => ok(hosts),
        onHostsOpen: () => () => {},
      },
      pathForFile: () => '',
    };
  }

  private session(id: string): DemoSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`demo: unknown session ${id}`);
    return s;
  }

  private summaries(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private emitSessions(): void {
    this.ch.sessions.emit(this.summaries());
  }

  private listDir(rel: string): DirEntry[] {
    const prefix = rel ? `${rel}/` : '';
    const names = new Map<string, boolean>();
    for (const path of Object.keys(this.project.files)) {
      if (!path.startsWith(prefix)) continue;
      const [head, ...rest] = path.slice(prefix.length).split('/');
      names.set(head, (names.get(head) ?? false) || rest.length > 0);
    }
    return [...names.entries()]
      .map(([name, isDir]) => ({ name, path: prefix + name, isDir }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }

  // 基点から変わったファイル（行数は大まかに数える）
  private gitState(): GitState {
    const p = this.project;
    const files: Record<string, FileChange> = {};
    for (const path of new Set([...Object.keys(p.files), ...Object.keys(p.base)])) {
      const now = p.files[path];
      const before = p.base[path];
      if (now === before) continue;
      const a = new Set((before ?? '').split('\n'));
      const b = new Set((now ?? '').split('\n'));
      files[path] = {
        kind: before === undefined ? 'added' : now === undefined ? 'deleted' : 'modified',
        added: [...b].filter((l) => !a.has(l)).length,
        removed: [...a].filter((l) => !b.has(l)).length,
      };
    }
    const branchChanges: BranchChanges = { base: { ref: p.baseRef, mergeBase: 'demo-base', kind: 'branch' }, files };
    const entries = Object.entries(files).map(([path, c]) => ({ path, index: ' ', worktree: c.kind === 'added' ? '?' : 'M' }));
    return { isRepo: true, branch: p.branch, upstream: null, ahead: 0, behind: 0, empty: false, entries, branchChanges };
  }
}
