import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ChatEvent, HookRun, PartialBlock, PullRequestLink, QuestionAnswer, SentFiles, TaskChange, TodoItem, UnsentPrompt } from '@shared/chat';
import type { CardRef } from '@shared/checklist-tools';
import type { ChatBatch, SessionSnapshot } from '@shared/ipc';
import type { SessionState } from '@shared/session-tools';
import type { UnknownEvent, UnknownProblem } from '@shared/unknown-event';
import { useSessionValues } from '../sessionValues';

export type ToolStatus = 'running' | 'done' | 'error';

// 未知のイベントの 1 回分（生の行と、どこから来たか）
export type UnknownSample = Pick<UnknownEvent, 'id' | 'source' | 'version' | 'raw' | 'truncated'>;

// まとめた未知のイベントの行に残す生の行の数（同じ種類が何度も続いても、画面と覚える量を増やし続けない。数は全部を数える）
export const UNKNOWN_SAMPLES = 20;

// at: 会話ログの時刻（ミリ秒。作業の書き出しで使う）
// settled: 書いている途中の文（partial）が外れたのと同じ配信で出た本文・思考。同じ場所のまま入れ替わって見えるよう、出るときの動きを付けない
export type ChatItem =
  // parent: 親セッションの Claude からの指示なら、親セッションの ID
  | { kind: 'user'; id: string; text: string; pastes?: string[]; images?: string[]; at?: number; parent?: string }
  | { kind: 'text'; id: string; text: string; at?: number; settled?: true }
  // sessions: 子セッションからの知らせなら、その子の ID / cards: チェックリストの知らせなら、そのカード
  | { kind: 'notice'; id: string; text: string; detail?: string; sessions?: string[]; cards?: CardRef[] }
  // detail: 開くと読める全文 / warning: 警告の色で出す / screen: ターミナルモードの画面の下にも出す
  | { kind: 'info'; id: string; text: string; detail?: string; warning?: true; screen?: true }
  | { kind: 'shell'; id: string; command: string; output: string }
  | { kind: 'thinking'; id: string; text: string; settled?: true }
  | { kind: 'divider'; id: string; text: string }
  | { kind: 'error'; id: string; text: string; retrying: boolean }
  // ツールに付かない hooks（Stop・SessionStart・UserPromptSubmit など）。同じきっかけのものはまとめる
  | { kind: 'hook'; id: string; runs: HookRun[] }
  // 未知のイベント（tanacode が知らない、Claude Code からの行）。同じ種類が続いたものは 1 行にまとめる。
  // count: 起きた数 / samples: 起きたものの生の行（新しいほうから UNKNOWN_SAMPLES 件まで。同じ行が stream と会話ログの両方に出たら、
  // 同じ id で 2 つ並ぶ。数は 1 つ）
  | { kind: 'unknown'; id: string; name: string; problem: UnknownProblem; count: number; samples: UnknownSample[] }
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

// Claude が書いている途中の応答の文と思考（main が配信に載せる今の全部。会話ログに出たら、その応答と同じ配信で外れる）。
// 応答中は最大 20Hz で届くので、ChatState には入れずに別に持つ（PartialSource）。途中の文しか変わらない配信では、チャット（ChatState）を
// 入れ替えず、App を描き直さない。途中の文の行（ClaudePane の PartialRows）だけが描き直す
export const NO_PARTIAL: PartialBlock[] = [];

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

// 同じ実行の記録か（Stop の要約と出力のあった記録など、同じ実行が 2 つの形で届く）。何も出力しなかったフックは hook_id で見分ける
// （1 回ずつ別の実行。コマンドが無いので、きっかけとツールが同じでも重ねない）
const sameRun = (a: HookRun, b: HookRun) =>
  a.hookId !== undefined || b.hookId !== undefined ? a.hookId === b.hookId : a.event === b.event && a.command === b.command && a.toolUseId === b.toolUseId;

// 行の位置の索引。イベントのたびに行を端から探さないため（長い会話ほど重くなる）
type RowIndex = {
  // ツールの id ごとの位置（前から順）
  tools: Map<string, number[]>;
  // 実行中のツールの位置
  running: Set<number>;
  // エラーの行の id ごとの数と、再試行中のエラーの行の数
  errors: Map<string, number>;
  retrying: number;
  // shell と未知のイベントの行の位置（前から順）
  shells: number[];
  unknowns: number[];
};

function indexRow(index: RowIndex, item: ChatItem, at: number): void {
  switch (item.kind) {
    case 'tool': {
      const list = index.tools.get(item.id);
      if (list) list.push(at);
      else index.tools.set(item.id, [at]);
      if (item.status === 'running') index.running.add(at);
      break;
    }
    case 'error':
      index.errors.set(item.id, (index.errors.get(item.id) ?? 0) + 1);
      if (item.retrying) index.retrying++;
      break;
    case 'shell':
      index.shells.push(at);
      break;
    case 'unknown':
      index.unknowns.push(at);
      break;
  }
}

function indexRows(items: readonly ChatItem[]): RowIndex {
  const index: RowIndex = { tools: new Map(), running: new Set(), errors: new Map(), retrying: 0, shells: [], unknowns: [] };
  items.forEach((item, at) => indexRow(index, item, at));
  return index;
}

// 行の配列ごとの索引。次に届いた配信は、前の配列の索引を引き継いで使う（引き継いだら、前の配列からは外す。同じ索引を 2 つの配列で
// 書き換えないため）。索引の無い配列は、要るときに作る
const rowIndexes = new WeakMap<readonly ChatItem[], RowIndex>();

// 1 回の配信（いくつかのイベント）で、行の配列を組み立てる。配列は最初に書き換えるときに 1 回だけ写し、あとはその写しを書き換える
// （イベントのたびに配列を丸ごと写さない）。写した配列は、組み立て終えたら書き換えない（React には新しい配列として渡る）。
// 変えない行は同じもののまま（ChatRows の memo が効く）、変えた行は新しいものにする
class Rows {
  private items: ChatItem[];
  private own = false;
  private index: RowIndex | null;
  // この配信で足した本文・思考の行（書いている途中の文から入れ替わったものの印を付けるため）。外すのはエラーの行だけなので、行をまとめて消したときだけ空にする
  private added: Extract<ChatItem, { kind: 'text' | 'thinking' }>[] = [];

  constructor(private readonly base: ChatItem[]) {
    this.items = base;
    // 引き継いだ索引は、前の配列から外す（組み立て終えたら、できた配列に付け直す）
    this.index = rowIndexes.get(base) ?? null;
    rowIndexes.delete(base);
  }

  private write(): ChatItem[] {
    if (!this.own) {
      this.items = this.base.slice();
      this.own = true;
    }
    return this.items;
  }

  private indexed(): RowIndex {
    this.index ??= indexRows(this.items);
    return this.index;
  }

  get length(): number {
    return this.items.length;
  }

  get last(): ChatItem | undefined {
    return this.items[this.items.length - 1];
  }

  at(position: number): ChatItem | undefined {
    return this.items[position];
  }

  push(item: ChatItem): void {
    const items = this.write();
    items.push(item);
    if (this.index) indexRow(this.index, item, items.length - 1);
    if (item.kind === 'text' || item.kind === 'thinking') this.added.push(item);
  }

  // position の行を入れ替える（種類と id は変えない。変わるのはツールの状態だけ）
  set(position: number, item: ChatItem): void {
    const items = this.write();
    const before = items[position];
    items[position] = item;
    if (!this.index) return;
    if (before.kind === 'tool' && before.status === 'running') this.index.running.delete(position);
    if (item.kind === 'tool' && item.status === 'running') this.index.running.add(position);
  }

  // 合う行を外す（まれ。索引と、この配信で足した行の位置は作り直す）
  private remove(drop: (item: ChatItem) => boolean): void {
    this.items = this.items.filter((item) => !drop(item));
    this.own = true;
    this.index = null;
  }

  clear(): void {
    this.items = [];
    this.own = true;
    this.index = null;
    this.added = [];
  }

  // 再試行中の API エラーは、応答が来たら（再試行が成功したら）消す
  withoutRetrying(): void {
    if (this.indexed().retrying > 0) this.remove((i) => i.kind === 'error' && i.retrying);
  }

  withoutError(id: string): void {
    if (this.indexed().errors.has(id)) this.remove((i) => i.kind === 'error' && i.id === id);
  }

  // id のツールの位置（前から順）
  tools(id: string): readonly number[] {
    return this.indexed().tools.get(id) ?? [];
  }

  running(): number[] {
    return [...this.indexed().running];
  }

  lastShell(): number {
    const shells = this.indexed().shells;
    return shells.length > 0 ? shells[shells.length - 1] : -1;
  }

  // 合う未知のイベントの行のうち、いちばん後ろの位置
  lastUnknown(match: (item: Extract<ChatItem, { kind: 'unknown' }>) => boolean): number {
    const unknowns = this.indexed().unknowns;
    for (let i = unknowns.length - 1; i >= 0; i--) {
      const item = this.items[unknowns[i]];
      if (item.kind === 'unknown' && match(item)) return unknowns[i];
    }
    return -1;
  }

  // 組み立て終えた配列と、この配信で足して残っている本文・思考の行
  done(): { items: ChatItem[]; added: readonly Extract<ChatItem, { kind: 'text' | 'thinking' }>[] } {
    if (this.index) rowIndexes.set(this.items, this.index);
    return { items: this.items, added: this.added };
  }
}

// hooks はツールのカードに付ける。ツールに付かないものは、直前の同じきっかけの hooks とまとめる。
// Stop の要約と出力のあった記録は同じ実行なので、重ねない（出力のある方を残す）
function addHook(rows: Rows, id: string, run: HookRun): void {
  const merge = (runs: HookRun[]) => (runs.some((r) => sameRun(r, run)) ? runs : [...runs, run]);
  const tool = run.toolUseId ? (rows.tools(run.toolUseId)[0] ?? -1) : -1;
  // AskUserQuestion の PermissionRequest の決定の記録（コマンドが無い）は、前のアプリが足した質問のフックが答えた印（前の会話ログに残る）。
  // ユーザーのフックではないので出さない（Claude Code は、この記録にコマンドを残さないので、目印の環境変数では見分けられない）
  const target = rows.at(tool);
  if (target?.kind === 'tool' && target.name === 'AskUserQuestion' && run.event === 'PermissionRequest' && !run.command) return;
  if (target?.kind === 'tool') {
    rows.set(tool, { ...target, hooks: merge(target.hooks ?? []) });
    return;
  }
  const last = rows.last;
  if (last?.kind === 'hook' && last.runs[0].toolUseId === run.toolUseId && last.runs[0].event === run.event) {
    rows.set(rows.length - 1, { ...last, runs: merge(last.runs) });
    return;
  }
  rows.push({ kind: 'hook', id, runs: [run] });
}

// 未知のイベントを足す。同じ行（同じ id）がもう出ていれば（stream と会話ログの両方に出た行）、その行の隣に生の行だけを足す（数は増やさない。
// 同じところから届き直したものは足さない）。直前の行が同じ種類の未知のイベントなら、そこにまとめる
function addUnknown(rows: Rows, event: UnknownEvent): void {
  const sample: UnknownSample = { id: event.id, source: event.source, version: event.version, raw: event.raw, truncated: event.truncated };
  const index = rows.lastUnknown((i) => i.samples.some((s) => s.id === event.id));
  const found = rows.at(index);
  if (found?.kind === 'unknown') {
    if (found.samples.some((s) => s.id === event.id && s.source === event.source)) return;
    const at = found.samples.findLastIndex((s) => s.id === event.id) + 1;
    rows.set(index, { ...found, samples: [...found.samples.slice(0, at), sample, ...found.samples.slice(at)] });
    return;
  }
  const last = rows.last;
  if (last?.kind === 'unknown' && last.name === event.name && last.problem === event.problem) {
    rows.set(rows.length - 1, { ...last, count: last.count + 1, samples: [...last.samples, sample].slice(-UNKNOWN_SAMPLES) });
    return;
  }
  rows.push({ kind: 'unknown', id: event.id, name: event.name, problem: event.problem, count: 1, samples: [sample] });
}

// ! のコマンドの出力を、まだ出力の無い直前の shell に付ける。見つからなければ、出力だけの shell として出す
function addShellOutput(rows: Rows, id: string, output: string): void {
  const index = rows.lastShell();
  const shell = rows.at(index);
  if (shell?.kind !== 'shell' || shell.output) rows.push({ kind: 'shell', id, command: '', output });
  else rows.set(index, { ...shell, output });
}

// イベントをまとめてチャットに当てる。行の配列は 1 回だけ写す（イベントの数と行の数の和に比例する）
function applyEvents(state: ChatState, events: readonly ChatEvent[]): { chat: ChatState; added: readonly Extract<ChatItem, { kind: 'text' | 'thinking' }>[] } {
  const rows = new Rows(state.items);
  let next = state;
  for (const event of events) next = apply(next, event, rows);
  const { items, added } = rows.done();
  return { chat: items === next.items ? next : { ...next, items }, added };
}

// 会話ログから作ったイベントをまとめてチャットにする（アーカイブ済みセッションの表示用）
export function chatFromEvents(events: ChatEvent[]): ChatState {
  return applyEvents(EMPTY_CHAT, events).chat;
}

// ToDo の一覧を変えたツールの呼び出し（id）ごとの、変えたあとの一覧。作業の書き出しで、進み具合を途中に挟むのに使う。
// TaskCreate は結果で番号が分かってから一覧に入るので、結果のところで数える
export function todoSteps(events: ChatEvent[]): Map<string, TodoItem[]> {
  const steps = new Map<string, TodoItem[]>();
  const rows = new Rows(EMPTY_CHAT.items);
  let state = EMPTY_CHAT;
  for (const event of events) {
    const next = apply(state, event, rows);
    if (next.todos && next.todos !== state.todos && (event.type === 'tool-use' || event.type === 'tool-result')) steps.set(event.id, next.todos);
    state = next;
  }
  return steps;
}

// 起動中は ready が届くまで状態を変えない（再開時に読み直す過去の会話で、待機中や作業中にしない）
function turn(state: ChatState, status: 'idle' | 'running'): SessionStatus {
  return state.status === 'starting' || state.status === 'exited' ? state.status : status;
}

// イベントを 1 つ当てる。行は rows に組み立て（state.items は読まない。古いまま）、ほかの値は新しい state で返す
function apply(state: ChatState, event: ChatEvent, rows: Rows): ChatState {
  switch (event.type) {
    case 'thinking':
      rows.push({ kind: 'thinking', id: event.id, text: event.text });
      return state;
    case 'divider':
      rows.push({ kind: 'divider', id: event.id, text: event.text });
      return state;
    case 'api-error':
      // 同じ知らせが届き直したら（応答の前に終わったターンの発言の行が遅れて届いたとき、main がターンの終わりと一緒に出し直す）、
      // 前の行を外して今の位置に出す
      rows.withoutRetrying();
      rows.withoutError(event.id);
      rows.push({ kind: 'error', id: event.id, text: event.text, retrying: event.retrying });
      return state;
    case 'process-start':
      rows.clear();
      return { ...EMPTY_CHAT, status: 'starting' };
    case 'ready':
      // 引き継いだ claude がターンの途中なら、入力を受け付けられても作業中のまま
      return { ...state, status: state.status === 'starting' ? (state.inTurn ? 'running' : 'idle') : state.status };
    case 'process-exit':
      return { ...state, status: 'exited', exitCode: event.exitCode, exitReason: event.reason ?? null };
    case 'user':
      rows.push({ kind: 'user', id: event.id, text: event.text, pastes: event.pastes, images: event.images, at: event.at, parent: event.parent });
      return { ...state, status: turn(state, 'running'), inTurn: true };
    case 'notice':
      // 完了通知を受けて Claude Code が続きを始める
      rows.push({ kind: 'notice', id: event.id, text: event.text, detail: event.detail, sessions: event.sessions, cards: event.cards });
      return { ...state, status: turn(state, 'running'), inTurn: true };
    case 'turn-start':
      return { ...state, status: turn(state, 'running'), inTurn: true };
    // ほかのセッションに結果を返すときの目印。チャットには出さない
    case 'checklist-stop':
      return state;
    case 'info':
      rows.push({ kind: 'info', id: event.id, text: event.text, detail: event.detail, warning: event.warning, screen: event.screen });
      return state;
    case 'shell':
      rows.push({ kind: 'shell', id: event.id, command: event.command, output: event.output });
      return state;
    case 'shell-output':
      addShellOutput(rows, event.id, event.output);
      return state;
    case 'assistant-text':
      rows.withoutRetrying();
      rows.push({ kind: 'text', id: event.id, text: event.text, at: event.at });
      return state;
    case 'tool-use':
      rows.withoutRetrying();
      rows.push({
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
      });
      return {
        ...state,
        todos: event.todos ?? (event.taskChange?.kind === 'update' ? updateTask(state.todos, event.taskChange) : state.todos),
        pendingTasks:
          event.taskChange?.kind === 'create'
            ? { ...state.pendingTasks, [event.id]: { content: event.taskChange.subject, status: 'pending', activeForm: event.taskChange.activeForm } }
            : state.pendingTasks,
      };
    case 'tool-result':
      for (const at of rows.tools(event.id)) {
        const item = rows.at(at);
        if (item?.kind !== 'tool') continue;
        rows.set(at, {
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
        });
      }
      return { ...state, ...createTask(state, event.id, event.createdTaskId) };
    case 'turn-end':
      rows.withoutRetrying();
      // 中断されたツールは結果が来ないまま終わるので、実行中表示を残さない
      for (const at of rows.running()) {
        const item = rows.at(at);
        if (item?.kind === 'tool') rows.set(at, { ...item, status: 'error' });
      }
      return { ...state, status: turn(state, 'idle'), inTurn: false };
    case 'reset':
      // 最適化圧縮の切り替え（アプリが打った /clear）では、チャットを消さない。人が読んでいる途中の答えが、画面から消えないように
      // （前の会話はそのまま残り、再開の知らせの行が区切りになる。ふつうの圧縮と同じ見え方）。人が打った /clear は消す
      if (!event.compact) rows.clear();
      return { ...state, todos: null, pendingTasks: {} };
    case 'replace': {
      rows.clear();
      let next = EMPTY_CHAT;
      for (const e of event.events) next = apply(next, e, rows);
      return next;
    }
    case 'hook':
      addHook(rows, event.id, event.run);
      return state;
    case 'remote-control':
      return { ...state, remoteControlUrl: event.url };
    case 'queue':
      return { ...state, unsent: event.prompts };
    case 'pr-link':
      return state.pr?.url === event.pr.url ? state : { ...state, pr: event.pr };
    // ターンの始まりにも終わりにもしない（作業中・待機中を変えない）
    case 'unknown-event':
      addUnknown(rows, event);
      return state;
  }
}

type Entry = { chat: ChatState; partial: PartialBlock[]; nextSeq: number };

// 書いている途中の文を消すイベント。ターンの終わり（書きかけのまま会話ログに出なかった文は残さない。main も同じ配信で消す）・終了・/clear・起動。
// 巻き戻しの組み立て直し（replace）では、書いている途中の文は main が持つものなので残す
const CLEARS_PARTIAL = new Set<ChatEvent['type']>(['turn-end', 'process-exit', 'reset', 'process-start']);

function withSnapshot(current: Entry | undefined, { fromSeq, events, partial }: SessionSnapshot): Entry | undefined {
  // スナップショット取得中に届いたライブ配信の方が新しければそちらを残す
  if (current && current.nextSeq >= fromSeq + events.length) return current;
  return { chat: chatFromEvents(events), partial: partial ?? NO_PARTIAL, nextSeq: fromSeq + events.length };
}

// 書いている途中の文（partial）は、届いたら今の全部に置き換える。イベントの無い配信（途中の文だけ）は、通し番号を進めない。
// 持っているものより古い配信（スナップショットに入っていたもの）の途中の文は使わない
function withBatch(current: Entry | undefined, { fromSeq, events, partial }: ChatBatch): Entry | undefined {
  const base = current ?? { chat: EMPTY_CHAT, partial: NO_PARTIAL, nextSeq: 0 };
  const skip = base.nextSeq - fromSeq;
  const fresh = skip < events.length ? events.slice(Math.max(0, skip)) : null;
  const latest = partial && fromSeq + events.length >= base.nextSeq ? partial : null;
  if (!fresh && !latest) return current;
  const { chat, added } = fresh ? applyEvents(base.chat, fresh) : { chat: base.chat, added: [] as const };
  const nextSeq = fresh ? fromSeq + events.length : base.nextSeq;
  if (!latest) return { chat, partial: fresh?.some((e) => CLEARS_PARTIAL.has(e.type)) ? NO_PARTIAL : base.partial, nextSeq };
  const removed = base.partial.filter((p) => !latest.some((q) => q.id === p.id));
  const items = settled(chat.items, added, removed);
  // 途中の文しか変わらない配信では、チャットは前のまま（App を描き直さない）
  return { chat: items === chat.items ? chat : { ...chat, items }, partial: latest, nextSeq };
}

// 外れた途中の文の代わりに、同じ配信で出た本文・思考（added。足した順）に印を付ける（main は、会話ログに出たブロックを、その行のイベントと
// 同じ配信で外す。1 つの配信の中では、外れたブロックと出た行は同じ順に並ぶ）。足した行は後ろの方にあるので、後ろから探す
function settled(items: ChatItem[], added: readonly Extract<ChatItem, { kind: 'text' | 'thinking' }>[], removed: PartialBlock[]): ChatItem[] {
  if (removed.length === 0 || added.length === 0) return items;
  const left = removed.map((p): 'text' | 'thinking' => (p.kind === 'text' ? 'text' : 'thinking'));
  const marks = new Map<ChatItem, ChatItem>();
  for (const item of added) {
    const at = left.indexOf(item.kind);
    if (at === -1) continue;
    left.splice(at, 1);
    marks.set(item, { ...item, settled: true });
  }
  if (marks.size === 0) return items;
  const next = items.slice();
  for (let i = next.length - 1, found = 0; i >= 0 && found < marks.size; i--) {
    const mark = marks.get(next[i]);
    if (!mark) continue;
    next[i] = mark;
    found++;
  }
  // 印を付けても、行の種類と位置は変わらないので、索引はそのまま引き継ぐ
  const index = rowIndexes.get(items);
  if (index) {
    rowIndexes.delete(items);
    rowIndexes.set(next, index);
  }
  return next;
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

// 書いている途中の文の読み口。get: 今の途中の文 / subscribe: 変わったら知らせる（外す関数を返す）
export type PartialSource = {
  get: (sessionId: string) => PartialBlock[];
  subscribe: (sessionId: string, listener: () => void) => () => void;
};

// いつも同じ途中の文を返す読み口（Storybook・テスト用）
export function fixedPartial(blocks: PartialBlock[]): PartialSource {
  return { get: () => blocks, subscribe: () => () => {} };
}

export const NO_PARTIAL_SOURCE = fixedPartial(NO_PARTIAL);

// 書いている途中の文を読む。読み口から知らせが来たら、この部品だけを描き直す
export function usePartial(source: PartialSource, sessionId: string): PartialBlock[] {
  const subscribe = useCallback((listener: () => void) => source.subscribe(sessionId, listener), [source, sessionId]);
  return useSyncExternalStore(subscribe, () => source.get(sessionId));
}

// 全セッションのチャット。描き直すのは、選択中のセッションのチャットが変わったときと、ほかのセッションの状態が変わったときだけ。
// 書いている途中の文は partials から読む（途中の文だけが変わっても、チャットは変わらず、App も描き直さない）
export function useSessionChats(selectedId: string | null, listed: ReadonlySet<string> | null): {
  chatOf: (sessionId: string | null) => ChatState;
  partials: PartialSource;
  load: (sessionId: string) => void;
  // 動いていたときのチャットを捨てて、起動前に戻す
  reset: (sessionId: string) => void;
} {
  const { valueOf, peek, update } = useSessionValues<Entry | undefined, undefined>(
    selectedId,
    listed,
    undefined,
    (prev, next) => !!next && notableChange(prev, next),
    (prev, next) => prev?.chat !== next?.chat,
  );

  // 途中の文の聞き手（セッションごと）
  const listeners = useRef(new Map<string, Set<() => void>>());
  const partials = useRef<PartialSource>({
    get: (sessionId) => peek(sessionId)?.partial ?? NO_PARTIAL,
    subscribe: (sessionId, listener) => {
      const set = listeners.current.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.current.set(sessionId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.current.delete(sessionId);
      };
    },
  }).current;
  // 入れ替えて、途中の文が変わったら聞き手に知らせる
  const change = useCallback(
    (sessionId: string, next: (prev: Entry | undefined) => Entry | undefined) => {
      const before = peek(sessionId)?.partial ?? NO_PARTIAL;
      update(sessionId, next);
      if ((peek(sessionId)?.partial ?? NO_PARTIAL) !== before) for (const listener of listeners.current.get(sessionId) ?? []) listener();
    },
    [peek, update],
  );

  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.sessions.snapshot(sessionId).then((snapshot) => change(sessionId, (prev) => withSnapshot(prev, snapshot)));
    },
    [change],
  );

  useEffect(
    () =>
      window.tanacode.sessions.onChat((batch) => {
        // 途中から受け取ったセッションは取りこぼしがあるので、スナップショットで埋める
        if (!peek(batch.sessionId) && batch.fromSeq > 0) load(batch.sessionId);
        else change(batch.sessionId, (prev) => withBatch(prev, batch));
      }),
    [load, peek, change],
  );

  const reset = useCallback((sessionId: string) => change(sessionId, () => undefined), [change]);

  const chatOf = useCallback((sessionId: string | null) => valueOf(sessionId)?.chat ?? EMPTY_CHAT, [valueOf]);
  return { chatOf, partials, load, reset };
}
