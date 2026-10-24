import { lstat, open, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { ChatEvent } from '@shared/chat';
import { carriedMessages, compactTriggerOf, lastReplyIn } from '@shared/optimized-compact';
import { t, type MessageKey } from '@shared/i18n';
import type { ArchiveOptions, NewSessionOptions, SessionOptions, SessionSummary, WorktreeBranchKeep, WorktreeLeftovers, WorktreePr, WorktreeRemoval } from '@shared/ipc';
import { stripControlChars } from '@shared/paste';
import type { AskQuestion, PermissionMode } from '@shared/screen';
import { answerText, type PendingPermission, type PendingQuestion, type PermissionReply } from '@shared/questions';
import type { PendingElicitation } from '@shared/elicitation';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { UsageLimitStop } from '@shared/usage-limit';
import type { WorkflowRun } from '@shared/workflow';
import {
  canSee,
  EFFORTS,
  isBusy,
  MAX_REPORT_CHARS,
  MAX_WAKEUP_MINUTES,
  MAX_WAKEUPS,
  modeWithin,
  parentMessageText,
  PERMISSION_MODES,
  projectRootOf,
  SESSION_STATE_LABEL,
  sessionEventText,
  sessionTool,
  SWITCHABLE_MODES,
  type SessionState,
} from '@shared/session-tools';
import { resumeContinued } from './compact-notice';
import { branchBase, branchFiles, git, repoInfo } from './git';
import { textResult, type ToolResult } from './mcp-bridge';
import type { ScheduledMessages } from './scheduled-messages';
import type { ScheduledMessage } from '@shared/scheduled';
import type { WaitingText } from './session-manager';
import type { WorktreeSetupTrouble } from './worktree';
import { SEND_FAILURE, SendError } from './send-error';
import { SessionNotices } from './session-notices';
import { WAIT_MAX_SECONDS } from './sessions-bridge';
import { WorktreeError, type WorktreeFailure } from './worktree';

// Claude による、ほかのセッションの扱い（MCP サーバー tanacode-sessions のツールの実行）。中継からの呼び出しを、ソケットで受けて答える。
// 呼び出し元のセッションは中継の env で渡ってくるので、親子の関係や見えるセッションは、アプリの記録（SessionSummary.parentId）で判断する。
// 読むだけのツールは、同じリポジトリのセッションと親子・兄弟だけを見せる（別のリポジトリの会話は読ませない）。
// 指示・中断・質問への答え・許可の確認への答えは、自分の子セッションにだけ。
// 許可の確認（answer_permission）は、「今回だけ許す」と「断る」だけ。許せるのは、親が読んだ確認（permission_id）がそのまま出ていて、
// ツールの入力の全文を親に渡せていて、親の権限モードが acceptEdits 以上のときだけ（manual・plan の親は、断ることだけ）。
// start_session は、子セッションのほかに、独立したセッション（親のない、人が動かすセッション）も始められる。こちらには最初の指示を送るだけ。
// end_session は、役目を終えた自分の子を片付ける（アーカイブして、worktree も消す）。画面からのアーカイブと同じ処理を通す。
// configure_session は、自分の子の権限モード（親より強くできない）・モデル・エフォート・Remote Control（親がオンのときだけオンにできる）を変える。
// 画面のモード欄・モデル欄・ヘッダーの Remote Control のトグルと同じ処理を通す。
// アプリ内ブラウザでの人の操作待ちは、ツールでは状態 browser として見せる（SessionManager.stateOf は作業中のまま。withBrowserState）
// schedule_wakeup・list_wakeups・cancel_wakeup は、自分のセッションへの予約（時刻を指定して送信と同じ流れ。scheduled-messages.ts）。子も使える。
// report_result は、ターンの終わりの通知に載せる報告を預ける（子は人に通知しないので、子でないセッションだけ）

// 人だけが答えられる確認かを決めるのに使う、許可の確認のツールと入力
export type PermissionTarget = { tool: string; input: Record<string, unknown> };

// SessionManager のうち、ツールが使うもの
export type SessionsHost = {
  list(): SessionSummary[];
  // 親セッションの ID（無ければ null）。状態の変化のたびに呼ぶので、一覧を作らずに引く
  parentOf(id: string): string | null;
  stateOf(id: string): SessionState | null;
  // 引き継いだ claude の、前のアプリが（動かしたまま）終えたときの状態。一度だけ返す（無ければ null）
  takeDetachedState?(id: string): SessionState | null;
  modeOf(id: string): PermissionMode | null;
  // 今のモデル（--model に渡せる値）とエフォート。分からなければ null
  currentModel(id: string): string | null;
  currentEffort(id: string): string | null;
  conversation(id: string): Promise<ChatEvent[]>;
  create(cwd: string, options: NewSessionOptions, parentId: string | null): string;
  createInWorktree(cwd: string, options: NewSessionOptions, parentId: string | null): Promise<string>;
  rename(id: string, title: string): void;
  // 権限モードを切り替える（Shift+Tab。動いていない子は、次に起動するときのモード）。切り替えられたら true
  setMode(id: string, mode: PermissionMode): Promise<boolean>;
  // モデル・エフォート・設定ファイルを変える。動いていれば、Claude Code を起動し直して同じ会話を続ける
  configure(id: string, options: SessionOptions): Promise<void> | void;
  open(id: string): Promise<void>;
  // 手が空いたら送る（待ち始めた順に）。子への最初の指示（{ parent, body, setupNote }）は、送る直前に worktree の準備の結果を添える。
  // keep: 送る前にアプリを終えても記録に残し、次にそのセッションを起動したら送り直す
  submitWhenReady(id: string, text: WaitingText, timeoutMs: number, options?: { keep?: boolean }): Promise<void>;
  // チャットとターミナルモードを切り替えている途中か（状態は starting だが、終わるまで送れない）
  switchingTerminal(id: string): boolean;
  // まだ会話に入っていない、送る発言（送った順）。held: アプリが預かっている（まだ Claude Code に渡していない）/ parent: 親の指示なら親の ID /
  // shown: 人の発言・親の指示（知らせ・予約でない）
  queuedMessages(id: string): { parent: string | null; text: string; held: boolean; shown: boolean }[];
  // 作業を中断する。止めるターンが開いていたら true（ターンの合間は、状態が作業中でも止めるものが無い）
  interrupt(id: string): boolean;
  // 今のターンを始めた送った発言が、まだ会話（conversation）に入っていなければ、その送り主（親の ID。人の発言なら null）。
  // 入っていれば・分からなければ null
  unseenTurnPrompt(id: string): { parent: string | null } | null;
  // 答えを待っている質問（いちばん前のもの）と、その 1 問への答え（全部そろったら返事にする）
  pendingQuestion(id: string): PendingQuestion | null;
  answerPendingQuestion(id: string, questionId: string, question: string, answer: string): 'sent' | 'waiting' | null;
  watchState(listener: (id: string) => void): () => void;
  // 答えを待っている許可の確認（いちばん前のもの。ツールの名前と入力の全文つき）と、それへの答え（もう待っていなければ false）
  pendingPermission(id: string): PendingPermission | null;
  replyPermission(id: string, requestId: string, reply: PermissionReply): boolean;
  // 答えを待っている MCP サーバーの質問（いちばん前のもの。完了を待っている URL の形の質問のこともある）。親には答えさせず、人に回す
  pendingElicitation(id: string): PendingElicitation | null;
  // バックグラウンドで動かしたもの（終わったものも入っている）。end_session で、Claude Code と一緒に止まるものを伝えるために読む
  subagents(id: string): SubagentRun[];
  bashTasks(id: string): BashTask[];
  workflows(id: string): WorkflowRun[];
  // worktree を消す前に、残っているもの（worktree のセッションでなければ null）
  worktreeLeftovers(id: string): Promise<WorktreeLeftovers | null>;
  // worktree の準備（node_modules）でうまくいかなかったこと（無ければ null）
  worktreeSetup(id: string): WorktreeSetupTrouble | null;
  // Claude がアプリ内ブラウザで人に操作を頼んでいるか（ask_user_to_act）
  browserAsking(id: string): boolean;
  // Remote Control を切り替える（チャットのヘッダーのトグルと同じ）。切り替えられなければ、理由（画面の言語）
  setRemoteControl(id: string, on: boolean): Promise<string | null>;
  // Remote Control を使えるか（開発版では使えない）
  remoteAvailable(): boolean;
  // Remote Control が今つながっているか（null: つながるのを待っている。Claude Code が動いていなければ false）
  remoteConnectedOf(id: string): boolean | null;
};

// 予約したメッセージ（ScheduledMessages）のうち、自分への予約のツールが使うもの
export type WakeupHost = Pick<ScheduledMessages, 'list' | 'add' | 'cancel' | 'claudeWakeups' | 'saving'>;

type Deps = {
  host: SessionsHost;
  // メニューの「Claude にほかのセッションを扱わせる」
  enabled: () => boolean;
  // セッションをアーカイブする。画面からのアーカイブと同じ処理（アプリ内ブラウザ・シェルの後始末も）。worktree を消せなければ、
  // アーカイブはしたうえで、理由を添えて失敗する
  archive: (id: string, options: ArchiveOptions) => Promise<WorktreeRemoval | null>;
  // 子の許可の確認のうち、人だけが答えられるもの（アプリ内ブラウザで、許す先の外を開く）。当たれば、親に許させない理由（英語）
  humanOnly?: (sessionId: string, request: PermissionTarget) => string | null;
  // ホームのフォルダ（ここを開いたセッションに、ホームの下のすべてのセッションを見せないため）
  home: string;
  // 予約したメッセージ（自分への予約に使う）。予約は SessionsControl より後で作るので、取り出す関数で渡す
  scheduled?: () => WakeupHost | null;
  // ターンの終わりの通知に載せる報告を預ける（turn-reports.ts）
  report?: (id: string, text: string) => void;
  // 親への知らせをまとめるまでの待ち（テストでは短くする）
  notifyDelayMs?: number;
  // そのセッションで、最適化圧縮の流れが進んでいるか（host の stateOf は、その間「作業中」を返す。outward-state.ts）。
  // 流れで作業中に見えているだけの子では、親への知らせを取り下げない
  compacting?: (id: string) => boolean;
  // 質問に答えたあと、子の次の質問を待つ上限（テストでは短くする）
  followUpMs?: number;
  // 起動中のまま、end_session で終えられるようになるまで（テストでは短くする）
  stuckStartingMs?: number;
  // 今の時刻（起動中の時間を数える。テストでは差し替える）
  now?: () => number;
};

// 質問に答えたあと、子が続けて出す次の質問を待つ上限。子は、答えを受け取ってから数秒で次の質問を出す
const FOLLOW_UP_MS = 20_000;
// 子セッションの最初の指示を、起動（worktree の準備も含む）が終わるまで待つ上限
const FIRST_PROMPT_TIMEOUT_MS = 30 * 60_000;
// 子セッションへの指示を、子の手が空くまで預かる上限（作業中の子には、ターンが終わってから打つ）
const SEND_TIMEOUT_MS = 3 * 60 * 60_000;
// 手の空いている子に打つときの待ちの上限（すぐ打てるはず）
const SEND_IDLE_TIMEOUT_MS = 30_000;
// get_session_diff で、未追跡のファイルを読む数と、1 つのファイルから読む大きさの上限
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_BYTES = 256 * 1024;
// 1 回の結果の文字数の上限（親のコンテキストを食いつぶさないため）
const MAX_RESULT_CHARS = 60_000;
// 許可の確認で、親に渡すツールの入力（JSON）の大きさの上限（UTF-8 のバイト）。超えるものは全文を渡せないので、親には許させない。
// Claude Code は MCP のツールの結果をトークン（既定は 2.5 万。人の設定で減らせる）で数えて切るので、文字数ではなく、1 文字が多くの
// トークンになる文字（日本語など）でも上限に収まるよう、バイトで数える（1 トークンは 1 バイト以上）
const MAX_PERMISSION_INPUT_BYTES = 20_000;
// 親が子の許可の確認を許せる、親の権限モード（manual・plan の親は、自分の操作も人が毎回許すので、子の操作も許せない）
const MODES_ALLOWING_PERMISSION = new Set<PermissionMode>(['acceptEdits', 'auto', 'bypassPermissions']);
// wait_sessions の既定の待ち。待っている間は人の発言が届かないので、短くする（上限は WAIT_MAX_SECONDS）
const WAIT_DEFAULT_SECONDS = 30;
// get_session・read_session で返す、最後の応答の文字数（既定と、max_response_chars で上げられる上限）。長いものは真ん中を切る
const RESPONSE_CHARS = 4000;
const MAX_RESPONSE_CHARS = 50_000;
// 起動中のまま、end_session で終えられるようになるまでの時間。ふつうの起動（worktree を作る・Claude Code の立ち上がり）は、これより早く終わる。
// 止まった起動（Claude Code が立ち上がらない・準備が終わらない）の子を、親が片付けられるように。
// worktree の依存の install の間は、時間のかかるふつうの install を止まったとみなさないよう、最初の指示を待つ上限（30 分）まで待つ
const STUCK_STARTING_MS = 5 * 60_000;
// list_wakeups で返す、予約の本文の文字数の上限
const MAX_WAKEUP_TEXT_CHARS = 300;
// 予約のファイルを読めず、保存しないときに添える一言
const WAKEUPS_UNSAVED =
  'Note: tanacode could not read its saved file of scheduled messages (no permission, or written by a newer version of tanacode), so scheduled messages are not saved: the ones not sent yet are lost when tanacode quits. Tell the user (this note is given only once, not in every result).';
// schedule_wakeup の at の形（ISO 8601。時差の無い時刻は、どこの時刻か分からないので受けない）
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
// 起動が終わる前（予約・報告の受け手を作る前）に届いた呼び出しに返すもの
const NOT_READY = 'tanacode has not finished starting up. Wait a moment and try again.';
// 送れなかった指示を親への知らせに入れる長さ（親が見分けて送り直せるように。知らせは 1 行なので、長いものは頭だけ）
const MAX_FAILED_MESSAGE_CHARS = 300;
// send_message で預かった指示の、届くまでの確かめ方と、送れなかったとき
const QUEUED_NOTE =
  'Until the child receives it, get_session shows it in queued_messages, so do not send it again. If it cannot be sent (for example, the child does not become free in time or the user switches it to terminal mode), a notice tells you why.';
// list_sessions で返す、セッションを始められるフォルダの数の上限
const MAX_START_FOLDERS = 30;

// 編集したファイルとして数えるツール
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// 親に知らせる、子の手が空いた状態。バックグラウンドのタスクの完了待ちも、ターンは終わっているので知らせる。
// 子セッションは人に通知しないので、人が答える許可の確認・アプリ内ブラウザでの操作の待ちも、親に知らせて人に伝えさせる
const NOTIFY_STATES = new Set<SessionState>(['idle', 'background', 'question', 'permission', 'terminal', 'browser', 'exited']);

// worktree を作れない・消せない理由の英語の文（WorktreeError の message は画面の言語なので、Claude には返さない）
const WORKTREE_FAILURE: Record<WorktreeFailure, string> = {
  notRepo: 'the folder is not in a git repository',
  noCommit: 'the repository has no commits yet',
  noName: 'no unused name for a new worktree could be found',
  locked: 'the worktree is locked',
  closedWhileCreating: 'the session was archived or removed from the session list while its worktree was being created',
  submoduleChanges:
    'removing the worktree would lose uncommitted changes, untracked files, stashes or commits that are on no remote inside the submodules listed in parentheses. Commit and push them inside each submodule, or discard them, before removing the worktree',
  usedBySession: 'a session that is not archived (named in parentheses) is running inside the worktree. End or archive that session first, then remove the worktree',
};

// ターンが終わった状態（親が止めた印を片付ける）
const TURN_ENDED_STATES = new Set<SessionState>(['idle', 'background', 'exited', 'archived']);

// end_session で終えられる状態。手が空いている・Claude Code が動いていない・裏のタスクの完了待ち（ターンは終わっている）・アーカイブ済み（残った worktree を消す）
const ENDABLE_STATES = new Set<SessionState>(['idle', 'exited', 'background', 'archived']);
// 終えられない状態ごとの、断る理由と次にできること（子の名前に続ける）。起動中は、待った時間を添えて endSession で作る
const END_REFUSAL: Partial<Record<SessionState, string>> = {
  working:
    'is working, so it was not ended. Wait for it to finish (check with get_session), or, if its work is no longer needed, interrupt it with stop_session first and then call end_session again. If you are not sure whether its work is still needed, ask the user.',
  question:
    'is waiting for an answer to a question, so its work is not finished and it was not ended. Answer the question with answer_question (get_session shows it) and let it finish, or ask the user whether to end it.',
  permission:
    'is waiting for an answer to a permission prompt, so its work is not finished and it was not ended. Answer the prompt with answer_permission (get_session shows it) or ask the user, and call end_session again once the child is idle.',
  terminal: 'is in terminal mode: the user is working in its Claude Code screen, so it was not ended. Tell the user, and call end_session again once the user has switched it back to the chat.',
  browser:
    'is waiting for the user to act in the in-app browser, so its work is not finished and it was not ended. Tell the user, and call end_session again once the child is idle. If its work is no longer needed, interrupt it with stop_session first.',
};

// configure_session で、権限モードを切り替えられる状態。手が空いている・裏のタスクの完了待ち・作業中（set_permission_mode は作業中でも効く。
// 実測）・動いていない（次の起動のモード）
const MODE_SWITCHABLE_STATES = new Set<SessionState>(['idle', 'background', 'working', 'exited']);
// モデル・エフォートを変えられる状態。動いている Claude Code をその場で切り替える（set_model・apply_flag_settings）ので、裏のタスクは止まらない。
// 作業中は、応答の途中で変えないよう除く
const MODEL_SWITCHABLE_STATES = new Set<SessionState>(['idle', 'background', 'exited']);
// Remote Control を切り替えられる状態（作業中は、つなぎ直しで応答を止めないよう除く）
const REMOTE_SWITCHABLE_STATES = new Set<SessionState>(['idle', 'background', 'exited']);
// 変えられない状態ごとの、断る理由と次にできること（子の名前に続ける）
const CONFIGURE_REFUSAL: Partial<Record<SessionState, string>> = {
  starting: 'is still starting up. Wait until it is idle (check with get_session), then call configure_session again.',
  working:
    'is working, so nothing was changed (only its permission mode can be switched while it works, when changed alone). Wait for it to finish (check with get_session), or interrupt it with stop_session, then call configure_session again and tell it to continue with send_message.',
  question: 'is waiting for an answer to a question, so nothing was changed. Answer it with answer_question (get_session shows it) or let the user answer it, then call configure_session again.',
  permission:
    'is waiting for an answer to a permission prompt, so nothing was changed. Answer it with answer_permission (get_session shows it) or ask the user, then call configure_session again.',
  terminal: 'is in terminal mode: the user is working in its Claude Code screen, so nothing was changed. Ask the user to switch it back to the chat, then call configure_session again.',
  browser:
    'is waiting for the user to act in the in-app browser, so nothing was changed. Tell the user, and call configure_session again once the child is idle (or interrupt it with stop_session first).',
};

class ToolError extends Error {}

export class SessionsControl {
  // 子セッションの、前に見た状態（作業中から手が空いたことを知るため）
  private readonly lastState = new Map<string, SessionState | null>();
  // 親に知らせる子の出来事（親の ID → 子の ID → 状態と時刻、利用枠で止まったならその知らせ）。親の手が空いたら送る
  private readonly notices: SessionNotices<ChildNotice>;
  // 親が子の状態を読んだ時刻（`親:子`）。読んだあとの知らせは送らない
  private readonly observedAt = new Map<string, number>();
  // 最適化圧縮の流れが進んだ子（流れが始まってから、再開の文のターンが終わるまで）
  private readonly compacted = new Set<string>();
  // 親が止めた子（止めるターンが開いていたもの）。止めて終わったターンは、親に知らせない
  private readonly stopped = new Set<string>();
  // 裏のタスクが動いたままターンを終えたことを、親に知らせた子（`親:子`）。裏のタスクの知らせ（Monitor の途中の知らせなど）で
  // 始まったターンが、また完了待ちで終わっても、知らせ直さない
  private readonly backgroundTold = new Set<string>();
  // 起動中になった時刻（起動中の子だけ）。長く起動中のままの子を、end_session で終えられるようにする
  private readonly startingSince = new Map<string, number>();
  // end_session で終えた子。預かっていた指示を送れなかったことを、終えた親に知らせ直さない。人がアーカイブから戻した・一覧から消したら外す
  private readonly ended = new Set<string>();
  // 予約を保存しないことを結果に添えたセッション。Claude が呼ぶたびに人へ伝え直さないよう、最初の 1 回だけ添える（画面の予約にも出ている）
  private readonly wakeupsUnsavedNoted = new Set<string>();
  private readonly unwatch: () => void;
  private readonly deps: Deps;
  // 元の host（アプリ内ブラウザでの人の操作待ちを、browser に置き換えない）
  private readonly raw: SessionsHost;

  constructor(deps: Deps) {
    // ツールで返す状態・親への知らせ・断る理由では、アプリ内ブラウザでの人の操作待ちを、状態 browser として見せる
    this.deps = { ...deps, host: withBrowserState(deps.host) };
    this.raw = deps.host;
    for (const s of deps.host.list()) this.trackState(s.id, this.deps.host.stateOf(s.id));
    this.unwatch = this.deps.host.watchState((id) => this.stateChanged(id));
    this.notices = new SessionNotices({
      // 知らせを受け取れるか（親の手が空いているか）は、元の状態で見る
      host: this.raw,
      enabled: deps.enabled,
      compose: (parentId, queue) => this.noticeFor(parentId, queue),
      delayMs: deps.notifyDelayMs,
      // 親が利用枠で止まって再開を待っている間は、子の知らせを送らない（送っても、親のターンが同じ枠で断られるだけ）。
      // 再開して手が空いたら送る
      holds: (parentId) => this.usageResumeAt(parentId) !== null,
      // 親が忙しくて預かっている間にアプリを終えても、次のアプリが戻して、親の手が空いたら送る
      channel: 'sessions',
    });
  }

  dispose(): void {
    this.unwatch();
    this.notices.dispose();
  }

  // 予約が変わった（ScheduledMessages の onChanged）。親の利用枠の再開の予約を人が取り消した・送れなかったときは、親の状態が
  // 変わらないまま預かる理由が無くなるので、預かっている子の知らせを送れるか見直す
  scheduledChanged(): void {
    this.notices.recheck();
  }

  // signal: Claude Code が呼び出しを取り消した（Esc で中断した）。待っている wait_sessions をやめる
  async handle(callerId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (!sessionTool(name)) return textResult(`Unknown tool: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult(`The user has turned off "${t('main.menu.sessionsControl')}" in the tanacode menu. Ask the user to turn it on.`, true);
    }
    const caller = this.summary(callerId);
    if (!caller) return textResult('This session is not in tanacode.', true);
    try {
      switch (name) {
        case 'list_sessions':
          return await this.listSessions(caller, args);
        case 'read_session':
          return await this.readSession(caller, args);
        case 'get_session_diff':
          return await this.sessionDiff(caller, args);
        case 'get_session':
          return await this.getSession(caller, args);
        case 'wait_sessions':
          return await this.waitSessions(caller, args, signal);
        case 'start_session':
          return await this.startSession(caller, args);
        case 'send_message':
          return await this.sendMessage(caller, args);
        case 'answer_question':
          return await this.answerQuestion(caller, args);
        case 'answer_permission':
          return await this.answerPermission(caller, args);
        case 'configure_session':
          return await this.configureSession(caller, args);
        case 'stop_session':
          return await this.stopSession(caller, args);
        case 'end_session':
          return await this.endSession(caller, args);
        case 'schedule_wakeup':
          return this.scheduleWakeup(caller, args);
        case 'list_wakeups':
          return this.listWakeups(caller);
        case 'cancel_wakeup':
          return this.cancelWakeup(caller, args);
        case 'report_result':
          return this.reportResult(caller, args);
        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (error) {
      return textResult(errorText(error), true);
    }
  }

  // --- 読むだけのツール ---

  private async listSessions(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const all = this.visible(caller);
    const list = all.filter((s) => args.include_archived === true || !s.archived);
    const branches = await Promise.all(list.map((s) => branchOf(s)));
    return json({
      self: caller.id,
      // start_session の folder に選べる、ほかのフォルダ（子は始められないので出さない）
      ...(caller.parentId ? {} : { start_folders: this.knownFolders().slice(0, MAX_START_FOLDERS) }),
      sessions: list.map((s, i) => ({
        ...this.describe(s, caller),
        branch: branches[i],
        children: all.filter((c) => c.parentId === s.id).map((c) => c.id),
        updated_at: new Date(s.updatedAt).toISOString(),
      })),
    });
  }

  private async readSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.resolve(caller, args.session_id);
    const turns = intArg(args.turns, 1, 20, 3);
    const responseChars = intArg(args.max_response_chars, RESPONSE_CHARS, MAX_RESPONSE_CHARS, RESPONSE_CHARS);
    const events = await this.deps.host.conversation(target.id);
    this.observe(caller.id, target.id);
    const all = this.visible(caller);
    const titleOf = (id: string) => nameOf(all.find((s) => s.id === id));
    const lines = [`# Session "${nameOf(target)}"`, ...this.headerLines(target, caller, all), ''];
    lines.push(...conversationLines(events, turns, titleOf, target.parentId ?? null, responseChars), '');
    const edited = editedFiles(events, target.cwd);
    lines.push("## Files edited in this session's conversation", ...(edited.length > 0 ? edited.map((f) => `- ${f}`) : ['(none)']));
    return textResult(clip(lines.join('\n'), MAX_RESULT_CHARS));
  }

  private async sessionDiff(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.resolve(caller, args.session_id);
    this.observe(caller.id, target.id);
    const cwd = target.cwd;
    if (!existsSync(cwd)) throw new ToolError(`The folder of "${nameOf(target)}" does not exist (for example, its worktree was removed).`);
    const path = typeof args.path === 'string' && args.path.trim() ? safeRelative(args.path.trim()) : null;
    const info = await repoInfo(cwd).catch(() => null);
    const inRepo = await git(cwd, ['rev-parse', '--is-inside-work-tree']).then(
      () => true,
      () => false,
    );
    if (!info || !inRepo) throw new ToolError(`The folder of "${nameOf(target)}" is not a git repository.`);
    if (info.empty) throw new ToolError(`The repository of "${nameOf(target)}" has no commits yet.`);
    const base = await branchBase(cwd, info).catch(() => null);
    // 基点が決まらなければ、未コミットの変更だけを見せる
    const ref = base?.mergeBase ?? 'HEAD';
    const inPath = (file: string) => !path || file === path || file.startsWith(`${path}/`);
    const files = (await branchFiles(cwd, ref)).filter((f) => inPath(f.path));
    // path は git の pathspec の書き方（:(top) など）として読ませず、書いたままのパスとして渡す
    const literal = { GIT_LITERAL_PATHSPECS: '1' };
    const tracked = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--relative', '--no-renames', '--no-color', ref, '--', ...(path ? [path] : [])], undefined, literal);
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...(path ? [path] : [])], undefined, literal))
      .split('\0')
      // セッションのフォルダの外を指すもの（../ で始まるもの）は読まない
      .filter((file) => file && !isAbsolute(file) && file !== '..' && !file.startsWith('../'));
    // 未追跡のファイルは 1 つずつ、結果の上限に達したら読むのをやめる
    const folder = await realpath(cwd).catch(() => cwd);
    const added: string[] = [];
    let size = tracked.length;
    for (const file of untracked.slice(0, MAX_UNTRACKED_FILES)) {
      if (size > MAX_RESULT_CHARS) break;
      const part = await untrackedDiff(cwd, folder, file);
      added.push(part);
      size += part.length;
    }
    const rest = untracked.length - added.length;
    if (rest > 0) added.push(`(${rest} more untracked ${rest === 1 ? 'file' : 'files'}. Narrow it down with path.)`);
    const diff = [tracked.trimEnd(), ...added].filter(Boolean).join('\n');
    const lines = [
      `# Branch changes of session "${nameOf(target)}"`,
      `- Branch: ${info.branch ?? '(no branch)'}`,
      base ? `- Base: ${base.ref} (merge base ${base.mergeBase.slice(0, 8)})` : '- Base: unknown, so only uncommitted changes (diff against HEAD)',
      `- Files: ${files.length}${path ? ` (only in ${path})` : ''}`,
      ...files.map((f) => `  - ${KIND_MARK[f.kind]} ${f.path}${f.binary ? ' (binary)' : ` (+${f.added} −${f.removed})`}`),
      '',
      '## Diff',
      diff ? fence(diff, 'diff') : '(no changes)',
    ];
    return textResult(clip(lines.join('\n'), MAX_RESULT_CHARS));
  }

  private async getSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.resolve(caller, args.session_id);
    this.observe(caller.id, target.id);
    // 最後の応答は、max_response_chars まで返す。結果の全体が上限を超えるなら、超えた分だけ応答を短くする（既定の長さまで）
    let responseChars = intArg(args.max_response_chars, RESPONSE_CHARS, MAX_RESPONSE_CHARS, RESPONSE_CHARS);
    for (;;) {
      const text = JSON.stringify(await this.status(target, caller, true, responseChars), null, 2);
      if (text.length <= MAX_RESULT_CHARS || responseChars <= RESPONSE_CHARS) return textResult(text);
      responseChars = Math.max(RESPONSE_CHARS, responseChars - (text.length - MAX_RESULT_CHARS) - 200);
    }
  }

  private async waitSessions(caller: SessionSummary, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const { host } = this.deps;
    const timeoutMs = intArg(args.timeout_seconds, 1, WAIT_MAX_SECONDS, WAIT_DEFAULT_SECONDS) * 1000;
    const ids = Array.isArray(args.session_ids) ? args.session_ids : [];
    const children = host.list().filter((s) => s.parentId === caller.id && !s.archived);
    const targets = ids.length > 0 ? ids.map((id) => this.resolve(caller, id, true)) : children.filter((s) => isBusy(host.stateOf(s.id) ?? 'exited'));
    if (targets.length === 0) {
      return json({
        timed_out: false,
        note: children.length > 0 ? 'No child session is working.' : 'There are no child sessions.',
        sessions: await Promise.all(children.map((s) => this.status(s, caller, false))),
      });
    }
    const ready = () => targets.filter((t) => !isBusy(host.stateOf(t.id) ?? 'exited'));
    if (ready().length === 0) await this.until(() => ready().length > 0, timeoutMs, signal);
    const done = new Set(ready().map((t) => t.id));
    for (const id of done) this.observe(caller.id, id);
    return json({
      timed_out: done.size === 0,
      ready: [...done],
      sessions: await Promise.all(targets.map((t) => this.status(this.summary(t.id) ?? t, caller, done.has(t.id)))),
    });
  }

  // --- 子セッションを動かすツール ---

  private async startSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    if (caller.parentId) throw new ToolError('A child session cannot start sessions (only one level of children, and no independent sessions).');
    const prompt = stringArg(args.prompt);
    if (!prompt) throw new ToolError('prompt (the first instruction) is empty.');
    if (typeof args.worktree !== 'boolean') throw new ToolError('Pass worktree (whether to start in a new worktree) as true or false.');
    if (args.independent !== undefined && typeof args.independent !== 'boolean') throw new ToolError('Pass independent as true or false.');
    // 独立したセッション: 親のない、ふつうのセッションとして始める（人が動かす。このセッションからは指示も中断もできない）
    const independent = args.independent === true;
    const folder = await this.folderFor(caller, args.folder, args.worktree);
    // 権限モードは、このセッションより強くできない（親を通じて、人が許していない操作を通さないため）
    const limit = host.modeOf(caller.id) ?? 'manual';
    const wanted = args.permission_mode === undefined ? (limit === 'plan' ? 'manual' : limit) : args.permission_mode;
    if (!PERMISSION_MODES.includes(wanted as PermissionMode)) throw new ToolError(`Unknown permission mode: ${String(wanted)}`);
    const mode = wanted as PermissionMode;
    if (!modeWithin(mode, limit)) throw new ToolError(`Permission mode ${mode} cannot be used because it is more permissive than this session's (${limit}).`);
    // モデルとエフォートは、省けばこのセッションの今のもの（途中で変えていれば、変えたあとのもの）。分からなければ Claude Code の既定
    const callerEffort = host.currentEffort(caller.id);
    const options: NewSessionOptions = {
      model: stringArg(args.model) || host.currentModel(caller.id),
      effort: stringArg(args.effort) || (callerEffort && EFFORTS.includes(callerEffort) ? callerEffort : null),
      // 登録した設定ファイル（別のアカウントなど）は、親と同じものを使う
      settingsFile: caller.settingsFile,
      mode,
      // Remote Control も、このセッションの指定に合わせる（子も。Remote Control から頼まれて始めたセッションを、そのまま外から操作できるように）
      remoteControl: caller.remoteControl,
      worktree: args.worktree,
      // 起動のモードを、開き直すときの上限として残す（独立したセッションも。開き直したときに、呼び出し元より強いモードにならないように）
      capMode: true,
    };
    const parentId = independent ? null : caller.id;
    const id = options.worktree
      ? await host.createInWorktree(folder, options, parentId).catch((error: unknown) => {
          throw error instanceof WorktreeError ? new ToolError(`Could not start the session in a new worktree: ${errorText(error)}.`) : error;
        })
      : host.create(folder, options, parentId);
    const name = stringArg(args.name);
    if (name) host.rename(id, name);
    this.trackState(id, host.stateOf(id));
    // 起動（worktree の準備も）が終わってから送る。待たずに返す（結果は wait_sessions で待つ）
    // worktree の準備でうまくいかなかったこと（install の失敗など）は、送るときに指示の本文に添える（SessionManager の waitingText）。
    // 送る前にアプリを終えても、次のアプリが子を引き継いだら送る（keep）
    void host.submitWhenReady(id, { parent: caller.id, body: prompt, setupNote: true }, FIRST_PROMPT_TIMEOUT_MS, { keep: true }).catch((error: unknown) => {
      console.error('子セッションに最初の指示を送れませんでした', error);
      // 送れなかったこと（準備が長すぎた・止まったなど）は、親に知らせる（親は、送られるものとして待っている）。親が end_session で終えたなら知らせない
      if (!parentId || this.ended.has(id) || !this.summary(id)) return;
      const reason = error instanceof Error ? error.message : String(error);
      this.notices.add(caller.id, `first:${id}`, { child: id, state: 'idle', at: Date.now(), firstPrompt: reason, firstMessage: prompt });
    });
    const child = this.summary(id);
    // worktree の準備は、最初の指示より前に済む。親が子に準備（作る・依存を入れる）を頼まないように伝える。
    // うまくいかなかったときに、どこで分かるかも伝える
    const setup = options.worktree
      ? ` The worktree is set up before the first instruction is sent (the state is starting until then), so the ${independent ? 'session' : 'child'} needs no setup for the worktree itself. If installing its dependencies fails, the first instruction says so${independent ? '' : ' and get_session shows it in worktree.setup_problems'}.`
      : '';
    return json({
      session_id: id,
      name: name || null,
      folder: child?.cwd ?? folder,
      worktree: child?.worktree ? { name: child.worktree.name, branch: child.worktree.branch } : null,
      independent,
      model: options.model,
      effort: options.effort,
      permission_mode: mode,
      remote_control: options.remoteControl,
      state: host.stateOf(id),
      note: independent
        ? `The first instruction will be sent as soon as the session has started.${setup} It is an independent session that the user runs: you cannot instruct, wait for or stop it, and no notice arrives when it finishes. Tell the user it has started.`
        : `The first instruction will be sent as soon as the child has started.${setup} A notice arrives when the child finishes its work or stops on a question or a permission prompt: end your turn and wait for it (do not wait synchronously, and do not schedule wake-ups to check on the child).`,
    });
  }

  private async sendMessage(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const message = stringArg(args.message);
    if (!message) throw new ToolError('message (the instruction to send) is empty.');
    const state = host.stateOf(child.id);
    const who = `"${nameOf(child)}"`;
    if (state === 'archived') throw new ToolError(`${who} is archived. To continue it, ask the user to restore it with "${t('sessions.sidebar.unarchive')}" in the session list.`);
    if (state === 'question') {
      const asked = askingElicitation(host, child.id);
      if (asked) throw new ToolError(`${who} is waiting for the user to answer a question from the MCP server "${asked.server}". Only the user can answer it, in the child session, so the message was not sent. Tell the user.`);
      throw new ToolError(`${who} is waiting for an answer to a question. Answer it with answer_question (get_session shows the question).`);
    }
    if (state === 'permission') throw new ToolError(`${who} is waiting for an answer to a permission prompt. Read it with get_session and answer it with answer_permission, or ask the user.`);
    // ターミナルモードの間と、切り替えの途中は、預からずにその場で断る（決めたこと）
    if (state === 'terminal') throw new ToolError(`${who} is in terminal mode: the user is working in its Claude Code screen, so the message was not sent (and not kept for later). Tell the user, or send it again once get_session shows that the child is back in the chat.`);
    if (host.switchingTerminal(child.id)) {
      throw new ToolError(`${who} is being switched between the chat and terminal mode by the user, so the message was not sent (and not kept for later). Check it with get_session, and send it again once it is back in the chat.`);
    }
    // ターミナルモードで止まった子は、起動し直すと TUI になって送れないので、起動せずに断る
    if (state === 'exited' && child.terminal) {
      throw new ToolError(`${who} is stopped in terminal mode: it starts again in its Claude Code screen, where only the user can type, so it was not started and the message was not sent (and not kept for later). Tell the user, or send it again once the user has switched it back to the chat.`);
    }
    const text = parentMessageText(caller.id, message);
    // 手の空いている子には、すぐ打つ。送れなかった理由は、画面の言語の文でなく英語で返す
    if (state === 'idle' || state === 'background') {
      await host.submitWhenReady(child.id, text, SEND_IDLE_TIMEOUT_MS).catch((error: unknown) => {
        throw error instanceof SendError ? new ToolError(`${who}: the message was not sent because ${SEND_FAILURE[error.reason]}. Check it with get_session, and send it again if needed.`) : error;
      });
      return json({ session_id: child.id, state: host.stateOf(child.id), note: 'Sent.' });
    }
    // 作業中・起動中・止まっている子は、手が空くまでアプリが預かってから打つ（作業中に打つと、そのあいだに出た許可の確認で、
    // Enter や数字が選択になってしまうことがあるため）。待たずに返す
    if (state === 'exited') await host.open(child.id);
    // 送る前にアプリを終えても、次のアプリが子を引き継いだら（止まっている子は、次に起動したら）送る（keep）
    // 送れなかったこと（子の手が空かない・人がターミナルモードに切り替えたなど）は、理由を添えて親に知らせる（親は、送られるものとして待っている）
    void host.submitWhenReady(child.id, text, SEND_TIMEOUT_MS, { keep: true }).catch((error: unknown) => {
      console.error('子セッションに指示を送れませんでした', error);
      // 終えた子・一覧から消えた子には、もう送れないので知らせない
      if (this.ended.has(child.id) || !this.summary(child.id)) return;
      const reason = error instanceof Error ? error.message : String(error);
      this.notices.add(caller.id, `send:${child.id}:${randomUUID()}`, { child: child.id, state: 'idle', at: Date.now(), sendFailed: { message, reason } });
    });
    return json({
      session_id: child.id,
      state: host.stateOf(child.id),
      note:
        state === 'exited'
          ? `Restarted the child. The instruction will be sent as soon as it has started. ${QUEUED_NOTE}`
          : state === 'starting'
            ? `The child is starting up, so the instruction will be sent as soon as it has started (queued). ${QUEUED_NOTE}`
            : `The child is working, so the instruction will be sent as soon as it finishes its current work (queued). ${QUEUED_NOTE}`,
    });
  }

  private async answerQuestion(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const asked = stringArg(args.question);
    const choices = Array.isArray(args.choices) ? args.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : [];
    // 自由記述は、キー操作になる文字（ESC など）を除く（改行はそのまま渡す）
    const typed = stripControlChars(stringArg(args.other)).trim();
    if (choices.length === 0 && !typed) throw new ToolError('Pass choices (the options to pick) or other (a free-text answer).');
    if (host.stateOf(child.id) === 'terminal') throw new ToolError(`"${nameOf(child)}" is in terminal mode: the user answers its prompts in its Claude Code screen, so nothing was answered. Tell the user.`);
    const pending = host.pendingQuestion(child.id);
    if (pending) return this.answerPending(caller, child, pending, asked, choices, typed);
    // 許可の確認には答えさせない（answer_permission で答える）
    if (host.pendingPermission(child.id)) throw new ToolError(`"${nameOf(child)}" is showing a permission prompt, not a question. Answer it with answer_permission (get_session shows it).`);
    // MCP サーバーから人への質問には、親は答えない（人に回す。決めたこと）
    const elicitation = askingElicitation(host, child.id);
    if (elicitation) throw new ToolError(`"${nameOf(child)}" is showing a question from the MCP server "${elicitation.server}" (mcp_question in get_session). Only the user can answer it, in the child session, so nothing was answered. Tell the user.`);
    throw new ToolError('No question is showing (the user answered it first, or it was withdrawn). Check with get_session.');
  }

  // 答えを待っている質問に、1 問答える。質問が複数あれば、アプリが答えをためて、全部そろったらまとめて Claude Code に返す。
  // まだ答えていない質問が残っていれば、それを next_question として返す
  private async answerPending(caller: SessionSummary, child: SessionSummary, pending: PendingQuestion, asked: string, choices: string[], other: string): Promise<ToolResult> {
    const { host } = this.deps;
    const current = currentOf(pending);
    if (!current) throw new ToolError('No question is showing (the user answered it first, or it was withdrawn). Check with get_session.');
    if (normalizeText(current.question) !== normalizeText(asked)) {
      throw new ToolError(`The question showing now is "${current.question}" (the user answered first, or it has moved on to the next question). To answer it, pass this question text as question.`);
    }
    const picked = choices.map((label) => {
      const option = current.options.find((o) => normalizeText(o.label) === normalizeText(label));
      if (!option) throw new ToolError(`There is no option "${label}". The options are: ${current.options.map((o) => `"${o.label}"`).join(', ')}.`);
      return option.label;
    });
    if (!current.multiSelect && picked.length + (other ? 1 : 0) !== 1) throw new ToolError('Only one option can be picked for this question (pass one choice, or only other).');
    const result = host.answerPendingQuestion(child.id, pending.id, current.question, answerText(current, picked, other));
    if (!result) throw new ToolError('No question is showing (the user answered it first, or it was withdrawn). Check with get_session.');
    this.observe(caller.id, child.id);
    if (result === 'waiting') {
      const rest = host.pendingQuestion(child.id);
      return answeredResult(host.stateOf(child.id), rest ? pendingQuestionOf(rest) : null);
    }
    const next = await this.followUpQuestion(child.id, pending.id);
    return answeredResult(host.stateOf(child.id), next);
  }

  // 答えたあと、子が続けて出す次の質問を、少しのあいだ待つ。出たら、その質問を返す。
  // 子は、決めることがいくつもあるとき、1 問ずつ別々の AskUserQuestion で聞くことが多い（「1/3」「2/3」…）。答えた直後の子は作業中でも、
  // 数秒で次の質問を出す。待たずに返すと、親は「作業中」と見て離れ、次の質問が、親がもう一度見に来るまで待たされる
  // （2026-10-12、3 問のうち 1 問ごとに、次の質問が 1 分以上待たされた）。
  // 子の手が空いた・人の操作待ちになった・終了したら、次の質問は来ないので、待つのをやめる。answered: 答えた質問（次の質問ではない）
  private async followUpQuestion(id: string, answered: string): Promise<Record<string, unknown> | null> {
    const { host } = this.deps;
    const limit = this.deps.followUpMs ?? FOLLOW_UP_MS;
    const deadline = Date.now() + limit;
    for (;;) {
      const pending = host.pendingQuestion(id);
      if (pending && pending.id !== answered) return pendingQuestionOf(pending);
      const state = host.stateOf(id);
      if (state !== 'working' && state !== 'starting' && state !== 'question') return null;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(200, Math.max(1, limit / 5)));
    }
  }

  // 子が出している許可の確認に、親が答える。選べるのは「今回だけ許す」か「断る」だけで、許可を覚えさせる・権限モードを変える答えはしない。
  // 答えるのは、親が get_session で読んだ確認（permission_id。Claude Code の要求の ID）が、まだ答えを待っているときだけ
  private async answerPermission(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const who = `"${nameOf(child)}"`;
    const id = stringArg(args.permission_id);
    if (!id) throw new ToolError('Pass permission_id (permission.id from get_session) to say which permission prompt you are answering.');
    if (args.decision !== 'allow' && args.decision !== 'deny') throw new ToolError('Pass decision as "allow" or "deny".');
    const allow = args.decision === 'allow';
    const reason = stripControlChars(stringArg(args.reason)).trim();
    if (allow && reason) throw new ToolError('reason is only for decision "deny". To allow with a condition, allow it and then instruct the child with send_message.');
    if (host.stateOf(child.id) === 'terminal') throw new ToolError(`${who} is in terminal mode: the user answers its prompts in its Claude Code screen, so nothing was answered. Tell the user.`);
    const shown = host.pendingPermission(child.id);
    if (!shown) throw new ToolError(`${who} is not showing a permission prompt that can be answered here (the user answered it first). Check with get_session.`);
    const changed = () => new ToolError('The permission prompt showing now is not the one you read (the user answered it, or the child moved on to another prompt). Nothing was answered. Read it again with get_session.');
    if (shown.id !== id) throw changed();
    const view = permissionView(shown, (r) => this.deps.humanOnly?.(child.id, r) ?? null);
    if (allow) {
      // 親が自分の操作を人に毎回許してもらうモードなら、子の操作も親には許させない（子を通じて、人の確認を省かせない）
      const mode = host.modeOf(caller.id) ?? 'manual';
      if (!MODES_ALLOWING_PERMISSION.has(mode)) {
        throw new ToolError(`This session is in ${mode} mode, so it cannot allow a child's permission prompts (it can only deny them). Ask the user to answer it: show them exactly what the child wants to run.`);
      }
      if (view.problem) throw new ToolError(`Cannot allow this prompt: ${view.problem} Ask the user to answer it in the child session (you can still deny it).`);
    }
    // 理由があれば、断った理由として Claude に伝え、子は作業を続ける。無ければ、断って作業を止める（次の指示は send_message で）
    const what = shown.tool ? ` to use ${shown.tool}` : '';
    const reply = allow
      ? ({ kind: 'allow' } as const)
      : reason
        ? ({ kind: 'deny', message: `The parent session denied your permission request${what}. Do not retry the same operation. Reason: ${reason}`, byParent: true } as const)
        : ({ kind: 'stop' } as const);
    if (!host.replyPermission(child.id, id, reply)) throw changed();
    this.observe(caller.id, child.id);
    const next = host.pendingPermission(child.id);
    return json({
      session_id: child.id,
      answered: true,
      decision: allow ? 'allow' : 'deny',
      state: host.stateOf(child.id),
      note: allow
        ? 'Allowed this once. Nothing was remembered: the same operation will ask again.'
        : reason
          ? 'Denied. The child was told the reason and continues its work.'
          : 'Denied. The child stops this operation and waits for an instruction: tell it what to do instead with send_message.',
      next_permission: next ? permissionView(next, (r) => this.deps.humanOnly?.(child.id, r) ?? null).view : undefined,
    });
  }

  private async configureSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const who = `"${nameOf(child)}"`;
    const model = stringArg(args.model);
    const effort = stringArg(args.effort);
    if (args.remote_control !== undefined && typeof args.remote_control !== 'boolean') throw new ToolError('Pass remote_control as true or false.');
    const remote = typeof args.remote_control === 'boolean' ? args.remote_control : null;
    if (args.permission_mode === undefined && !model && !effort && remote === null) throw new ToolError('Pass what to change: permission_mode, model, effort or remote_control.');
    // 確かめられるものは、何かを変える前に確かめる（一部だけ変わって終わらないように）
    let mode: PermissionMode | null = null;
    if (args.permission_mode !== undefined) {
      if (!SWITCHABLE_MODES.includes(args.permission_mode as PermissionMode)) {
        throw new ToolError(`Permission mode ${String(args.permission_mode)} cannot be set. Choose one of ${SWITCHABLE_MODES.join(', ')}.`);
      }
      mode = args.permission_mode as PermissionMode;
      // 権限モードは、このセッションより強くできない（start_session と同じ。親を通じて、人が許していない操作を通さないため）
      const limit = host.modeOf(caller.id) ?? 'manual';
      if (!modeWithin(mode, limit)) throw new ToolError(`Permission mode ${mode} cannot be used because it is more permissive than this session's (${limit}).`);
    }
    if (effort && !EFFORTS.includes(effort)) throw new ToolError(`Unknown effort: ${effort}. Choose one of ${EFFORTS.join(', ')}.`);
    if (remote !== null && !host.remoteAvailable()) throw new ToolError('Remote Control is not available in this build of tanacode (a development build), so nothing was changed.');
    // Remote Control をオンにできるのは、このセッションがオンのときだけ（人が外から使っていないのに、外から操作できる子を作らせない）。オフにはいつでもできる
    if (remote && !caller.remoteControl) {
      throw new ToolError("Remote Control can be turned on for a child only while this session's Remote Control is on, so nothing was changed. The user can turn it on in the header of the child's chat in tanacode.");
    }
    const switching = !!model || !!effort;
    const state = host.stateOf(child.id) ?? 'exited';
    if (state === 'archived') throw new ToolError(`${who} is archived. To change it, ask the user to restore it with "${t('sessions.sidebar.unarchive')}" in the session list.`);
    const allowed = switching ? MODEL_SWITCHABLE_STATES : remote !== null ? REMOTE_SWITCHABLE_STATES : MODE_SWITCHABLE_STATES;
    if (!allowed.has(state)) {
      throw new ToolError(`${who} ${CONFIGURE_REFUSAL[state] ?? `cannot be changed while it is ${SESSION_STATE_LABEL[state]}.`}`);
    }
    const running = state !== 'exited';
    if (mode && !(await host.setMode(child.id, mode))) {
      const now = host.modeOf(child.id);
      throw new ToolError(
        `Could not switch ${who} to ${mode}${now ? ` (its permission mode is now ${now})` : ''}: its Claude Code refused it (bypassPermissions works only when it was started in that mode). Check it with get_session.`,
      );
    }
    // 途中で失敗したときに伝える、それまでに変えたもの
    const done: string[] = [];
    const failed = (what: string, reason: string) => {
      const before = done.join(' and ');
      return new ToolError(`${before ? `${before.charAt(0).toUpperCase()}${before.slice(1)}, but could` : 'Could'} not ${what}: ${reason}`);
    };
    if (mode) done.push(`switched the permission mode of ${who} to ${mode}`);
    if (remote !== null) {
      // ヘッダーのトグルと同じ。つながるのは待たない（get_session の remote_control.connected で確かめさせる）
      const reason = await host.setRemoteControl(child.id, remote);
      const what = `turn the Remote Control of ${who} ${remote ? 'on' : 'off'}`;
      if (reason !== null) throw failed(`${what}${switching ? ' (its model and effort were not changed)' : ''}`, remoteRefusal(reason));
      done.push(`turned the Remote Control of ${who} ${remote ? 'on' : 'off'}`);
    }
    if (switching) {
      // 変えないものは、今の指定のまま（画面のモデル欄・エフォート欄で変えたときと同じ）。設定ファイルは変えない
      const options: SessionOptions = { model: model || (child.model ?? null), effort: effort || (child.effort ?? null), settingsFile: child.settingsFile ?? null };
      try {
        await host.configure(child.id, options);
      } catch (error) {
        throw failed('change its model or effort', modelRefusal(error instanceof Error ? error.message : String(error)));
      }
    }
    const changed = { ...(mode ? { permission_mode: mode } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(remote !== null ? { remote_control: remote } : {}) };
    const notes = !running
      ? ['Its Claude Code is not running, so the new settings are used when it starts next (send_message starts it).']
      : [
          switching ? 'Switched its model and effort; its next response uses them (its background tasks keep running).' : null,
          mode ? 'Switched the permission mode; it keeps this mode when it is restarted.' : null,
          remote === true ? 'Turned Remote Control on: check remote_control.connected with get_session.' : remote === false ? 'Turned Remote Control off.' : null,
        ];
    return json({ session_id: child.id, changed, state: host.stateOf(child.id), note: notes.filter(Boolean).join(' ') });
  }

  private async stopSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const state = host.stateOf(child.id);
    if (state === 'question' || state === 'permission' || state === 'terminal') {
      throw new ToolError(`"${nameOf(child)}" cannot be interrupted while it is ${SESSION_STATE_LABEL[state]}.`);
    }
    // アプリ内ブラウザでの人の操作待ちは、ターンの途中（ask_user_to_act の呼び出しの途中）なら、作業中と同じに止める。
    // 裏のタスクが頼んでいるだけなら、ターンは終わっている
    const raw = this.raw.stateOf(child.id);
    if (raw !== 'working') {
      const note =
        raw === 'background'
          ? 'Its turn has finished, and it is waiting for background tasks to finish.'
          : raw === 'starting'
            ? `It is still starting up, so there is nothing to interrupt. If it stays starting for ${minutesText(this.stuckStartingMs())} or more (its start is stuck), end it with end_session.`
            : 'It is not working.';
      return json({ session_id: child.id, state, note });
    }
    // 止めて手が空いたことは、親に知らせない（親が止めたので）。止めるターンが開いていなかったら（最適化圧縮の流れのすき間・
    // ターンの終わりの間際・送った指示がまだ始まっていない）、何も止めていないので印を付けない（付けると、あとの作業の知らせを捨てる）
    if (!host.interrupt(child.id)) {
      return json({
        session_id: child.id,
        state: host.stateOf(child.id),
        note: 'It was between turns (for example, finishing a turn, being switched to a new conversation by optimized compaction, or about to start a message), so nothing was interrupted. Check it with get_session, and call stop_session again if it is still working.',
      });
    }
    this.stopped.add(child.id);
    return json({ session_id: child.id, state: host.stateOf(child.id), note: 'Interrupted.' });
  }

  // 役目を終えた子を片付ける。アーカイブして、worktree の子なら worktree も消す（remove_worktree: false なら残す）。
  // 人の確認は出さない: アーカイブは一覧から戻せ、worktree を消しても、未コミットの変更は控えの ref に、手元にしか無いコミットはブランチに残る。
  // 手が空いている・終了している・裏のタスクの完了待ちの子だけ（裏のタスクは Claude Code と一緒に止まる）。
  // アーカイブ済みの子に呼んだら、残っている worktree を消す（何度呼んでも同じ結果になる）
  private async endSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    if (args.remove_worktree !== undefined && typeof args.remove_worktree !== 'boolean') throw new ToolError('Pass remove_worktree as true or false.');
    const who = `"${nameOf(child)}"`;
    const check = () => {
      const state = host.stateOf(child.id) ?? 'exited';
      if (state === 'starting') {
        // 長く起動中のままの子は、起動が止まったものとして終えられる（アーカイブで Claude Code も止まる）。
        // worktree の依存の install の間は、最初の指示を待つ上限まで待つ（時間のかかるふつうの install を止めない）
        const installing = this.summary(child.id)?.worktree?.preparing === 'installing';
        const limit = installing ? FIRST_PROMPT_TIMEOUT_MS : this.stuckStartingMs();
        const waited = this.now() - (this.startingSince.get(child.id) ?? this.now());
        if (waited >= limit) return state;
        const doing = installing ? 'is still installing the dependencies of its worktree' : 'is still starting up';
        throw new ToolError(
          `${who} ${doing} (starting for ${secondsText(waited)} so far), so it was not ended. Wait until it is idle (check with get_session), then call end_session again. If it is still starting ${secondsText(limit - waited)} from now (its start is stuck), end_session ends it.`,
        );
      }
      if (!ENDABLE_STATES.has(state)) throw new ToolError(`${who} ${END_REFUSAL[state] ?? `cannot be ended while it is ${SESSION_STATE_LABEL[state]}.`}`);
      return state;
    };
    const before = check();
    const removeWorktree = args.remove_worktree !== false && !!child.worktree;
    // PR の状態は GitHub に問い合わせるので、少しかかる。調べられなくても、片付けは続ける
    const leftovers = removeWorktree ? await host.worktreeLeftovers(child.id).catch(() => null) : null;
    // 調べている間に、子が動き出していないか（人が子に直接指示したなど）
    const state = check();
    const tasks = state === 'background' ? runningTasks(host, child.id) : [];
    let removal: WorktreeRemoval | null = null;
    let failure: string | null = null;
    // アーカイブで、預かっていた指示（起動中の子への最初の指示など）は送れなくなる。終えた親には、そのことを知らせない
    this.ended.add(child.id);
    try {
      // 起動中の子は、worktree を残すときも、tanacode が準備のために動かしているもの（依存の install など）を止める
      removal = await this.deps.archive(child.id, { removeWorktree, ...(before === 'starting' || state === 'starting' ? { stopSetup: true } : {}) });
    } catch (error) {
      failure = errorText(error);
    }
    // worktree を消せなかったときも、アーカイブは済んでいる。アーカイブもできていなければ、そのまま失敗として返す
    if (host.stateOf(child.id) !== 'archived') {
      this.ended.delete(child.id);
      throw new ToolError(`Could not archive ${who}: ${failure ?? 'unknown error'}`);
    }
    // 子の状態の知らせも、預かった指示・最初の指示を送れなかった知らせも取り下げる（終えたあとに届かないように）
    this.notices.removeWhere(caller.id, (key, event) => key === child.id || event.child === child.id);
    this.stopped.delete(child.id);
    this.backgroundTold.delete(`${caller.id}:${child.id}`);
    const alreadyArchived = before === 'archived';
    const notes = [alreadyArchived ? 'It was already archived.' : `Archived. The user can restore it with "${t('sessions.sidebar.unarchive')}" in the session list.`];
    if (before === 'starting') {
      notes.push(
        'It had been starting up for a long time (its start seemed stuck). Its Claude Code and anything tanacode was running to set it up (such as installing dependencies) were stopped, and the instructions still waiting to be sent to it were not sent.',
      );
    }
    if (tasks.length > 0) {
      notes.push(
        `Stopped its ${tasks.length} background ${tasks.length === 1 ? 'task' : 'tasks'} together with Claude Code. Processes it detached from Claude Code (for example with nohup or open) are not tracked and may still be running.`,
      );
    }
    let worktree: Record<string, unknown> | null = null;
    if (child.worktree) {
      const folder = !removeWorktree ? 'kept' : failure !== null ? 'not_removed' : leftovers && !leftovers.exists ? 'already_removed' : 'removed';
      worktree = {
        name: child.worktree.name,
        branch: child.worktree.branch,
        folder,
        ...(removal ? { backup_ref: removal.backupRef } : {}),
        ...(failure !== null ? { error: failure } : {}),
        branches: branchesOf(leftovers, removal),
      };
      if (!removeWorktree) notes.push('Kept its worktree (remove_worktree was false). Call end_session again without it to remove the worktree.');
      else if (failure !== null) notes.push('Could not remove its worktree (see worktree.error), so the folder and the branches are still there. Tell the user, or call end_session again once the cause is gone.');
      else if (folder === 'already_removed') notes.push('Its worktree folder was already gone.');
      else notes.push('Removed its worktree. If the user restores the session, the worktree is recreated (on the branch it was using, if that branch was kept, with its uncommitted changes put back).');
      if (removal?.backupRef) notes.push(`It had uncommitted changes or untracked files (or commits on no branch). They are saved as a commit at ${removal.backupRef} (gitignored files are not included).`);
      const deleted = removal?.branches.filter((b) => b.deleted).map((b) => b.name) ?? [];
      if (deleted.length > 0) notes.push(`Deleted the ${deleted.length === 1 ? 'branch' : 'branches'} ${deleted.join(', ')}.`);
      for (const b of removal?.branches ?? []) if (!b.deleted) notes.push(`Kept the branch ${b.name} because ${KEEP_REASON[b.keep ?? 'failed']}.`);
    } else if (args.remove_worktree === true) {
      notes.push('It has no worktree, so no folder was removed.');
    }
    return json({
      session_id: child.id,
      name: nameOf(child),
      archived: true,
      already_archived: alreadyArchived,
      ...(tasks.length > 0 ? { stopped_background_tasks: tasks } : {}),
      worktree,
      note: notes.join(' '),
    });
  }

  // --- 自分への予約と、人への報告 ---

  // 自分のセッションに予約を入れる。時刻になると、手が空いてから、囲み（<tanacode-wakeup>）に入れて送る（scheduled-messages.ts）。
  // 人の予約と同じ一覧に入るので、人は一覧の時計とチャットの末尾で見て、今すぐ送る・時刻を変える・取り消すができる
  private scheduleWakeup(caller: SessionSummary, args: Record<string, unknown>): ToolResult {
    const scheduled = this.wakeups();
    const message = stringArg(args.message);
    if (!message) throw new ToolError('message (what to do when it arrives) is empty.');
    const now = Date.now();
    const at = wakeupTime(args, now);
    const waiting = scheduled.claudeWakeups(caller.id);
    // Claude の予約がもう待っていれば、入れずに見せて、Claude に決めさせる（Issue #277。親が子の見回りの予約を、前のものを忘れて
    // 重ねて入れ、古い文面のほうが先に届いていた）。重ねると決めたら、even_if_scheduled を付けてもう一度呼ぶ
    if (waiting.length > 0 && args.even_if_scheduled !== true) return this.wakeupsWaiting(caller, waiting);
    if (waiting.length >= MAX_WAKEUPS) {
      throw new ToolError(
        `${MAX_WAKEUPS} of your wake-ups are already waiting in this session (${waiting.map((m) => `${m.id.slice(0, 8)} at ${localIso(m.at)}`).join(', ')}). Cancel one you no longer need with cancel_wakeup, or wait until one has been sent.`,
      );
    }
    const added = scheduled.add(caller.id, message, [], at, [], 'claude');
    return json({
      id: added.id,
      at: new Date(added.at).toISOString(),
      local_time: localIso(added.at),
      note: ['Scheduled. End your turn now: at that time, it is sent back to you as soon as this session is idle.', this.wakeupsUnsavedNote(caller)].filter(Boolean).join(' '),
    });
  }

  // 予約を入れずに、待っている Claude の予約を返す。人の予約は数えない（Claude は消せない）が、あることは添える。
  // 断ったのではなく判断を求めているので、エラーにはしない（チャットに失敗として出さない）
  private wakeupsWaiting(caller: SessionSummary, waiting: ScheduledMessage[]): ToolResult {
    const sorted = [...waiting].sort((a, b) => a.at - b.at);
    const users = this.wakeups()
      .list()
      .filter((m) => m.sessionId === caller.id && !m.by && (m.state === 'scheduled' || m.state === 'sending')).length;
    return json({
      scheduled: false,
      waiting: sorted.map((m) => ({ id: m.id, state: m.state, at: new Date(m.at).toISOString(), local_time: localIso(m.at), text: clip(m.text, MAX_WAKEUP_TEXT_CHARS) })),
      note: [
        `Not scheduled: ${waiting.length === 1 ? 'one of your wake-ups is' : `${waiting.length} of your wake-ups are`} already waiting in this session (waiting). A second one is usually a mistake: the earlier one may arrive first with an outdated message. Decide now: if a waiting one already covers what you need, keep it and do not schedule this one; if its message or time is outdated (it was written before what you know now), cancel it with cancel_wakeup and then schedule this one; only if you really need both, call schedule_wakeup again with the same arguments and even_if_scheduled: true.`,
        waiting.length >= MAX_WAKEUPS ? `You already have the maximum of ${MAX_WAKEUPS}, so cancel one before you add another.` : '',
        users > 0 ? `The user also scheduled ${users === 1 ? '1 message' : `${users} messages`} in this session (not counted here: they are the user's, and only the user can change them; see list_wakeups).` : '',
        this.wakeupsUnsavedNote(caller),
      ]
        .filter(Boolean)
        .join(' '),
    });
  }

  // このセッションの予約（Claude のものも、人のものも）
  private listWakeups(caller: SessionSummary): ToolResult {
    const messages = this.wakeups()
      .list()
      .filter((m) => m.sessionId === caller.id)
      .sort((a, b) => a.at - b.at);
    const unsaved = this.wakeupsUnsavedNote(caller);
    return json({
      now: localIso(Date.now()),
      messages: messages.map((m) => ({
        id: m.id,
        by: m.by === 'claude' ? 'claude' : m.by === 'usage-limit' ? 'tanacode' : 'user',
        state: m.state,
        at: new Date(m.at).toISOString(),
        local_time: localIso(m.at),
        text: m.by === 'usage-limit' ? 'tanacode resumes this session after the usage limit resets (the message asks you to check where you stopped and continue).' : clip(m.text, MAX_WAKEUP_TEXT_CHARS),
        ...(m.attachments.length > 0 ? { images: m.attachments.length } : {}),
        ...(m.pastes.length > 0 ? { pasted_texts: m.pastes.length } : {}),
        // 送れなかった理由。error は画面の言語の文なので、Claude には reason から英語の文を作って返す（理由の分からないものは、文を返さない）
        ...(m.error ? { error: m.reason ? `Not sent to this session because ${SEND_FAILURE[m.reason]}.` : 'Not sent to this session.' } : {}),
      })),
      ...(messages.length === 0 || unsaved ? { note: [messages.length === 0 ? 'No messages are scheduled in this session.' : '', unsaved].filter(Boolean).join(' ') } : {}),
    });
  }

  // 予約を保存しないことの一言（セッションごとに最初の 1 回だけ。保存できていれば空）
  private wakeupsUnsavedNote(caller: SessionSummary): string {
    if (this.wakeups().saving || this.wakeupsUnsavedNoted.has(caller.id)) return '';
    this.wakeupsUnsavedNoted.add(caller.id);
    return WAKEUPS_UNSAVED;
  }

  // Claude が入れた予約だけを取り消す。人の予約は、人が画面で扱う
  private cancelWakeup(caller: SessionSummary, args: Record<string, unknown>): ToolResult {
    const scheduled = this.wakeups();
    const id = stringArg(args.id).toLowerCase();
    if (id.length < 8) throw new ToolError('Pass the ID of the wake-up (at least its first 8 characters) as id.');
    const matches = scheduled.list().filter((m) => m.sessionId === caller.id && m.id.startsWith(id));
    if (matches.length === 0) throw new ToolError(`No scheduled message of this session has the ID ${id}. It may have been sent or cancelled already (check with list_wakeups).`);
    if (matches.length > 1) throw new ToolError(`More than one scheduled message has an ID starting with ${id}. Pass a longer ID.`);
    const target = matches[0];
    if (target.by === 'usage-limit') throw new ToolError('tanacode scheduled this message to resume this session after the usage limit resets. Only the user can cancel or change it.');
    if (target.by !== 'claude') throw new ToolError('This message was scheduled by the user. Only the user can cancel or change it.');
    scheduled.cancel(target.id);
    return json({ id: target.id, cancelled: true });
  }

  // ターンの終わりの通知に載せる報告を預ける。通知を出すか・いつ捨てるかは、預かる側（turn-reports.ts と profile.ts）が決める
  private reportResult(caller: SessionSummary, args: Record<string, unknown>): ToolResult {
    if (caller.parentId) throw new ToolError('A child session does not notify the user, so it has no report to save. Put the result in your reply: your parent session reads it.');
    // 通知の本文にするので、1 行にする（キー操作になる文字も除く）
    const text = stripControlChars(stringArg(args.message).replace(/\s*\n\s*/g, ' ')).trim();
    if (!text) throw new ToolError('message (the report) is empty.');
    if (text.length > MAX_REPORT_CHARS) throw new ToolError(`message is too long (${text.length} characters). Keep it within ${MAX_REPORT_CHARS} characters: one or two sentences.`);
    if (!this.deps.report) throw new ToolError(NOT_READY);
    this.deps.report(caller.id, text);
    return textResult('Saved. It is shown in the notification when this turn ends (not while the user is looking at this session, and not if notifications are off).');
  }

  // 子への予約（利用枠の再開・子の Claude の予約・人の予約）を、時刻に送れなかった・送れなかった。子は人に通知しないので、親に知らせる
  // （利用枠の再開を待つ親には、それまで見に来なくてよいと伝えてある）。親に回したら true（人には通知しない）
  scheduledTrouble(message: ScheduledMessage): boolean {
    const parentId = this.deps.host.parentOf(message.sessionId);
    if (!parentId || !this.deps.enabled() || (message.state !== 'missed' && message.state !== 'failed')) return false;
    // 子が動き出しても取り下げないよう、子の作業の知らせとは別のキーにする
    this.notices.add(parentId, `scheduled:${message.id}`, { child: message.sessionId, state: 'idle', at: Date.now(), scheduled: message });
    return true;
  }

  // 利用枠の再開の予約の時刻（時刻を待っている・送っている途中のもの。無ければ null）
  private usageResumeAt(id: string): number | null {
    const message = this.deps.scheduled?.()?.list().find((m) => m.sessionId === id && m.by === 'usage-limit' && (m.state === 'scheduled' || m.state === 'sending'));
    return message?.at ?? null;
  }

  private wakeups(): WakeupHost {
    const scheduled = this.deps.scheduled?.();
    if (!scheduled) throw new ToolError(NOT_READY);
    return scheduled;
  }

  // --- 親への知らせ ---

  // 子が作業中から手の空いた状態になったら、親に知らせる（親が待っていなくても）。
  // 親が子に出した指示の作業だけ（人が子に直接出した指示の作業では、親を起こさない）。親の手が空いたら送るのは SessionNotices
  private stateChanged(id: string): void {
    const state = this.deps.host.stateOf(id);
    // 引き継いだ子は、止まっている → 起動中 → 待機と変わるので、作業中から手が空いたように見えない。起動し終えたら、前のアプリが
    // 終えたときに見ていた状態と比べる（作業中の子を残してアプリを終え、閉じている間に子が作業を終えていたら知らせる）。
    // 引き継ぎの途中（claude をつなぐ前の「止まっている」・起動中）では使わない
    const detached = state && state !== 'starting' && state !== 'exited' ? (this.deps.host.takeDetachedState?.(id) ?? null) : null;
    const before = detached ?? this.lastState.get(id);
    this.trackState(id, state);
    // 終えた子を人がアーカイブから戻した・一覧から消したら、終えた印を外す（戻した子への指示を送れなかったことは、また知らせる）
    if (state === null || (before === 'archived' && state !== 'archived')) this.ended.delete(id);
    const parentId = this.deps.host.parentOf(id);
    // 子がまた動き出したら、まだ送っていない知らせは取り下げる。最適化圧縮の流れ（仕上げ・再開のターン）で作業中に見えているだけなら、
    // 取り下げない（ターンの終わりの自動の切り替えは、子が作業を終えた直後に始まる。親が忙しくて、まだ送れていない知らせが消える）
    // 流れは、再開の文のターンが始まったところで終わる。そのターン（「引き継ぎました」の報告）が終わるまでも、同じ扱いにする
    if (this.deps.compacting?.(id)) this.compacted.add(id);
    const busy = !!state && isBusy(state);
    if (parentId && busy && !this.compacted.has(id)) this.notices.remove(parentId, id);
    if (!busy) this.compacted.delete(id);
    // 作業していた子のターンが終わったとき（起動中から手が空いたのは、作業を終えたのではない。アプリを起動し直して引き継いだときなど）。
    // 裏のタスクの完了待ちの子が、人の対応待ちになったとき（裏のサブエージェントが、ブラウザでの操作・許可・質問を頼んだ）も知らせる
    const asked = before === 'background' && (state === 'browser' || state === 'permission' || state === 'question');
    if (parentId && (before === 'working' || asked) && state && NOTIFY_STATES.has(state)) void this.queueNotice(id, parentId, state);
    // ターンが終わったのに知らせを作らなかったとき（ブラウザでの操作待ちから手が空いた・ターミナルモードを通ったなど）は、止めた印を片付ける
    else if (!state || TURN_ENDED_STATES.has(state)) this.stopped.delete(id);
  }

  private async queueNotice(childId: string, parentId: string, state: SessionState): Promise<void> {
    const at = Date.now();
    // 今のターンを始めた発言が、まだ会話に入っていないか（許可の確認・質問・ブラウザでの操作の頼みは、会話ログの発言の行より先に届くことがある）
    const unseen = this.deps.host.unseenTurnPrompt(childId);
    const events = await this.deps.host.conversation(childId);
    // 親が止めたターンの終わりは知らせない。止めた印は、ターンが終わった知らせで片付ける（印のあとに親が出した指示の作業や、
    // 止まらずに続いた作業の終わりは知らせる。最後のターンの終わりが中断かで見分ける）
    if (TURN_ENDED_STATES.has(state) && this.stopped.delete(childId) && lastOf(events, (e): e is Extract<ChatEvent, { type: 'turn-end' }> => e.type === 'turn-end')?.interrupted) return;
    // /clear のあとの会話だけを見る（最後の指示が親のものでも、/clear で会話を始め直していれば、親の作業ではない）。
    // 最適化圧縮の切り替え（アプリが打った /clear）は、区切りにしない（会話を消しても、だれの作業かは変わらない。手動も自動も同じ）
    const reset = lastOf(events, (e): e is Extract<ChatEvent, { type: 'reset' }> => e.type === 'reset' && !e.compact);
    const after = reset ? events.slice(events.lastIndexOf(reset) + 1) : events;
    // アプリが打った /clear（新しい会話に、コマンドの発言として残る）は、人の発言に数えない
    const user = lastOf(withoutCompaction(after), isUser);
    // アプリを起動し直したあとは、切り替える前の会話が手元に無い。再開の文に入っている発言の原文で見分ける
    const fromParent = unseen ? unseen.parent === parentId : user ? user.parent === parentId : (carriedMessages(after).at(-1)?.fromParent ?? false);
    if (!fromParent) return;
    // 利用枠に当たって止まったのは、作業の終わりではない。いつ再開するかと一緒に知らせる。
    // 最適化圧縮のターン（仕上げ・再開）で止まったときも知らせる（枠が戻ったら再開のメッセージが届き、子はそこから動き出す）
    const limit = usageLimitStopOf(after);
    // 切り替えのあとの「引き継ぎました」の報告で終わったターン（答えを待っている・続ける作業が無い）と、取りやめた仕上げのターンは、
    // 作業の終わりではない（作業の終わりは、切り替える前に知らせてある）。再開のあとに作業を続けたターンの終わりは、作業の終わり。
    // 途中で止めたのに取りやめになった仕上げのターンの終わりも知らせる（続きを頼めなかったとき。子は止まったまま。
    // 頼めたときは、続きのターンが始まってから流れが終わるので、ここには来ない）
    let lastAt = after.length - 1;
    while (lastAt >= 0 && !startsTurn(after[lastAt])) lastAt--;
    const last = after[lastAt];
    if (!limit && last?.type === 'notice' && last.compact && !(last.compact === 'resume' ? continuedAt(after, lastAt) : compactTriggerOf(last)?.midTurn)) return;
    // 裏のタスクが動いたままターンを終えたことは、知らせてあれば知らせ直さない。人の発言でないもの（裏のタスクの知らせ・予約など）で
    // 始まったターンが、また完了待ちで終わったとき（Monitor は、途中の知らせのたびにターンを始める）。
    // 終わりは、裏のタスクが無くなって手が空いたターンの終わりに知らせる。送った発言で始まったターンは、その発言がまだ会話に
    // 入っていなくても（unseen）、発言のターン
    const key = `${parentId}:${childId}`;
    if (!limit && state === 'background' && !unseen && last?.type !== 'user' && !(last?.type === 'notice' && last.compact) && this.backgroundTold.has(key)) return;
    if (state !== 'background') this.backgroundTold.delete(key);
    this.notices.add(parentId, childId, { state, at, ...(limit ? { limit } : {}) });
  }

  // 続けて手が空いた子の知らせを、1 つにまとめた文。親がもう読んだ出来事は除く
  private noticeFor(parentId: string, queue: Map<string, ChildNotice>): string | null {
    const all = this.deps.host.list();
    // 子の状態の知らせは、親がもう読んだものを除く（予約・最初の指示を送れなかった知らせは、子の状態からは分からないので除かない）
    const childOf = ([key, event]: [string, ChildNotice]) => event.child ?? key;
    const notices = [...queue].filter((item) => item[1].scheduled || item[1].firstPrompt !== undefined || item[1].sendFailed || (this.observedAt.get(`${parentId}:${childOf(item)}`) ?? 0) < item[1].at);
    if (notices.length === 0) return null;
    for (const [key, event] of notices) if (event.state === 'background' && !event.limit && !event.child) this.backgroundTold.add(`${parentId}:${key}`);
    const message = [
      ...notices.map((item) => {
        const [, event] = item;
        const child = childOf(item);
        const summary = all.find((s) => s.id === child);
        if (event.scheduled) return scheduledTroubleText(summary, child, event.scheduled);
        // 前のバージョンが残した知らせには、指示の文が無い
        if (event.firstPrompt !== undefined && event.firstMessage === undefined) return t('tools.notice.childFirstPromptFailed', { ...nameParams(summary, child), reason: event.firstPrompt });
        if (event.firstPrompt !== undefined) {
          return t('tools.notice.childFirstPromptFailedWith', { ...nameParams(summary, child), message: messageHead(event.firstMessage ?? '', MAX_FAILED_MESSAGE_CHARS), reason: event.firstPrompt });
        }
        if (event.sendFailed) {
          return t('tools.notice.childMessageFailed', { ...nameParams(summary, child), message: messageHead(event.sendFailed.message, MAX_FAILED_MESSAGE_CHARS), reason: event.sendFailed.reason });
        }
        return event.limit && (event.state === 'idle' || event.state === 'background')
          ? limitNoticeText(summary, child, event.limit, this.usageResumeAt(child))
          : noticeText(summary, child, event.state, event.state === 'question' ? askingElicitation(this.deps.host, child) : null);
      }),
      t('tools.notice.checkSessions'),
    ].join(' ');
    return sessionEventText([...new Set(notices.map(childOf))], message);
  }

  // 前に見た状態と、起動中になった時刻を覚える
  private trackState(id: string, state: SessionState | null): void {
    this.lastState.set(id, state);
    if (state !== 'starting') this.startingSince.delete(id);
    else if (!this.startingSince.has(id)) this.startingSince.set(id, this.now());
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private stuckStartingMs(): number {
    return this.deps.stuckStartingMs ?? STUCK_STARTING_MS;
  }

  private observe(parentId: string, childId: string): void {
    // 最適化圧縮の流れの途中に読んだのは、「作業中」の状態。手が空いたことは、まだ読んでいない（そのあとの知らせを止めない）
    if (this.deps.compacting?.(childId)) return;
    this.observedAt.set(`${parentId}:${childId}`, Date.now());
  }

  // --- 補助 ---

  private summary(id: string): SessionSummary | undefined {
    return this.deps.host.list().find((s) => s.id === id);
  }

  private visible(caller: SessionSummary): SessionSummary[] {
    return this.deps.host.list().filter((s) => canSee(caller, s));
  }

  // session_id（全体か、先頭 8 文字以上）を、見えるセッションに解決する。child: 自分の子セッションに限る
  private resolve(caller: SessionSummary, raw: unknown, child = false): SessionSummary {
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (id.length < 8) throw new ToolError('Pass a session ID (at least its first 8 characters) as session_id.');
    const matches = this.visible(caller).filter((s) => s.id.startsWith(id));
    if (matches.length === 0) throw new ToolError(`No visible session has the ID ${id} (check with list_sessions).`);
    if (matches.length > 1) throw new ToolError(`More than one session has an ID starting with ${id}. Pass a longer ID.`);
    const target = matches[0];
    if (child && target.parentId !== caller.id) {
      throw new ToolError(`"${nameOf(target)}" is not a child session of this session. You can only instruct children you started with start_session.`);
    }
    return target;
  }

  // このプロファイルが覚えているフォルダ（新規セッションの画面の「最近のフォルダ」の元。アーカイブしたセッションのものも）。
  // 新しい順。worktree のセッションは元のフォルダ
  private knownFolders(): string[] {
    const sessions = [...this.deps.host.list()].sort((a, b) => b.updatedAt - a.updatedAt);
    return [...new Set(sessions.map((s) => projectRootOf(s)))];
  }

  // セッションを始めるフォルダ。省けば、このセッションのリポジトリのフォルダ。
  // 選べるのは、このセッションのリポジトリの中か、このプロファイルのセッションのフォルダだけ（人が開いたことのない場所で Claude Code を動かさせない）。
  // 別のリポジトリのフォルダも選べるが、そこの会話が読めるようにはならない（見える範囲は canSee のまま）。
  // シンボリックリンクは解いてから比べる（リポジトリの中のリンクから、外のフォルダで始めさせない）
  private async folderFor(caller: SessionSummary, raw: unknown, worktree: boolean): Promise<string> {
    const root = projectRootOf(caller);
    const given = stringArg(raw);
    if (given && !isAbsolute(given)) throw new ToolError('Pass folder as an absolute path.');
    const real = (path: string) => realpath(path).catch(() => null);
    let folder = await real(given ? normalize(given) : root);
    if (!folder) throw new ToolError(`Folder not found: ${given || root}`);
    const realRoot = (await real(root)) ?? root;
    const inside = folder === realRoot || (realRoot !== this.deps.home && realRoot !== '/' && folder.startsWith(`${realRoot}/`));
    const known = inside
      ? true
      : (await Promise.all(this.deps.host.list().flatMap((s) => [real(s.cwd), real(projectRootOf(s))]))).includes(folder);
    if (!known) {
      throw new ToolError(
        `Cannot start in ${given}. Only a folder inside this session's repository (${root}) or a folder of another tanacode session (start_folders of list_sessions) can be chosen.`,
      );
    }
    const isDirectory = await stat(folder).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDirectory) throw new ToolError(`Not a folder: ${folder}`);
    // worktree の中から worktree を作ると入れ子になるので、元のフォルダから作る
    if (worktree) folder = projectRootOf({ cwd: folder });
    return folder;
  }

  private describe(s: SessionSummary, caller: SessionSummary): Record<string, unknown> {
    const state = this.deps.host.stateOf(s.id) ?? 'exited';
    return {
      id: s.id,
      name: nameOf(s),
      relation: relationOf(s, caller),
      state,
      state_label: SESSION_STATE_LABEL[state],
      folder: s.cwd,
      // preparing: worktree の準備の段階（準備中のときだけ。そのあいだ状態は starting）
      worktree: s.worktree
        ? {
            name: s.worktree.name,
            branch: s.worktree.branch,
            ...(s.worktree.preparing ? { preparing: s.worktree.preparing } : {}),
            ...setupProblemsOf(this.deps.host.worktreeSetup(s.id)),
          }
        : null,
      // 親の ID は、呼び出し元から見える親のときだけ（見えない親の ID は出さない）
      parent_id: s.parentId && this.visibleParent(s.parentId, caller) ? s.parentId : null,
    };
  }

  private visibleParent(parentId: string, caller: SessionSummary): boolean {
    const parent = this.summary(parentId);
    return !!parent && canSee(caller, parent);
  }

  private headerLines(target: SessionSummary, caller: SessionSummary, all: SessionSummary[]): string[] {
    const state = this.deps.host.stateOf(target.id) ?? 'exited';
    // all は、呼び出し元から見えるセッション（見えない子の名前や ID は出さない）
    const parent = target.parentId ? all.find((s) => s.id === target.parentId) : undefined;
    const children = all.filter((s) => s.parentId === target.id);
    const label = (s: SessionSummary) => `"${nameOf(s)}" (${s.id.slice(0, 8)}, ${SESSION_STATE_LABEL[this.deps.host.stateOf(s.id) ?? 'exited']})`;
    return [
      `- ID: ${target.id}`,
      `- Relation: ${RELATION_LABEL[relationOf(target, caller)]}`,
      `- State: ${SESSION_STATE_LABEL[state]} (${state})`,
      `- Folder: ${target.cwd}`,
      ...(target.worktree ? [`- Worktree: ${target.worktree.name} (branch ${target.worktree.branch})`] : []),
      ...(parent ? [`- Parent: ${label(parent)}`] : []),
      ...(children.length > 0 ? [`- Children: ${children.map(label).join(', ')}`] : []),
    ];
  }

  // get_session・wait_sessions で返す 1 つのセッションの状態。detail: 最後の応答と質問も入れる。responseChars: 最後の応答の文字数の上限
  private async status(s: SessionSummary, caller: SessionSummary, detail: boolean, responseChars = RESPONSE_CHARS): Promise<Record<string, unknown>> {
    const base = this.describe(s, caller);
    if (!detail) return base;
    const all = await this.deps.host.conversation(s.id);
    // 最適化圧縮の仕上げの頼み・再開の文と、その返事（「リストを更新しました」「引き継ぎました」）は、指示と作業の応答に数えない
    const events = withoutCompaction(all, this.deps.compacting?.(s.id) ?? false);
    const prompt = lastOf(events, isPrompt);
    const promptAt = prompt ? events.lastIndexOf(prompt) : -1;
    // 作業の結果を返す。チェックリストを直した報告しか無ければ、それを返す
    const { work, notes } = responsesOf(events.slice(promptAt + 1));
    // アプリを起動し直したあとは、切り替える前の会話が手元に無い。再開の文に入っている、最後の発言と最後の応答で補う
    const resume = prompt ? undefined : lastOf(all, isResume);
    const carried = resume ? carriedMessages([resume]).at(-1) : undefined;
    const lastPrompt: Prompt | undefined = prompt ?? (carried ? { type: 'user', id: '', text: carried.text, ...(carried.fromParent && s.parentId ? { parent: s.parentId } : {}) } : undefined);
    const response = work[work.length - 1] ?? notes[notes.length - 1] ?? (resume ? (lastReplyIn(detailOf(resume)) ?? undefined) : undefined);
    // 今の権限モード・モデル・エフォート（configure_session で変える前に確かめるため）。動いていなければ、次に起動するときの指定
    // （null は Claude Code の既定。権限モードは Claude Code が知らせたものなので、動いていなければ null）
    const running = base.state !== 'exited' && base.state !== 'archived';
    // 動いている裏のタスク（無ければ出さない）
    const tasks = runningTasks(this.deps.host, s.id);
    // 最後のターンが利用枠に当たって止まった。last_response は、止まる前の途中の応答（結果ではない）
    const limit = usageLimitStopOf(all);
    const resumeAt = limit ? this.usageResumeAt(s.id) : null;
    return {
      ...base,
      permission_mode: running ? this.deps.host.modeOf(s.id) : null,
      model: running ? this.deps.host.currentModel(s.id) : (s.model ?? null),
      effort: running ? this.deps.host.currentEffort(s.id) : (s.effort ?? null),
      // Remote Control の指定と、実際につながっているか（configure_session で変えたあとに確かめるため）。使えない開発版では出さない
      remote_control: this.deps.host.remoteAvailable() ? { on: s.remoteControl, connected: this.deps.host.remoteConnectedOf(s.id) } : undefined,
      background_tasks: tasks.length > 0 ? tasks : undefined,
      last_prompt: lastPrompt
        ? { from: lastPrompt.type === 'notice' ? 'notice' : lastPrompt.parent ? (s.parentId ? 'parent' : 'session') : 'human', text: clip(lastPrompt.text, 1000) }
        : null,
      last_response: response ? clip(response, responseChars) : null,
      // 真ん中を切ったときだけ。全文の長さ（max_response_chars で上げて読み直すため）
      last_response_truncated: response && response.length > responseChars ? { total_chars: response.length, shown_chars: responseChars } : undefined,
      // まだ子に届いていない指示（送った順）。親が届いたかを確かめ、同じ指示を二重に送らないように
      queued_messages: queuedOf(this.deps.host.queuedMessages(s.id), caller.id),
      usage_limit: limit
        ? {
            resets_at: limit.resetsAt === null ? null : localIso(limit.resetsAt),
            resume_scheduled_at: resumeAt === null ? null : localIso(resumeAt),
            note: [
              'The last turn stopped because the usage limit of the plan was reached: last_response (if any) is from before the stop, not a result of the work.',
              resumeAt === null
                ? 'No message is scheduled to resume it. Tell the user, or send it a message to continue once the limit has reset.'
                : 'At resume_scheduled_at, tanacode sends it a message to continue (the user can move or cancel it). There is no need to check on it before then.',
            ].join(' '),
          }
        : undefined,
      question: base.state === 'question' ? questionView(this.deps.host.pendingQuestion(s.id)) : undefined,
      mcp_question: base.state === 'question' ? mcpQuestionView(askingElicitation(this.deps.host, s.id)) : undefined,
      permission: base.state === 'permission' ? permissionViewOf(this.deps.host.pendingPermission(s.id), (r) => this.deps.humanOnly?.(s.id, r) ?? null) : undefined,
    };
  }

  // cond が真になるか、timeoutMs が過ぎるか、取り消されるまで待つ。状態の変化を見て、取りこぼしに備えて 1 秒ごとにも確かめる
  private until(cond: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolveWait) => {
      const finish = () => {
        clearTimeout(timer);
        clearInterval(poll);
        unwatch();
        signal?.removeEventListener('abort', finish);
        resolveWait();
      };
      const check = () => cond() && finish();
      const timer = setTimeout(finish, timeoutMs);
      const poll = setInterval(check, 1000);
      const unwatch = this.deps.host.watchState(check);
      if (signal?.aborted) finish();
      else signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

const RELATION_LABEL = {
  self: 'this session',
  parent: 'the parent of this session',
  child: 'a child of this session',
  sibling: 'a sibling (a child of the same parent)',
  project: 'a session in the same repository',
} as const;

function relationOf(s: SessionSummary, caller: SessionSummary): keyof typeof RELATION_LABEL {
  if (s.id === caller.id) return 'self';
  if (s.id === caller.parentId) return 'parent';
  if (s.parentId === caller.id) return 'child';
  if (caller.parentId && s.parentId === caller.parentId) return 'sibling';
  return 'project';
}

// stateOf だけを差し替えた host（ほかは、そのまま元を呼ぶ）。アプリ内ブラウザで人に操作を頼んでいる（ask_user_to_act）セッションの
// 作業中・裏のタスクの完了待ちを、状態 browser として見せる。子は人に通知しない（index.ts の notify）ので、子の頼みは人に届かない。
// 親に知らせて人に伝えさせ、wait_sessions も返す。SessionManager.stateOf は変えない（一覧・知らせの受け取りなど、ほかの部品も使う）。
// 質問・許可の確認・ターミナルでの操作の待ちは、そちらを見せる（ブラウザの頼みより先に、人が画面で答えるもの）
function withBrowserState(host: SessionsHost): SessionsHost {
  return new Proxy(host, {
    get(target, prop) {
      if (prop === 'stateOf') {
        return (id: string): SessionState | null => {
          const state = target.stateOf(id);
          return (state === 'working' || state === 'background') && target.browserAsking(id) ? 'browser' : state;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// Remote Control を切り替えられなかった理由（setRemoteControl が返す、画面の言語の文）を、英語の文にする
function remoteRefusal(reason: string): string {
  // Claude Code が断った理由（英語）は、そのまま渡す
  const refused = placeholderIn('main.remote.failed', 'reason', reason);
  if (refused !== null) return `its Claude Code refused it: ${refused}`;
  return 'tanacode could not switch it. Check it with get_session.';
}

// モデル・エフォートを切り替えられなかった理由（configure が投げる、画面の言語の文）を、英語の文にする
function modelRefusal(reason: string): string {
  const effort = placeholderIn('main.model.effortUnsupported', 'effort', reason);
  if (effort !== null) return `its model does not support the effort ${effort}`;
  const model = placeholderIn('main.model.unknown', 'model', reason);
  if (model !== null) return `its Claude Code does not offer the model ${model}`;
  // Claude Code が断った理由（英語）は、そのまま渡す
  const refused = placeholderIn('main.model.failed', 'reason', reason);
  if (refused !== null) return `its Claude Code refused it: ${refused}`;
  return 'tanacode could not switch it. Check it with get_session.';
}

// 画面の言語の文 text が、key の文言の name の差し込みを埋めたものなら、差し込まれた値。違えば null
function placeholderIn(key: MessageKey, name: string, text: string): string | null {
  const [head, tail] = t(key, { [name]: '\u0000' }).split('\u0000');
  if (tail === undefined || text.length < head.length + tail.length || !text.startsWith(head) || !text.endsWith(tail)) return null;
  return text.slice(head.length, text.length - tail.length);
}

// 動いている裏のタスク（一覧の数え方と同じ: SessionManager の countBackground）
function runningTasks(host: SessionsHost, id: string): { kind: string; name: string }[] {
  return [
    ...host.bashTasks(id).filter((task) => task.state === 'running').map((task) => ({ kind: 'bash', name: clip(task.description || task.command, 200) })),
    ...host.subagents(id).filter((run) => run.background && run.state === 'running').map((run) => ({ kind: 'subagent', name: clip(run.description ?? '', 200) })),
    ...host.workflows(id).filter((run) => run.status === 'running').map((run) => ({ kind: 'workflow', name: clip(run.name, 200) })),
  ];
}

function pullRequestOf(pr: WorktreePr): Record<string, unknown> {
  if (pr.state === 'none' || pr.state === 'unknown') return { state: pr.state };
  return { state: pr.state, number: pr.number, base: pr.base, url: pr.url };
}

// end_session で、ブランチを残した理由（Claude に返す文）
const KEEP_REASON: Record<WorktreeBranchKeep | 'failed', string> = {
  localOnly: 'it has commits that exist only locally',
  trunk: 'it is the default branch or a main line branch such as main or develop (the child only switched to it)',
  checkedOut: 'it is checked out in another worktree',
  failed: 'git could not delete it',
};

// end_session の結果の、worktree のブランチ。消す前に調べたもの（プッシュしていないコミット・PR）と、消した結果を合わせる
function branchesOf(leftovers: WorktreeLeftovers | null, removal: WorktreeRemoval | null): Record<string, unknown>[] {
  const names = [...new Set([...(leftovers?.branches ?? []).map((b) => b.name), ...(removal?.branches ?? []).map((b) => b.name)])];
  return names.map((name) => {
    const before = leftovers?.branches.find((b) => b.name === name);
    const after = removal?.branches.find((b) => b.name === name);
    const role = after ?? before!;
    return {
      name,
      launched: role.launched,
      current: role.current,
      ...(before ? { unpushed_commits: before.unpushed, pull_request: pullRequestOf(before.pr) } : {}),
      ...(after ? { deleted: after.deleted, ...(after.deleted ? {} : { kept_because: KEEP_REASON[after.keep ?? 'failed'] }) } : {}),
      ...(!after && before && !before.exists ? { exists: false } : {}),
    };
  });
}

const KIND_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const;

// schedule_wakeup の時刻。in_minutes（今から何分後）か at（時差の付いた ISO 8601）の、どちらか 1 つ。1 分後から 24 時間後まで
function wakeupTime(args: Record<string, unknown>, now: number): number {
  const hasMinutes = args.in_minutes !== undefined;
  if (hasMinutes === (args.at !== undefined)) throw new ToolError('Pass either in_minutes (minutes from now) or at (an ISO 8601 time), not both.');
  if (hasMinutes) {
    const minutes = args.in_minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WAKEUP_MINUTES) {
      throw new ToolError(`in_minutes must be a whole number from 1 to ${MAX_WAKEUP_MINUTES}.`);
    }
    return now + minutes * 60_000;
  }
  const text = stringArg(args.at);
  const at = ISO_WITH_OFFSET.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(at)) throw new ToolError(`at must be an ISO 8601 time with a time zone offset, such as ${localIso(now + 30 * 60_000)}. It is now ${localIso(now)}.`);
  if (at < now + 60_000 || at > now + MAX_WAKEUP_MINUTES * 60_000) {
    throw new ToolError(`at must be from 1 minute to ${MAX_WAKEUP_MINUTES / 60} hours from now. It is now ${localIso(now)}.`);
  }
  return at;
}

// この Mac の時刻と時差で書いた ISO 8601（例: 2026-10-15T15:00:00+09:00）。Claude が人に時刻を伝えるときに使う
function localIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

// 名前の無いセッションは、画面の一覧と同じ名前（画面の言語）にする。Claude が利用者に伝える名前が、一覧の名前と合うように
function nameOf(s: SessionSummary | undefined): string {
  return s?.title ?? t('main.session.untitled');
}

// 親への知らせの文。チャットに知らせとして出るので、画面の言語で書く
// elicitation: 子が答えを待っている MCP サーバーの質問（人だけが答えられる）
function noticeText(child: SessionSummary | undefined, id: string, state: SessionState, elicitation: PendingElicitation | null = null): string {
  const params = { name: child?.title ?? t('tools.notice.untitledSession'), id: id.slice(0, 8) };
  if (state === 'question' && elicitation) return t('tools.notice.childElicitation', { ...params, server: elicitation.server });
  if (state === 'question') return t('tools.notice.childQuestion', params);
  // 子セッションは人に通知しないので、親から人に伝える
  if (state === 'permission') return t('tools.notice.childPermission', params);
  if (state === 'terminal') return t('tools.notice.childTerminal', params);
  if (state === 'browser') return t('tools.notice.childBrowser', params);
  if (state === 'exited') return t('tools.notice.childExited', params);
  // ターンは終わったが、裏のタスクがまだ動いている（作業が終わったとは言わない）
  if (state === 'background') return t('tools.notice.childBackground', params);
  return t('tools.notice.childDone', params);
}

function nameParams(child: SessionSummary | undefined, id: string): { name: string; id: string } {
  return { name: child?.title ?? t('tools.notice.untitledSession'), id: id.slice(0, 8) };
}

// 指示の冒頭（1 行）。親への知らせ・get_session の queued_messages で、どの指示かを見分けるため
function messageHead(message: string, max = 80): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// get_session で返す、まだ子に届いていない指示（無ければ出さない）。from: you（呼び出し元の親）/ session（ほかのセッション）/
// human（人の発言）/ tanacode（知らせ・予約）。state: held（アプリが預かっている）/ queued（Claude Code が順番待ちにしている）
function queuedOf(queued: { parent: string | null; text: string; held: boolean; shown: boolean }[], callerId: string): Record<string, unknown>[] | undefined {
  if (queued.length === 0) return undefined;
  return queued.map((m) => ({
    from: m.parent ? (m.parent === callerId ? 'you' : 'session') : m.shown ? 'human' : 'tanacode',
    state: m.held ? 'held' : 'queued',
    text: messageHead(m.text, 200),
  }));
}

// 待った時間の英語の文（秒、1 分以上は分）
function secondsText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : minutesText(ms);
}

function minutesText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

// 子への予約を送れなかった知らせ。だれの予約か（利用枠の再開・子の Claude・人）と、時刻と、わけ（時刻を過ぎていた・送れなかった理由）
function scheduledTroubleText(child: SessionSummary | undefined, id: string, message: ScheduledMessage): string {
  const what = t(message.by === 'usage-limit' ? 'tools.notice.scheduledUsageLimit' : message.by === 'claude' ? 'tools.notice.scheduledWakeup' : 'tools.notice.scheduledByUser');
  const why = message.state === 'missed' ? t('tools.notice.scheduledLate') : (message.error ?? t('main.notification.unknownReason'));
  return t('tools.notice.childScheduledTrouble', { ...nameParams(child, id), what, time: localIso(message.at), why });
}

// get_session の worktree に添える、準備でうまくいかなかったこと（英語。Claude に返すため）
function setupProblemsOf(trouble: WorktreeSetupTrouble | null): { setup_problems?: string[] } {
  if (!trouble) return {};
  const at = (dir: string) => (dir ? `in ${dir}` : 'in the top folder');
  return {
    setup_problems: [
      ...trouble.installsFailed.map((i) => `${i.command} ${at(i.dir)} exited with code ${i.exitCode}, so its dependencies may be missing (its output is in a tab of the Terminal panel)`),
      ...trouble.notCopied.map((dir) => `node_modules ${at(dir)} could not be copied and was not installed`),
      ...(trouble.error ? [`setting up node_modules failed: ${trouble.error}`] : []),
      ...(trouble.waiting
        ? [`${trouble.waiting.command} ${at(trouble.waiting.dir)} seems to be waiting for input, so the worktree is not ready yet (ask the user to answer it in its tab in the Terminal panel of that session)`]
        : []),
    ],
  };
}

// 子が利用枠に当たって止まった知らせ。再開の予約があればその時刻、無ければ枠が戻る時刻を伝える（時刻は、Claude が人に伝えるときの形）
function limitNoticeText(child: SessionSummary | undefined, id: string, limit: UsageLimitStop, resumeAt: number | null): string {
  const params = { name: child?.title ?? t('tools.notice.untitledSession'), id: id.slice(0, 8) };
  if (resumeAt !== null) return t('tools.notice.childUsageLimit', { ...params, time: localIso(resumeAt) });
  if (limit.resetsAt !== null) return t('tools.notice.childUsageLimitNoResume', { ...params, time: localIso(limit.resetsAt) });
  return t('tools.notice.childUsageLimitNoTime', params);
}

// 答えを待っている許可の確認を、親に渡す形にする。
// problem: 親に許させない理由（入力が長すぎて全文を渡せない・人だけが答えられる）。あっても、断ることはできる。
// 人だけが答えられるのは、プランの承認・Claude Code や人の設定が人に回したもの（PendingPermission.humanOnly）と、Deps の humanOnly
function permissionView(permission: PendingPermission, humanOnly: (request: { tool: string; input: Record<string, unknown> }) => string | null): { view: Record<string, unknown>; problem: string | null } {
  const full = JSON.stringify(permission.input, null, 2);
  const bytes = Buffer.byteLength(full, 'utf8');
  const tooLong = bytes > MAX_PERMISSION_INPUT_BYTES;
  const problem = tooLong ? `the tool input is too long to show in full (${bytes} bytes), so you cannot read all of it.` : (permission.humanOnly ?? humanOnly(permission));
  return {
    problem,
    // 確認の ID（answer_permission に渡すもの）は、入力のあとに置く。Claude Code は大きすぎる MCP の結果を頭から切る
    // （MAX_MCP_OUTPUT_TOKENS。人が下げることもある）ので、入力の途中で切られたら ID も残らず、全部を読まないまま答えられない
    view: {
      title: permission.title ?? permission.tool,
      description: permission.description ?? undefined,
      reason: permission.reason ?? undefined,
      tool: permission.tool,
      input: tooLong ? `${clipBytes(full, MAX_PERMISSION_INPUT_BYTES)}\n…(truncated)` : permission.input,
      from_subagent: permission.agent ?? undefined,
      id: permission.id,
      can_allow: problem === null,
      cannot_allow_reason: problem ?? undefined,
      can_deny: true,
    },
  };
}

// UTF-8 で max バイトまでの頭（文字の途中では切らない）
function clipBytes(text: string, max: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char, 'utf8');
    if (bytes > max) break;
    end += char.length;
  }
  return text.slice(0, end);
}

function permissionViewOf(permission: PendingPermission | null, humanOnly: (request: { tool: string; input: Record<string, unknown> }) => string | null): Record<string, unknown> | undefined {
  return permission ? permissionView(permission, humanOnly).view : undefined;
}

// Claude Code が答えを待っている MCP サーバーの質問（完了を待っている URL の形の質問は、もう答えたので除く）
function askingElicitation(host: Pick<SessionsHost, 'pendingElicitation'>, id: string): PendingElicitation | null {
  const pending = host.pendingElicitation(id);
  return pending && !pending.opened ? pending : null;
}

// get_session で返す、MCP サーバーの質問。親は答えられないので、人に伝えるための中身だけを渡す。
// URL の形のページは、ホストだけ（URL には、ログインの合言葉などが入っていることがある）
function mcpQuestionView(pending: PendingElicitation | null): Record<string, unknown> | undefined {
  if (!pending) return undefined;
  return {
    server: pending.server,
    message: clip(pending.message, 2000),
    mode: pending.mode,
    // 開けるページ（http・https）は読めるので、ホストが取れる
    page_host: pending.mode === 'url' && pending.openable && pending.url ? new URL(pending.url).host : undefined,
    fields: pending.mode === 'form' ? pending.fields.map((f) => ({ name: f.key, title: f.title, type: f.type, required: f.required })) : undefined,
    can_answer: false,
    cannot_answer_reason: "It is a question from an MCP server to the user: only the user can answer it, in the child session's card. Tell the user.",
  };
}

// 答えを待っている質問のうち、まだ答えていない最初の質問（親は 1 問ずつ答える）
function currentOf(pending: PendingQuestion): AskQuestion | null {
  return pending.questions.find((q) => !(q.question in pending.answered)) ?? null;
}

// get_session・answer_question で返す、答えを待っている質問
function pendingQuestionOf(pending: PendingQuestion): Record<string, unknown> | null {
  const current = currentOf(pending);
  if (!current) return null;
  return {
    title: current.question,
    multi_select: current.multiSelect,
    tabs: pending.questions.length > 1 ? pending.questions.map((q) => ({ label: q.header, answered: q.question in pending.answered })) : undefined,
    options: current.options.map((o) => ({ label: o.label, description: o.description || undefined })),
    accepts_other: true,
  };
}

// 今の質問（答えを待っているもの）
function questionView(pending: PendingQuestion | null): Record<string, unknown> | undefined {
  return pending ? (pendingQuestionOf(pending) ?? undefined) : undefined;
}

// answer_question の結果。next: 続けて出た（または同じ質問の続きの）次の質問
function answeredResult(state: SessionState | null, next: Record<string, unknown> | null): ToolResult {
  return json({
    answered: true,
    state,
    next_question: next ?? undefined,
    note: next ? 'The child is showing another question (next_question). Answer it now with answer_question, and keep going until the result has no next_question.' : undefined,
  });
}

// 会話を、新しいほうから turns 回分の指示とその応答にまとめる（長い応答は途中を省く）。
// parentId: そのセッションの親。親のないセッションへの指示（独立したセッションの最初の指示）は、親からの指示と書かない
function conversationLines(events: ChatEvent[], turns: number, titleOf: (id: string) => string, parentId: string | null = null, responseChars = RESPONSE_CHARS): string[] {
  // notes: チェックリストの知らせにターンの終わりを止められたあとの応答（チェックリストを直した報告）
  type Turn = { who: string; text: string; responses: string[]; notes: string[]; tools: string[] };
  let all: Turn[] = [];
  let current: Turn | null = null;
  let stopped = false;
  // 最適化圧縮の仕上げのターン（頼みと、「リストを更新しました」の返事）。そのあと切り替えたら、出さない。
  // 取りやめになったときは出す（Claude が頼みに従わず、そのターンで元の作業を続けることがある）
  let handoff: Turn | null = null;
  // アプリが /clear を打って、まだ再開の文を送っていない
  let cleared = false;
  for (const [i, e] of events.entries()) {
    if (startsTurn(e)) stopped = false;
    if (e.type === 'reset') {
      // 最適化圧縮の切り替えでは、前のターンも残す（下の知らせの 1 行を挟む）。仕上げのターンと、アプリが打った /clear は出さない
      if (e.compact) {
        const dropped = handoff;
        all = all.filter((turn) => turn !== dropped);
        handoff = null;
        current = null;
        cleared = true;
        continue;
      }
      // /clear で会話を始め直した
      all = [];
      current = null;
    } else if (cleared && e.type === 'user' && e.command) {
      current = null;
    } else if (e.type === 'notice' && e.compact === 'handoff') {
      const auto = compactTriggerOf(e)?.percent ?? null;
      current = {
        who: 'Notice',
        text: `tanacode asked this session to bring its checklists up to date for an optimized compaction${auto === null ? '' : ` (automatic at ${auto}% of the context)`}. The conversation was not reset after this: the compaction was cancelled, or is still in progress.`,
        responses: [],
        notes: [],
        tools: [],
      };
      handoff = current;
      all.push(current);
    } else if (e.type === 'notice' && e.compact === 'resume') {
      // 再開の文は長いので、切り替えたことだけを書く
      cleared = false;
      const trigger = compactTriggerOf(e);
      const auto = trigger?.percent ?? null;
      const text = [
        `tanacode reset the conversation of this session and resumed it from its checklists (optimized compaction${auto === null ? '' : `, automatic at ${auto}% of the context`}).`,
        trigger?.midTurn
          ? 'The reset was made in the middle of a turn, and the session then continued the same work: what follows is the rest of that work.'
          : continuedAt(events, i)
            ? 'After the reset, the session continued the work that was in progress: what follows is the rest of that work.'
            : 'What follows is its report of what it carried over, not a result of its work.',
      ].join(' ');
      current = { who: 'Notice', text, responses: [], notes: [], tools: [] };
      all.push(current);
    } else if (e.type === 'user') {
      const from = parentId ? 'the parent session' : 'the session that started this one,';
      current = { who: e.parent ? `Instruction from ${from} "${titleOf(e.parent)}"` : 'User message', text: [e.text, ...(e.pastes ?? [])].filter(Boolean).join('\n\n'), responses: [], notes: [], tools: [] };
      all.push(current);
    } else if (e.type === 'notice') {
      current = { who: 'Notice', text: e.text, responses: [], notes: [], tools: [] };
      all.push(current);
    } else if (e.type === 'checklist-stop') {
      stopped = true;
    } else if (e.type === 'assistant-text' && current) {
      (stopped ? current.notes : current.responses).push(e.text);
    } else if (e.type === 'tool-use' && current) {
      current.tools.push(e.target ? `${e.name} ${e.target}` : e.name);
    }
  }
  if (all.length === 0) return ['## Recent conversation', '(no conversation yet)'];
  const shown = all.slice(-turns);
  const lines = [`## Recent conversation (the latest ${shown.length} of ${all.length} ${all.length === 1 ? 'instruction' : 'instructions'})`];
  shown.forEach((turn, i) => {
    lines.push('', `### ${all.length - shown.length + i + 1}. ${turn.who}`, clip(turn.text, 3000));
    if (turn.responses.length > 0) {
      // 最後の応答（結果のまとめ）は長めに、途中の応答は短く。最後の応答を切ったら、全文の読み方を添える
      const responses = turn.responses.map((r, j) => clip(r, j === turn.responses.length - 1 ? responseChars : 600));
      lines.push('', 'Claude:', responses.join('\n\n'));
      const last = turn.responses[turn.responses.length - 1];
      if (last.length > responseChars) {
        lines.push(
          '',
          `(This response is ${last.length} characters long and was cut in the middle. To read it in full, call read_session with turns: 1 and max_response_chars: ${Math.min(last.length, MAX_RESPONSE_CHARS)}, or get_session with max_response_chars.)`,
        );
      }
    }
    // 結果のまとめのあとに続くので、結果と取り違えないように分けて、短く出す
    if (turn.notes.length > 0) lines.push('', 'Claude, after tanacode reminded it to update its checklists at the end of the turn:', clip(turn.notes.join('\n\n'), 600));
    if (turn.tools.length > 0) {
      const tools = turn.tools.slice(0, 30).join(', ');
      lines.push('', `Tools: ${tools}${turn.tools.length > 30 ? ` and ${turn.tools.length - 30} more` : ''}`);
    }
  });
  return lines;
}

// 会話の中で編集したファイル（フォルダからの相対。外のものは絶対パスのまま）
function editedFiles(events: ChatEvent[], cwd: string): string[] {
  const files = new Set<string>();
  for (const e of events) {
    if (e.type === 'reset' && !e.compact) files.clear();
    if (e.type !== 'tool-use' || !EDIT_TOOLS.has(e.name) || !e.filePath) continue;
    const rel = relative(cwd, e.filePath);
    // .. そのものか ../ で始まるものが外（..env.local のような名前のファイルは中）
    files.add(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : e.filePath);
  }
  return [...files].slice(0, 200);
}

async function branchOf(s: SessionSummary): Promise<string | null> {
  if (!existsSync(s.cwd)) return s.worktree?.branch ?? null;
  return git(s.cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).then(
    (out) => out.trim() || null,
    () => s.worktree?.branch ?? null,
  );
}

// 未追跡のファイルを、新しいファイルの差分の形にする（大きいもの・バイナリは中身を出さない）。
// ふつうのファイルだけを読む（シンボリックリンクの先・デバイス・名前付きパイプは読まない）。読む大きさにも上限を付ける。
// folder: セッションのフォルダ（リンクを解いたもの）。リンクを解いた場所がその外になるファイルは読まない
async function untrackedDiff(cwd: string, folder: string, file: string): Promise<string> {
  const head = `diff --git a/${file} b/${file}\nnew file (untracked)\n--- /dev/null\n+++ b/${file}`;
  const info = await lstat(join(cwd, file)).catch(() => null);
  if (!info) return head;
  if (info.isSymbolicLink()) return `${head}\n(symbolic link; contents not read)`;
  if (!info.isFile()) return `${head}\n(not a regular file; contents not read)`;
  const real = await realpath(join(cwd, file)).catch(() => null);
  if (!real || !insideFolder(folder, real)) return `${head}\n(outside the session folder; contents not read)`;
  if (info.size > MAX_UNTRACKED_BYTES) return `${head}\n(large file of ${Math.round(info.size / 1024)} KB; contents omitted)`;
  const data = await readHead(join(cwd, file), MAX_UNTRACKED_BYTES);
  // 空のファイルは、行の無い新しいファイル（git diff と同じく @@ の行を書かない）
  if (!data || data.length === 0) return head;
  if (data.includes(0)) return `${head}\n(binary)`;
  const lines = data.toString('utf8').replace(/\n$/, '').split('\n');
  return `${head}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}

// ファイルの先頭から、limit バイトまで読む（読めなければ null）
async function readHead(path: string, limit: number): Promise<Buffer | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

// フォルダの外を指さない相対パスにする。git の pathspec の書き方（:(top)・:/ など。: で始まるもの）は受け付けない
function safeRelative(path: string): string {
  const rel = normalize(path).replace(/\/+$/, '');
  if (path.startsWith(':') || rel.startsWith(':')) throw new ToolError('Pass path as a plain path relative to the session folder (git pathspec magic such as ":(top)" is not accepted).');
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new ToolError('Pass path as a path relative to the session folder.');
  return rel === '.' ? '' : rel;
}

// path（リンクを解いたもの）が folder の中か
function insideFolder(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// 中身の最も長いバッククォートの連続より長いフェンスで囲む（中身の ``` でブロックから抜けないように）
function fence(content: string, lang: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const mark = '`'.repeat(Math.max(3, longest + 1));
  return `${mark}${lang}\n${content}\n${mark}`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n…(${omitted} ${omitted === 1 ? 'character' : 'characters'} omitted)…\n${text.slice(text.length - (max - head))}`;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function intArg(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function json(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

// 失敗を Claude に返す文。worktree の失敗は、画面の言語の文の代わりに英語の文にする（ロックの理由など、添える言葉はそのまま）
function errorText(error: unknown): string {
  if (error instanceof WorktreeError) return error.detail ? `${WORKTREE_FAILURE[error.reason]} (${error.detail})` : WORKTREE_FAILURE[error.reason];
  return error instanceof Error ? error.message : String(error);
}

function lastOf<T, S extends T>(list: T[], match: (item: T) => item is S): S | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (match(item)) return item;
  }
  return undefined;
}

type Prompt = Extract<ChatEvent, { type: 'user' | 'notice' }>;
const isPrompt = (e: ChatEvent): e is Prompt => e.type === 'user' || e.type === 'notice';
const isUser = (e: ChatEvent): e is Extract<ChatEvent, { type: 'user' }> => e.type === 'user';
// 知らせの全文（最適化圧縮の仕上げの頼み・再開の文）
const detailOf = (e: Extract<ChatEvent, { type: 'notice' }>): string => e.detail ?? '';
const isResume = (e: ChatEvent): e is Extract<ChatEvent, { type: 'notice' }> => e.type === 'notice' && e.compact === 'resume';
// ターンのはじまり（発言・知らせ・別の Claude からの知らせ）
const startsTurn = (e: ChatEvent): boolean => e.type === 'user' || e.type === 'notice' || e.type === 'turn-start';

// 親に知らせる、子の出来事。limit: 利用枠に当たって止まった（その知らせ）
// 親に知らせる子の出来事。キーは子の ID（子の状態の知らせ）か、別のキー（予約・最初の指示を送れなかった知らせ。child に子の ID）
// firstPrompt: 最初の指示を送れなかった理由 / firstMessage: その指示 / sendFailed: send_message で預かった指示を送れなかった（送ろうとした指示と、送れなかった理由）
type ChildNotice = {
  child?: string;
  state: SessionState;
  at: number;
  limit?: UsageLimitStop;
  scheduled?: ScheduledMessage;
  firstPrompt?: string;
  firstMessage?: string;
  sendFailed?: { message: string; reason: string };
};

// 最後のターンが、プランの利用枠に当たって止まったなら、その知らせ（あきらめた API エラーのあとに、応答もツールの呼び出しも無い）
function usageLimitStopOf(events: ChatEvent[]): UsageLimitStop | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'api-error' && !e.retrying) return e.limit ?? null;
    if (startsTurn(e) || e.type === 'assistant-text' || e.type === 'tool-use') return null;
  }
  return null;
}

// 応答を、作業の応答（work）と、チェックリストを直した報告（notes）に分ける。
// チェックリストを使い続けさせるフック（checklist-hook.ts）がターンの終わりを止めると、Claude はリストを直して 1 行で報告する。
// それは作業の結果ではないので、ほかのセッションに「最後の応答」として返さない。次のターンのはじまりで、作業の応答に戻る
function responsesOf(events: ChatEvent[]): { work: string[]; notes: string[] } {
  const work: string[] = [];
  const notes: string[] = [];
  let stopped = false;
  for (const e of events) {
    if (startsTurn(e)) stopped = false;
    else if (e.type === 'checklist-stop') stopped = true;
    else if (e.type === 'assistant-text') (stopped ? notes : work).push(e.text);
  }
  return { work, notes };
}

// 再開の文（知らせ。at: その場所）のターンで、作業を続けたか（compact-notice.ts の resumeContinued）。
// 続けたなら、そのあとの応答は作業の続き。続けなかった（答えを待っている・続ける作業が無い）なら、引き継いだことの報告
function continuedAt(events: ChatEvent[], at: number): boolean {
  const resume = events[at];
  if (resume?.type !== 'notice') return false;
  const end = events.findIndex((e, i) => i > at && startsTurn(e));
  return resumeContinued(resume, events.slice(at + 1, end === -1 ? undefined : end));
}

// 会話から、最適化圧縮のぶんを除く。仕上げの頼みと再開の文（知らせ）と、その返事。
// - 再開のあとに作業を続けた切り替え（途中で止めたもの・再開のターンでチェックリスト以外のツールを使ったもの）では、
//   再開のあとの応答は作業の続きなので残す（切り替える前の指示の応答として読める）
// - 仕上げのターンの応答は、そのあと会話を消した（切り替えた）ときだけ除く。取りやめになったときは残す。
//   Claude が仕上げの頼みに従わず、そのターンで元の作業を続けることがある（実機の Haiku 5.5 で起きた。除くと、作業の結果が読めない）
// flowing: 流れが進んでいる途中（最後の仕上げのターンは、まだ取りやめと決まっていないので除く）
function withoutCompaction(events: ChatEvent[], flowing = false): ChatEvent[] {
  const kept: ChatEvent[] = [];
  let skipping = false;
  // アプリが /clear を打って、まだ再開の文を送っていない（新しい会話に残る /clear のコマンドの発言を除く）
  let cleared = false;
  // 仕上げのターンのイベント（切り替えたら捨て、取りやめなら残す）
  let handoff: ChatEvent[] | null = null;
  for (const [i, e] of events.entries()) {
    if (e.type === 'reset' && e.compact) {
      cleared = true;
      handoff = null;
      continue;
    }
    if (e.type === 'notice' && e.compact) {
      cleared = false;
      if (handoff) kept.push(...handoff);
      handoff = e.compact === 'handoff' ? [] : null;
      skipping = e.compact === 'resume' && !continuedAt(events, i);
      continue;
    }
    if (cleared && e.type === 'user' && e.command) continue;
    if (startsTurn(e)) {
      skipping = false;
      if (handoff) kept.push(...handoff);
      handoff = null;
    }
    if (handoff) handoff.push(e);
    else if (!skipping) kept.push(e);
  }
  if (handoff && !flowing) kept.push(...handoff);
  return kept;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// テストで使う
export const testing = { conversationLines, editedFiles, safeRelative, withoutCompaction };
