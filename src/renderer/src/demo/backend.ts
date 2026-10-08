import type { ChatEvent } from '@shared/chat';
import { unreadCount, type ChecklistOp, type SessionChecklists } from '@shared/checklist';
import { ChecklistBook } from '@shared/checklist-book';
import { noticeMessage, replyNoticeText } from '@shared/checklist-tools';
import type { AppUpdate } from '@shared/app-update';
import type { ContextItem } from '@shared/context';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type {
  BrowserActivity,
  BrowserAnswer,
  BrowserAskChange,
  BrowserOpenRequest,
  BranchChanges,
  DirEntry,
  DiscoveredSession,
  FileChange,
  GitState,
  ScreenChoice,
  SessionSummary,
  NewSessionOptions,
  ShellData,
  ShellExit,
  ShellOpened,
  TanacodeApi,
  WorkspaceInfo,
} from '@shared/ipc';
import type { FileKnowledge } from '@shared/knowledge';
import type { ModelCatalog } from '@shared/models';
import type { Activity, ScreenInfo } from '@shared/screen';
import type { StatusLineInfo } from '@shared/statusline';
import type { SubagentRun } from '@shared/subagent';
import type { SystemStats } from '@shared/system';
import type { BashTask, TaskRef } from '@shared/task';
import type { UsageLimits } from '@shared/usage';
import type { WorkflowRun } from '@shared/workflow';

// デモのサイトと Storybook の紹介画像用の、アプリの API（window.tanacode）の作り物。
// 本物の Claude Code や git を動かさず、メモリに持ったファイル・会話・画面の状態を返す。
// 台本（story/）がこの状態を書き換えると、画面へ通知が飛んでアプリがそのまま描き直す

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
  // コンテキストの中身（サイドパネルの「コンテキスト」）
  context: ContextItem[];
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
  // アプリ内ブラウザの「あなたの番です」への返事・タスクの「止める」・ターミナルへの入力・作業の書き出し
  onBrowserAnswer: (sessionId: string, askId: string, answer: BrowserAnswer) => void = () => {};
  onStopTask: (sessionId: string, ref: TaskRef) => void = () => {};
  onShellWrite: (id: string, data: string) => void = () => {};
  onExport: (html: string, fileName: string) => void = () => {};
  onCreate: (cwd: string, options: NewSessionOptions) => string = () => '';
  // 「既存の会話を開く…」で選んだ会話を取り込み、セッションの ID を返す
  onImport: (session: DiscoveredSession) => string = () => '';
  // 「既存の会話を開く…」に出す、アプリの外（ターミナル）で作った会話
  discovered: DiscoveredSession[] = [];
  // 翻訳の対訳（原文の行 → 訳文）。null なら翻訳のボタンを出さない
  translations: Record<string, string> | null = null;
  // 入っている Claude Code のバージョンと、tanacode の新しいバージョン（null は、まだ分からない）
  private claudeVersion = VERIFIED_CLAUDE_CODE_VERSION;
  private appUpdate: AppUpdate | null = null;
  private notificationsOn = true;
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
    browserActivity: new Channel<BrowserActivity>(),
    browserOpen: new Channel<BrowserOpenRequest>(),
    browserAsk: new Channel<BrowserAskChange>(),
    shellData: new Channel<ShellData>(),
    shellOpened: new Channel<ShellOpened>(),
    shellExit: new Channel<ShellExit>(),
    claudeVersion: new Channel<string | null>(),
    appUpdate: new Channel<AppUpdate | null>(),
    checklist: new Channel<SessionChecklists>(),
  };
  // チェックリスト。書き換えはアプリと同じもの（ChecklistBook）を使う。画面には写しを送る（同じ配列のままだと描き直されない）。
  // 台本の Claude も、MCP のツールの代わりにこれを書き換える
  readonly checklists = new ChecklistBook((sessionId, lists) => this.ch.checklist.emit({ sessionId, lists: structuredClone(lists) }));
  // 人がスレッドに「Claude に通知する」で返信した（台本が待つ）。notice: アプリが Claude に送るのと同じ知らせ
  onChecklistNotify: (sessionId: string, notice: Extract<ChatEvent, { type: 'notice' }>) => void = () => {};
  private notices = 0;
  // 頼んでいる「あなたの番です」（セッション → 依頼）
  private readonly asks = new Map<string, BrowserAskChange>();
  private shells = 0;
  private readonly typed = new Map<string, string>();
  // 添付した画像（保存したパス → data URL）
  private readonly images = new Map<string, string>();

  constructor(
    readonly project: DemoProject,
    private usage: UsageLimits,
    private readonly catalog: ModelCatalog,
  ) {}

  // ---- 台本から使う ----

  // ready: Claude Code の起動が終わっている（false なら、台本があとで push(id, { type: 'ready' }) する。それまで最初の発言は預かりになる）
  addSession(id: string, summary: Partial<SessionSummary> & { title: string | null }, events: ChatEvent[] = [], { ready = true }: { ready?: boolean } = {}): DemoSession {
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
        worktree: null,
        ...summary,
      },
      events: ready ? [{ type: 'process-start' }, { type: 'ready' }, ...events] : [{ type: 'process-start' }, ...events],
      screen: { state: { kind: 'prompt' }, model: 'Opus 5.5', effort: 'high', mode: 'manual', draft: '', ready: true },
      activity: null,
      knowledge: {},
      contextTokens: 18_000,
      statusLine: null,
      workflows: [],
      subagents: [],
      bash: [],
      agentLogs: {},
      context: [],
    };
    this.sessions.set(id, session);
    this.emitSessions();
    return session;
  }

  // スレッドへの返信の知らせ（アプリが Claude に送り、チャットに「Claude への知らせ」として出るもの）
  private notifyReply(sessionId: string, op: Extract<ChecklistOp, { type: 'card-reply' }>): void {
    const list = this.checklists.lists(sessionId).find((l) => l.id === op.listId);
    const card = list?.cards.find((c) => c.id === op.cardId);
    if (!list || !card) return;
    this.notices += 1;
    this.onChecklistNotify(sessionId, {
      type: 'notice',
      id: `checklist-notice-${this.notices}`,
      text: noticeMessage([replyNoticeText(list.name, card.number, card.title, op.text)]),
      cards: [{ listId: list.id, cardId: card.id }],
    });
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

  // 入っている Claude Code が変わった（ステータスバーのバージョンの印が変わる）
  setClaudeVersion(version: string): void {
    this.claudeVersion = version;
    this.ch.claudeVersion.emit(version);
  }

  // tanacode の新しいバージョンを確かめた（タイトルバーのバージョンの横の印が変わる）
  setAppUpdate(update: AppUpdate | null): void {
    this.appUpdate = update;
    this.ch.appUpdate.emit(update);
  }

  // Claude がファイルを書き換えた
  writeFile(path: string, text: string): void {
    this.project.files[path] = text;
    // worktree のセッションは別のフォルダで開いているので、セッションのフォルダごとに知らせる（開いているファイルを読み直させる）
    const roots = new Set([this.project.root, ...[...this.sessions.values()].map((s) => s.summary.cwd)]);
    for (const root of roots) this.ch.files.emit({ root, paths: [path] });
  }

  setContext(id: string, items: ContextItem[]): void {
    this.session(id).context = items;
    // 画面は、会話かファイルの知らせで読み直す
    this.know(id, {});
  }

  // ツールの結果などに出す画像を登録する（鍵は sessions.image で読める。画面が鍵ごとに覚えるので、使い回さない）
  addImage(key: string, dataUrl: string): void {
    this.images.set(key, dataUrl);
  }

  // Claude によるアプリ内ブラウザの操作（「Claude が操作中」の帯と、押す要素の枠。box はページの中の位置）
  browserActivity(activity: BrowserActivity): void {
    this.ch.browserActivity.emit(activity);
  }

  // Claude がアプリ内ブラウザでページを開く（タブが無ければ作る）
  browserOpen(sessionId: string, url: string): void {
    this.ch.browserOpen.emit({ sessionId, url });
  }

  // Claude があなたに操作を頼む（null で取り下げる）
  browserAsk(sessionId: string, ask: BrowserAskChange['ask']): void {
    const change = { sessionId, ask };
    if (ask) this.asks.set(sessionId, change);
    else this.asks.delete(sessionId);
    this.ch.browserAsk.emit(change);
  }

  // ターミナルに出力を流す（改行は \r\n）
  shellOutput(id: string, data: string): void {
    this.ch.shellData.emit({ id, data });
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
        // 新規セッションの画面から始めたとき。台本が一覧に足して ID を返す（返す前に一覧に流しておくと、画面がそのセッションに切り替わる）
        create: (cwd, options) => ok(this.onCreate(cwd, options)),
        open: () => ok(undefined),
        archive: () => ok(null),
        unarchive: () => ok(undefined),
        focus: (id) => {
          this.focused = id;
          if (id && this.sessions.get(id)?.summary.unread) this.update(id, { unread: false });
        },
        snapshot: (id) => ok({ sessionId: id, fromSeq: 0, events: [...s(id).events] }),
        // 画像はパスを貼り付けて添付する（Claude Code は [Image #n] と出す）
        // 本物と同じく、発言は送った後で（別の順番で）会話に届く。同じ順番で届くと、アプリが「送信中」の仮の発言を消せない
        submit: (id, text, attachments) => {
          const message = `${attachments.map((_, i) => `[Image #${i + 1}] `).join('')}${text}`.trim();
          if (message) setTimeout(() => this.onUserMessage(id, message, attachments), 0);
          return ok(undefined);
        },
        interrupt: () => {},
        configure: () => ok(undefined),
        restart: () => ok(undefined),
        setRemoteControl: () => ok(null),
        remoteControlAvailable: () => ok(true),
        rename: () => ok(undefined),
        remove: () => ok(null),
        worktreeLeftovers: () => ok(null),
        history: (id) => ok([...s(id).events]),
        image: (key) => ok(this.images.get(key) ?? null),
        exportSource: (id) => ok({ events: [...s(id).events], branches: [p.branch], home: '/Users/demo' }),
        // 書き出した HTML は台本に渡す（デモのサイトは、その場で開いて見せる）
        saveExport: (html, fileName) => {
          this.onExport(html, fileName);
          return ok(`/Users/demo/Desktop/${fileName}`);
        },
        revealExport: () => {},
        discover: () => ok([...this.discovered]),
        import: (session) => ok(this.onImport(session)),
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
          return 'chosen';
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
      // デモでは予約しない（入力欄のボタンから選んでも、何も起きない）
      scheduled: {
        list: () => ok([]),
        add: () => ok(undefined),
        reschedule: () => ok(undefined),
        sendNow: () => ok(undefined),
        cancel: () => ok(null),
        onChanged: () => () => {},
      },
      notifications: {
        get: () => ok(this.notificationsOn),
        set: (on) => {
          this.notificationsOn = on;
          return ok(undefined);
        },
      },
      system: {
        onStats: (l) => {
          const tick = () =>
            l({ cpuPercent: 18 + Math.round(Math.random() * 10), memUsed: 21.4 * 2 ** 30, memTotal: 36 * 2 ** 30, topCpu: [], topMem: [] });
          tick();
          const timer = setInterval(tick, 2000);
          return () => clearInterval(timer);
        },
      },
      claudeVersion: { get: () => ok(this.claudeVersion), onChanged: (l) => this.ch.claudeVersion.on(l) },
      appUpdate: { get: () => ok(this.appUpdate), onChanged: (l) => this.ch.appUpdate.on(l), install: () => ok(undefined) },
      statusLine: { get: (id) => ok(this.sessions.get(id)?.statusLine ?? null), onChanged: (l) => this.ch.statusLine.on(l) },
      // 設定ファイルは登録しない（選択欄は「標準」のまま）
      settingsFiles: {
        list: () => ok([]),
        pick: () => ok(null),
        add: () => Promise.reject(new Error('デモでは設定ファイルを登録できません')),
        rename: () => ok(undefined),
        remove: () => ok(undefined),
        onChanged: () => () => {},
      },
      models: { get: () => ok(this.catalog), refresh: () => ok({ catalog: this.catalog }) },
      translate: {
        available: () => ok(this.translations !== null),
        run: (texts) => ok({ ok: true as const, texts: texts.map((t) => this.translations?.[t] ?? t) }),
        openSettings: () => ok(undefined),
      },
      knowledge: {
        get: (id) => ok({ files: s(id).knowledge, contextTokens: s(id).contextTokens }),
        onChanged: (l) => this.ch.knowledge.on(l),
      },
      context: { get: (id) => ok({ items: [...s(id).context] }) },
      tasks: {
        bash: (id) => ok(s(id).bash),
        onBashChanged: (l) => this.ch.bash.on(l),
        agentLog: (id, ref) => ok(s(id).agentLogs[ref.kind === 'workflow' ? `${ref.toolUseId}:${ref.agentId}` : ref.toolUseId] ?? []),
        stop: (id, ref) => {
          this.onStopTask(id, ref);
          return ok(null);
        },
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
        // 開くたびに別のシェル（タブ）にする。出力は台本が shellOutput で流す
        create: () => ok({ id: `demo-shell-${++this.shells}`, name: 'zsh' }),
        write: (id, data) => this.onShellWrite(id, data),
        resize: () => {},
        kill: () => {},
        onData: (l) => this.ch.shellData.on(l),
        onExit: (l) => this.ch.shellExit.on(l),
        onOpened: (l) => this.ch.shellOpened.on(l),
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
      // できない書き換えは、本物と同じく理由を添えて失敗する
      checklist: {
        get: (id) => ok(structuredClone(this.checklists.lists(id))),
        apply: async (id, op) => {
          this.checklists.apply(id, op);
          if (op.type === 'card-reply' && op.notify) this.notifyReply(id, op);
        },
        copy: async (r) => {
          const title = this.session(r.fromSession).summary.title ?? '（無題）';
          this.checklists.copyCards({ sessionId: r.fromSession, title, listId: r.listId, cardIds: r.cardIds }, r.toSession, 'human', r.toList || undefined);
        },
        onChanged: (l) => this.ch.checklist.on(l),
        unread: () => {
          const counts: Record<string, number> = {};
          for (const id of this.sessions.keys()) {
            const n = unreadCount(this.checklists.lists(id));
            if (n > 0) counts[id] = n;
          }
          return ok(counts);
        },
      },
      // デモのツアーではウォークスルーを使わない
      walkthrough: {
        list: () => ok([]),
        go: async () => {},
        close: async () => {},
        onChanged: () => () => {},
        draftComment: () => ok({ ok: false as const, reason: 'デモでは GitHub に載せられません。' }),
        postComment: () => Promise.reject(new Error('デモでは GitHub に載せられません。')),
      },
      browser: {
        attach: () => {},
        activate: () => {},
        onOpen: (l) => this.ch.browserOpen.on(l),
        onNewTab: () => () => {},
        onSelectTab: () => () => {},
        onCloseTab: () => () => {},
        openExternal: () => ok(undefined),
        onActivity: (l) => this.ch.browserActivity.on(l),
        onViewport: () => () => {},
        hosts: () => ok([]),
        setHosts: (hosts) => ok(hosts),
        onHostsOpen: () => () => {},
        onAsk: (l) => this.ch.browserAsk.on(l),
        asks: () => ok([...this.asks.values()]),
        // 返事をしたら、本物と同じく依頼を取り下げる（帯はこれで消える）
        answer: (sessionId, askId, answer) => {
          this.browserAsk(sessionId, null);
          this.onBrowserAnswer(sessionId, askId, answer);
        },
        onShow: () => () => {},
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
