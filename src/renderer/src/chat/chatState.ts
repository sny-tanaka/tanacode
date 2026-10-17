import { useCallback, useEffect } from 'react';
import type { ChatEvent, HookRun, PullRequestLink, QuestionAnswer, SentFiles, TaskChange, TodoItem, UnsentPrompt } from '@shared/chat';
import type { CardRef } from '@shared/checklist-tools';
import type { ChatBatch, SessionSnapshot } from '@shared/ipc';
import type { SessionState } from '@shared/session-tools';
import { useSessionValues } from '../sessionValues';

export type ToolStatus = 'running' | 'done' | 'error';

// at: 会話ログの時刻（ミリ秒。作業の書き出しで使う）
export type ChatItem =
  // parent: 親セッションの Claude からの指示なら、親セッションの ID
  | { kind: 'user'; id: string; text: string; pastes?: string[]; images?: string[]; at?: number; parent?: string }
  | { kind: 'text'; id: string; text: string; at?: number }
  // sessions: 子セッションからの知らせなら、その子の ID / cards: チェックリストの知らせなら、そのカード
  | { kind: 'notice'; id: string; text: string; detail?: string; sessions?: string[]; cards?: CardRef[] }
  | { kind: 'info'; id: string; text: string }
  | { kind: 'shell'; id: string; command: string; output: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'divider'; id: string; text: string }
  | { kind: 'error'; id: string; text: string; retrying: boolean }
  // ツールに付かない hooks（Stop・SessionStart・UserPromptSubmit など）。同じきっかけのものはまとめる
  | { kind: 'hook'; id: string; runs: HookRun[] }
  | {
      kind: 'tool';
      id: string;
      name: string;
      target: string;
      // 何をするかの説明（Bash・Agent などの description）
      description?: string;
      filePath?: string;
      status: ToolStatus;
      added?: number;
      removed?: number;
      // 最初に変更した行（Edit・Write のみ）
      line?: number;
      input: string;
      // SendUserFile で送ったファイル
      sentFiles?: SentFiles;
      output?: string;
      // 結果の画像（スクリーンショットなど）の鍵
      images?: string[];
      // AskUserQuestion への回答
      answers?: QuestionAnswer[];
      patch?: string[];
      // このツールで動いた hooks（PreToolUse / PostToolUse など）
      hooks?: HookRun[];
      // 呼び出した時刻と結果が返った時刻（会話ログの時刻。ミリ秒）
      startedAt?: number;
      endedAt?: number;
    };

// starting: 起動してから、Claude Code が受け付けられるようになるまで（initialize の返事が来るまで）。この間に送るものは預かる
export type SessionStatus = 'not-started' | 'starting' | 'idle' | 'running' | 'exited';

// 送った文字を Claude Code が受け付けられる状態
export function acceptsInput(status: SessionStatus): boolean {
  return status === 'idle' || status === 'running';
}

export type ChatState = {
  items: ChatItem[];
  status: SessionStatus;
  remoteControlUrl: string | null;
  // このセッションの PR（最後に紐づいたもの）
  pr: PullRequestLink | null;
  exitCode: number | null;
  // 終わったわけ（process-exit の reason）。無ければ終了コードを出す
  exitReason: string | null;
  // ToDo の一覧（最後の TodoWrite か、TaskCreate・TaskUpdate を順に当てたもの）
  todos: TodoItem[] | null;
  // 結果（番号）を待っている TaskCreate（ツールの呼び出しの id ごと）
  pendingTasks: Record<string, TodoItem>;
  // ターンの途中（発言・完了通知・別の Claude からの知らせで始まり、turn-end で終わる）。起動中に読み直した会話で始まったターンも数える
  inTurn: boolean;
  // 送ったが、まだ会話に出ていない発言（送信中・順番待ち。main が送った uuid で追う）
  unsent: UnsentPrompt[];
};

export const EMPTY_CHAT: ChatState = {
  items: [],
  status: 'not-started',
  remoteControlUrl: null,
  pr: null,
  exitCode: null,
  exitReason: null,
  todos: null,
  pendingTasks: {},
  inTurn: false,
  unsent: [],
};

// TaskUpdate を一覧に当てる（deleted は消す）
function updateTask(todos: TodoItem[] | null, change: Extract<TaskChange, { kind: 'update' }>): TodoItem[] | null {
  if (!todos?.some((t) => t.id === change.taskId)) return todos;
  if (change.status === 'deleted') return todos.filter((t) => t.id !== change.taskId);
  return todos.map((t) =>
    t.id === change.taskId
      ? { ...t, status: change.status ?? t.status, content: change.subject ?? t.content, activeForm: change.activeForm ?? t.activeForm }
      : t,
  );
}

// TaskCreate の結果で番号が分かったら、一覧に足す（失敗したものは捨てる）
function createTask(state: ChatState, toolUseId: string, taskId: string | undefined): Pick<ChatState, 'todos' | 'pendingTasks'> | null {
  const pending = state.pendingTasks[toolUseId];
  if (!pending) return null;
  const rest = { ...state.pendingTasks };
  delete rest[toolUseId];
  // TodoWrite の一覧（番号が無い）とは混ぜない
  const base = state.todos?.every((t) => t.id !== undefined) ? state.todos : [];
  return { pendingTasks: rest, todos: taskId ? [...base, { ...pending, id: taskId }] : state.todos };
}

// 再試行中の API エラーは、応答が来たら（再試行が成功したら）消す
function withoutRetrying(items: ChatItem[]): ChatItem[] {
  return items.some((i) => i.kind === 'error' && i.retrying) ? items.filter((i) => !(i.kind === 'error' && i.retrying)) : items;
}

// 同じ実行の記録か（Stop の要約と出力のあった記録など、同じ実行が 2 つの形で届く）。何も出力しなかったフックは hook_id で見分ける
// （1 回ずつ別の実行。コマンドが無いので、きっかけとツールが同じでも重ねない）
const sameRun = (a: HookRun, b: HookRun) =>
  a.hookId !== undefined || b.hookId !== undefined ? a.hookId === b.hookId : a.event === b.event && a.command === b.command && a.toolUseId === b.toolUseId;

// hooks はツールのカードに付ける。ツールに付かないものは、直前の同じきっかけの hooks とまとめる。
// Stop の要約と出力のあった記録は同じ実行なので、重ねない（出力のある方を残す）
function withHook(items: ChatItem[], id: string, run: HookRun): ChatItem[] {
  const merge = (runs: HookRun[]) => (runs.some((r) => sameRun(r, run)) ? runs : [...runs, run]);
  const tool = run.toolUseId ? items.findIndex((i) => i.kind === 'tool' && i.id === run.toolUseId) : -1;
  // AskUserQuestion の PermissionRequest の決定の記録（コマンドが無い）は、前のアプリが足した質問のフックが答えた印（前の会話ログに残る）。
  // ユーザーのフックではないので出さない（Claude Code は、この記録にコマンドを残さないので、目印の環境変数では見分けられない）
  const target = items[tool];
  if (target?.kind === 'tool' && target.name === 'AskUserQuestion' && run.event === 'PermissionRequest' && !run.command) return items;
  if (tool !== -1) {
    return items.map((item, i) => (i === tool && item.kind === 'tool' ? { ...item, hooks: merge(item.hooks ?? []) } : item));
  }
  const last = items[items.length - 1];
  if (last?.kind === 'hook' && last.runs[0].toolUseId === run.toolUseId && last.runs[0].event === run.event) {
    return [...items.slice(0, -1), { ...last, runs: merge(last.runs) }];
  }
  return [...items, { kind: 'hook', id, runs: [run] }];
}

// ! のコマンドの出力を、まだ出力の無い直前の shell に付ける。見つからなければ、出力だけの shell として出す
function withShellOutput(items: ChatItem[], id: string, output: string): ChatItem[] {
  const index = items.findLastIndex((i) => i.kind === 'shell');
  const shell = items[index];
  if (shell?.kind !== 'shell' || shell.output) return [...items, { kind: 'shell', id, command: '', output }];
  return items.map((item, i) => (i === index ? { ...shell, output } : item));
}

// 会話ログから作ったイベントをまとめてチャットにする（アーカイブ済みセッションの表示用）
export function chatFromEvents(events: ChatEvent[]): ChatState {
  return events.reduce(apply, EMPTY_CHAT);
}

// ToDo の一覧を変えたツールの呼び出し（id）ごとの、変えたあとの一覧。作業の書き出しで、進み具合を途中に挟むのに使う。
// TaskCreate は結果で番号が分かってから一覧に入るので、結果のところで数える
export function todoSteps(events: ChatEvent[]): Map<string, TodoItem[]> {
  const steps = new Map<string, TodoItem[]>();
  let state = EMPTY_CHAT;
  for (const event of events) {
    const next = apply(state, event);
    if (next.todos && next.todos !== state.todos && (event.type === 'tool-use' || event.type === 'tool-result')) steps.set(event.id, next.todos);
    state = next;
  }
  return steps;
}

// 起動中は ready が届くまで状態を変えない（再開時に読み直す過去の会話で、待機中や作業中にしない）
function turn(state: ChatState, status: 'idle' | 'running'): SessionStatus {
  return state.status === 'starting' || state.status === 'exited' ? state.status : status;
}

function apply(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'thinking':
      return { ...state, items: [...state.items, { kind: 'thinking', id: event.id, text: event.text }] };
    case 'divider':
      return { ...state, items: [...state.items, { kind: 'divider', id: event.id, text: event.text }] };
    case 'api-error': {
      const items = withoutRetrying(state.items);
      return { ...state, items: [...items, { kind: 'error', id: event.id, text: event.text, retrying: event.retrying }] };
    }
    case 'process-start':
      return { ...EMPTY_CHAT, status: 'starting' };
    case 'ready':
      // 引き継いだ claude がターンの途中なら、入力を受け付けられても作業中のまま
      return { ...state, status: state.status === 'starting' ? (state.inTurn ? 'running' : 'idle') : state.status };
    case 'process-exit':
      return { ...state, status: 'exited', exitCode: event.exitCode, exitReason: event.reason ?? null };
    case 'user':
      return {
        ...state,
        status: turn(state, 'running'),
        inTurn: true,
        items: [...state.items, { kind: 'user', id: event.id, text: event.text, pastes: event.pastes, images: event.images, at: event.at, parent: event.parent }],
      };
    case 'notice':
      // 完了通知を受けて Claude Code が続きを始める
      return {
        ...state,
        status: turn(state, 'running'),
        inTurn: true,
        items: [...state.items, { kind: 'notice', id: event.id, text: event.text, detail: event.detail, sessions: event.sessions, cards: event.cards }],
      };
    case 'turn-start':
      return { ...state, status: turn(state, 'running'), inTurn: true };
    // ほかのセッションに結果を返すときの目印。チャットには出さない
    case 'checklist-stop':
      return state;
    case 'info':
      return { ...state, items: [...state.items, { kind: 'info', id: event.id, text: event.text }] };
    case 'shell':
      return { ...state, items: [...state.items, { kind: 'shell', id: event.id, command: event.command, output: event.output }] };
    case 'shell-output':
      return { ...state, items: withShellOutput(state.items, event.id, event.output) };
    case 'assistant-text':
      return { ...state, items: [...withoutRetrying(state.items), { kind: 'text', id: event.id, text: event.text, at: event.at }] };
    case 'tool-use':
      return {
        ...state,
        todos: event.todos ?? (event.taskChange?.kind === 'update' ? updateTask(state.todos, event.taskChange) : state.todos),
        pendingTasks:
          event.taskChange?.kind === 'create'
            ? { ...state.pendingTasks, [event.id]: { content: event.taskChange.subject, status: 'pending', activeForm: event.taskChange.activeForm } }
            : state.pendingTasks,
        items: [
          ...withoutRetrying(state.items),
          {
            kind: 'tool',
            id: event.id,
            name: event.name,
            target: event.target,
            description: event.description,
            filePath: event.filePath,
            status: 'running',
            input: event.input,
            sentFiles: event.sentFiles,
            startedAt: event.at,
          },
        ],
      };
    case 'tool-result':
      return {
        ...state,
        ...createTask(state, event.id, event.createdTaskId),
        items: state.items.map((item) =>
          item.kind === 'tool' && item.id === event.id
            ? {
                ...item,
                status: event.isError ? 'error' : 'done',
                added: event.added,
                removed: event.removed,
                line: event.line,
                output: event.output,
                patch: event.patch,
                images: event.images,
                answers: event.answers,
                endedAt: event.at,
              }
            : item,
        ),
      };
    case 'turn-end':
      return {
        ...state,
        status: turn(state, 'idle'),
        inTurn: false,
        // 中断されたツールは結果が来ないまま終わるので、実行中表示を残さない
        items: withoutRetrying(state.items).map((item) =>
          item.kind === 'tool' && item.status === 'running' ? { ...item, status: 'error' } : item,
        ),
      };
    case 'reset':
      // 最適化圧縮の切り替え（アプリが打った /clear）では、チャットを消さない。人が読んでいる途中の答えが、画面から消えないように
      // （前の会話はそのまま残り、再開の知らせの行が区切りになる。ふつうの圧縮と同じ見え方）。人が打った /clear は消す
      return { ...state, items: event.compact ? state.items : [], todos: null, pendingTasks: {} };
    case 'replace':
      return event.events.reduce(apply, EMPTY_CHAT);
    case 'hook':
      return { ...state, items: withHook(state.items, event.id, event.run) };
    case 'remote-control':
      return { ...state, remoteControlUrl: event.url };
    case 'queue':
      return { ...state, unsent: event.prompts };
    case 'pr-link':
      return state.pr?.url === event.pr.url ? state : { ...state, pr: event.pr };
  }
}

type Entry = { chat: ChatState; nextSeq: number };

function withSnapshot(current: Entry | undefined, { fromSeq, events }: SessionSnapshot): Entry | undefined {
  // スナップショット取得中に届いたライブ配信の方が新しければそちらを残す
  if (current && current.nextSeq >= fromSeq + events.length) return current;
  return { chat: events.reduce(apply, EMPTY_CHAT), nextSeq: fromSeq + events.length };
}

function withBatch(current: Entry | undefined, { fromSeq, events }: ChatBatch): Entry | undefined {
  const base = current ?? { chat: EMPTY_CHAT, nextSeq: 0 };
  const skip = base.nextSeq - fromSeq;
  if (skip >= events.length) return current;
  const fresh = events.slice(Math.max(0, skip));
  return { chat: fresh.reduce(apply, base.chat), nextSeq: fromSeq + events.length };
}

// 選択していないセッションでも描き直す変化。起動待ちの発言の送り出しに関わる
function notableChange(prev: Entry | undefined, next: Entry): boolean {
  return !prev || prev.chat.status !== next.chat.status;
}

// チャットの状態。動いているセッションは、main が持つ状態（一覧の state）から決める（状態は main が 1 つだけ持つ。設計書 7 節）。
// まだチャットを読んでいない（not-started）・アーカイブ済み・一覧の外のセッションは、チャットのイベントから作ったまま
export function statusOf(chat: ChatState, state: SessionState | null | undefined): SessionStatus {
  if (chat.status === 'not-started' || !state || state === 'archived') return chat.status;
  switch (state) {
    case 'starting':
      return 'starting';
    case 'exited':
      return 'exited';
    // ターンが終わって、裏のタスクだけが動いている間も、発言を受け付ける
    case 'idle':
    case 'background':
      return 'idle';
    // 作業中と、ターンの途中で人の答えを待っているもの（質問・許可・ブラウザでの操作）。ターミナルモード（人が TUI で操作している）も、
    // チャットからは操作しない（ヘッダーのモード・モデル・巻き戻し・最適化圧縮を押せなくする）
    default:
      return 'running';
  }
}

// ステータスバーに出す状態。ターミナルモードの間は、チャットの操作を止めるために statusOf では作業中にしているが、
// ステータスバーには、一覧の印と同じく、TUI がターンの途中か（terminalWorking）で待機中・作業中を出す
export function statusBarStatus(status: SessionStatus, session: { state?: SessionState | null; terminalWorking?: boolean } | null): SessionStatus {
  if (session?.state !== 'terminal') return status;
  return session.terminalWorking ? 'running' : 'idle';
}

// 状態だけ違うチャット。同じチャットと状態には同じものを返す（チャットの画面を、状態が変わらないのに描き直さない）
const withStatusCache = new WeakMap<ChatState, ChatState>();

export function withStatus(chat: ChatState, state: SessionState | null | undefined): ChatState {
  const status = statusOf(chat, state);
  if (status === chat.status) return chat;
  const cached = withStatusCache.get(chat);
  if (cached?.status === status) return cached;
  const next = { ...chat, status };
  withStatusCache.set(chat, next);
  return next;
}

// 全セッションのチャット。描き直すのは、選択中のセッションのチャットが変わったときと、ほかのセッションの状態が変わったときだけ
export function useSessionChats(selectedId: string | null): {
  chatOf: (sessionId: string | null) => ChatState;
  load: (sessionId: string) => void;
  // 動いていたときのチャットを捨てて、起動前に戻す
  reset: (sessionId: string) => void;
} {
  const { valueOf, peek, update } = useSessionValues<Entry | undefined, undefined>(selectedId, undefined, (prev, next) => !!next && notableChange(prev, next));

  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.sessions.snapshot(sessionId).then((snapshot) => update(sessionId, (prev) => withSnapshot(prev, snapshot)));
    },
    [update],
  );

  useEffect(
    () =>
      window.tanacode.sessions.onChat((batch) => {
        // 途中から受け取ったセッションは取りこぼしがあるので、スナップショットで埋める
        if (!peek(batch.sessionId) && batch.fromSeq > 0) load(batch.sessionId);
        else update(batch.sessionId, (prev) => withBatch(prev, batch));
      }),
    [load, peek, update],
  );

  const reset = useCallback((sessionId: string) => update(sessionId, () => undefined), [update]);

  const chatOf = useCallback((sessionId: string | null) => valueOf(sessionId)?.chat ?? EMPTY_CHAT, [valueOf]);
  return { chatOf, load, reset };
}
