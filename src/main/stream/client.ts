import { randomBytes } from 'node:crypto';
import { unknownEvent, type UnknownEvent, type UnknownProblem } from '@shared/unknown-event';
import type { PipeHandle } from '../pty-host-client';
import type { HostedLine, HostedPipeInfo } from '../pty-host-protocol';
import type { LineLog } from './log';
import type { CanUseToolRequest, ControlResponseMessage, ElicitationRequest, ElicitationResult, PermissionResult, StreamMessage, UserInput } from './protocol';

// stream-json の claude 1 つとの、行の読み書き・制御の要求と返事の対応・待っている要求の管理（設計書 6 節）。
// SessionManager は行の形を知らずに、ここの関数と知らせだけを使う。
// 全部が JSON で届くので、予期しないものは機械的に見分ける: 読めない行・知らない種類は捨てて数え、控え（LineLog）とコンソールに残す。
// 使う項目の形が違う行も捨てて「読めない行」として数える。意図して捨てる種類（IGNORED_KINDS）は数えない。
// 使わない要求（意図して断るもの・知らないもの）が Claude Code から来たら、必ず error で返す（返さないと待ち続ける）。
// Claude Code が答えを待つ要求は 2 つ: can_use_tool（許可の確認・質問など）と elicitation（MCP サーバーから人への質問）。
// 数えたものは、未知のイベント（onUnknown）としてチャットにも出す。書いている途中の行（stream_event）と、前のアプリの頃の行は出さない

// 制御の要求の返事を待つ既定の上限
export const REQUEST_TIMEOUT_MS = 30_000;

export type StreamEvents = {
  // 出力の行（制御の要求・返事以外）。past: 引き継いだときに送り直してもらった、前のアプリの頃の行（通知などを出さない）
  onMessage(message: StreamMessage, past: boolean): void;
  // Claude Code が答えを待つ要求（can_use_tool）。答えは respond で返す
  // replayed: 引き継いだときに、前のアプリの頃から答えを待っている要求を出し直した
  onPermission(requestId: string, request: CanUseToolRequest, replayed: boolean): void;
  // MCP サーバーから人への質問（elicitation）。答えは respondElicitation で返す。受け取る先が無ければ、使わない要求と同じく error で返す
  onElicitation?(requestId: string, request: ElicitationRequest, replayed: boolean): void;
  // 待っていた要求を、Claude Code が取り下げた（スマホなど、ほかで先に答えた）
  onCancel(requestId: string): void;
  // claude が終わった。stderr: 標準エラーの末尾
  onExit(exitCode: number, stderr: string): void;
  // 引き継いだとき、前のアプリの頃の行を読み終えた
  onCaughtUp?(): void;
  // 知らない種類の行・形の違う行・読めない行・使わない種類の要求（数えたもの）。チャットに未知のイベントとして出す（バージョンは受け取る側が添える）
  onUnknown?(event: UnknownEvent): void;
};

// 制御の要求が失敗した（error の返事・時間切れ・終了）。reason: Claude Code の理由（時間切れなら timeout）
export class ControlError extends Error {
  constructor(
    readonly subtype: string,
    readonly reason: string,
  ) {
    super(`${subtype}: ${reason}`);
  }
}

type Waiting = { subtype: string; resolve: (response: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null };

export class StreamClient {
  // アプリが送った要求の返事待ち（request_id → 待っているもの）。request_id は tc-<この接続の印>-<連番>。
  // 起動し直したアプリの連番が、前のアプリの返事と重ならないよう、接続ごとの印を付ける
  private readonly waiting = new Map<string, Waiting>();
  private readonly prefix = `tc-${randomBytes(3).toString('hex')}`;
  private next = 0;
  // Claude Code が答えを待っている要求（request_id → 要求）
  private readonly permissions = new Map<string, CanUseToolRequest>();
  private readonly elicitations = new Map<string, ElicitationRequest>();
  // 引き継いだとき、この通し番号までは前のアプリの頃の行
  private pastUntil = 0;
  // 知らない種類の行と、読めない行の数（不具合を調べるため）
  readonly unknown = new Map<string, number>();
  malformed = 0;
  exited = false;

  constructor(
    private readonly pipe: PipeHandle,
    private readonly events: StreamEvents,
    private readonly log: LineLog | null = null,
  ) {}

  // 受け取り始める（新しく起動したプロセス）
  start(): void {
    this.pipe.onLine((line, seq) => this.receive(line, seq));
    this.pipe.onExit((exitCode, stderr) => this.exit(exitCode, stderr));
  }

  // 前のアプリが起動して動いているプロセスを引き継ぐ。ホストが控えている行を送り直してもらい（前のアプリの頃の行として渡す）、
  // まだ答えの無い要求を出し直す。控えの頭が欠けていても、種類ごとの最新の行（retained）は先に渡す
  adopt(info: HostedPipeInfo): void {
    this.pastUntil = info.lastSeq;
    this.pipe.onReplayed(() => this.events.onCaughtUp?.());
    // 送り直しを頼んでから受け取り始める（頼む前に届いていた新しい行は、送り直した行のあとに渡る）
    this.pipe.replay(info.firstSeq);
    for (const item of info.retained) if (item.seq < info.firstSeq) this.receivePast(item);
    for (const item of info.pending) this.raise(item.line, true);
    this.start();
  }

  // Claude Code が答えを待っている要求
  pendingPermissions(): [string, CanUseToolRequest][] {
    return [...this.permissions];
  }

  // 発言を送る
  send(input: UserInput): void {
    this.write(JSON.stringify(input));
  }

  // 制御の要求を送り、返事を待つ。error の返事・時間切れ・claude の終了は ControlError で失敗する。
  // timeoutMs: null なら時間を区切らない（返事か claude の終了まで待つ。initialize は MCP サーバーやフックを待つので、いつまでかかるか分からない）
  request<T extends object = Record<string, unknown>>(subtype: string, payload: Record<string, unknown> = {}, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.exited) return Promise.reject(new ControlError(subtype, 'exited'));
    const requestId = `${this.prefix}-${++this.next}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.waiting.delete(requestId);
              reject(new ControlError(subtype, 'timeout'));
            }, timeoutMs);
      this.waiting.set(requestId, { subtype, resolve: resolve as (response: Record<string, unknown>) => void, reject, timer });
      this.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype, ...payload } }));
    });
  }

  // 待っている要求（can_use_tool）に答える。もう待っていなければ（取り下げられた・答えた）false
  respond(requestId: string, result: PermissionResult): boolean {
    if (!this.permissions.delete(requestId)) return false;
    this.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: result } } satisfies ControlResponseMessage));
    return true;
  }

  // 待っている MCP サーバーの質問（elicitation）に答える。もう待っていなければ（取り下げられた・答えた）false
  respondElicitation(requestId: string, result: ElicitationResult): boolean {
    if (!this.elicitations.delete(requestId)) return false;
    this.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: result } } satisfies ControlResponseMessage));
    return true;
  }

  // 入力を閉じる
  end(): void {
    this.pipe.end();
  }

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    this.pipe.kill(signal);
  }

  // アプリの終了時。claude は動かしたまま、見るのをやめる
  detach(): void {
    this.clearWaiting('detached');
    this.pipe.detach();
    this.log?.close();
  }

  // 控えに覚え書きを書く（送受信の行ではない。あとで不具合を調べるときの手がかり）
  note(text: string): void {
    this.log?.write('!', text);
  }

  private write(line: string): void {
    this.log?.write('>', line);
    this.pipe.send(line);
  }

  private receive(line: string, seq: number): void {
    const past = seq <= this.pastUntil;
    const value = parse(line);
    // 書いている途中の行は数が多いので控えない
    if (value?.type !== 'stream_event') this.log?.write('<', line);
    if (!value) {
      this.malformed += 1;
      if (!past) this.report(...unreadable(line));
      return;
    }
    // 制御の要求・返事・取り下げも、形が違えば読めない行として数え、使わない種類の要求は知らない種類として数える
    // （控えのテストの unreadableStreamLines で、Claude Code の更新による変化に気づけるように）
    switch (value.type) {
      case 'control_response':
        // 形が違っても、待っている要求には渡す（受け取らないと、要求が時間切れまで待ち続ける）
        if (!isControlResponse(value)) {
          this.malformed += 1;
          if (!past) this.report('control_response', 'malformed', value);
        }
        // 前のアプリが送った要求への返事は、受け取らない
        if (!past) this.answered(value);
        return;
      case 'control_request':
        // 前のアプリの頃の要求は、ホストが控えている未回答のもの（adopt）だけを出し直す
        if (!past) this.raise(line);
        return;
      case 'control_cancel_request':
        if (typeof value.request_id !== 'string') {
          this.malformed += 1;
          if (!past) this.report('control_cancel_request', 'malformed', value);
        } else if (this.permissions.delete(value.request_id) || this.elicitations.delete(value.request_id)) this.events.onCancel(value.request_id);
        return;
    }
    if (IGNORED_KINDS.has(kindOf(value))) return;
    const message = messageOf(value);
    if (message === 'unknown') {
      this.countUnknown(kindOf(value));
      if (!past) this.report(kindOf(value), 'unknown', value);
      return;
    }
    if (!message) {
      this.malformed += 1;
      console.warn(`stream-json: 形の違う行を捨てました（${kindOf(value)}）`);
      // 書いている途中の行は、未知のイベントにしない（数が多く、形はテストの偽物の行で確かめる）
      if (!past && value.type !== 'stream_event') this.report(kindOf(value), 'malformed', value);
      return;
    }
    this.events.onMessage(message, past);
  }

  // 未知のイベントを知らせる。要求（control_request）は request_id、ほかは行の uuid で ID を作る（会話ログにも同じ行が出たら、画面で寄せる）
  private report(name: string, problem: UnknownProblem, value: unknown, source: 'stream' | 'request' = 'stream'): void {
    const record = isRecord(value) ? value : null;
    const key = source === 'request' ? record?.request_id : record?.uuid;
    this.events.onUnknown?.(unknownEvent(name, problem, source, value, { key: typeof key === 'string' ? key : undefined }));
  }

  // 控えの頭より前の、種類ごとの最新の行（引き継いだときだけ）
  private receivePast(item: HostedLine): void {
    const value = parse(item.line);
    const message = value ? messageOf(value) : null;
    if (message && message !== 'unknown') this.events.onMessage(message, true);
  }

  // Claude Code からの制御の要求。can_use_tool と elicitation は待っている要求にし、ほかは使わないので error で返す。
  // 意図して断る要求（DECLINED_REQUESTS）は数えず、知らない要求は数えて、未知のイベントにする
  private raise(line: string, replayed = false): void {
    const value = parse(line) as { request_id?: unknown; request?: { subtype?: unknown } } | null;
    const requestId = value?.request_id;
    if (typeof requestId !== 'string') {
      this.malformed += 1;
      if (!replayed) this.report('control_request', 'malformed', value, 'request');
      return;
    }
    if (this.permissions.has(requestId) || this.elicitations.has(requestId)) return;
    const request = value?.request;
    if (request?.subtype === 'can_use_tool' && isPermission(request)) {
      this.permissions.set(requestId, request);
      this.events.onPermission(requestId, request, replayed);
      return;
    }
    const answersElicitations = !!this.events.onElicitation;
    if (request?.subtype === 'elicitation' && answersElicitations && isElicitation(request)) {
      this.elicitations.set(requestId, request);
      this.events.onElicitation?.(requestId, request, replayed);
      return;
    }
    const subtype = typeof request?.subtype === 'string' ? request.subtype : 'unknown';
    const malformed = subtype === 'can_use_tool' || subtype === 'unknown' || (subtype === 'elicitation' && answersElicitations);
    if (malformed) this.malformed += 1;
    else if (!DECLINED_REQUESTS.has(subtype)) this.countUnknown(`control_request/${subtype}`);
    // 前のアプリの頃から答えを待っている要求（引き継いで出し直したもの）は、ほかの前の行と同じく出さない
    if (!replayed && !DECLINED_REQUESTS.has(subtype)) this.report(subtype === 'unknown' ? 'control_request' : `control_request/${subtype}`, malformed ? 'malformed' : 'unknown', value, 'request');
    this.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `tanacode does not handle ${subtype} requests.` } } satisfies ControlResponseMessage));
  }

  private answered(value: Record<string, unknown>): void {
    const response = value.response as { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown } | undefined;
    if (typeof response?.request_id !== 'string') return;
    const waiting = this.waiting.get(response.request_id);
    if (!waiting) return;
    this.waiting.delete(response.request_id);
    if (waiting.timer) clearTimeout(waiting.timer);
    if (response.subtype === 'success') waiting.resolve(isRecord(response.response) ? response.response : {});
    else waiting.reject(new ControlError(waiting.subtype, typeof response.error === 'string' ? response.error : 'error'));
  }

  private exit(exitCode: number, stderr: string): void {
    if (this.exited) return;
    this.exited = true;
    this.clearWaiting('exited');
    // 終わったプロセスの要求には、もう答えられない
    for (const requestId of [...this.permissions.keys(), ...this.elicitations.keys()]) {
      this.permissions.delete(requestId);
      this.elicitations.delete(requestId);
      this.events.onCancel(requestId);
    }
    this.log?.close();
    this.events.onExit(exitCode, stderr);
  }

  private clearWaiting(reason: string): void {
    for (const waiting of this.waiting.values()) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(new ControlError(waiting.subtype, reason));
    }
    this.waiting.clear();
  }

  private countUnknown(kind: string): void {
    const count = (this.unknown.get(kind) ?? 0) + 1;
    this.unknown.set(kind, count);
    if (count === 1) console.warn(`stream-json: 知らない種類の行を捨てました（${kind}）`);
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) && typeof value.type === 'string' ? value : null;
  } catch {
    return null;
  }
}

// 読めない行の、未知のイベントの名前・わけ・値。JSON として読めれば形の違う行（オブジェクトでない・種類の欄が無い）、読めなければ、その文字のまま
function unreadable(line: string): [string, UnknownProblem, unknown] {
  try {
    return ['', 'malformed', JSON.parse(line) as unknown];
  } catch {
    return ['', 'unparsable', line];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function kindOf(value: Record<string, unknown>): string {
  return typeof value.subtype === 'string' ? `${String(value.type)}/${value.subtype}` : String(value.type);
}

const str = (v: unknown): v is string => typeof v === 'string';

// Claude Code の制御の返事（アプリが送った要求への）。success の response は無いか、オブジェクト。error には文
function isControlResponse(value: Record<string, unknown>): boolean {
  const r = value.response;
  if (!isRecord(r) || !str(r.request_id)) return false;
  if (r.subtype === 'success') return r.response === undefined || isRecord(r.response);
  return r.subtype === 'error' && str(r.error);
}

function isPermission(request: unknown): request is CanUseToolRequest {
  const r = request as Partial<CanUseToolRequest>;
  return str(r.tool_name) && isRecord(r.input) && str(r.tool_use_id);
}

// MCP サーバーの質問。URL の形には開くページが要る。項目の形（requested_schema の中身）は、カードが読む（読めない項目は、断るだけにする）
function isElicitation(request: unknown): request is ElicitationRequest {
  const r = request as Partial<ElicitationRequest>;
  const mode = r.mode ?? 'form';
  return (
    str(r.mcp_server_name) &&
    str(r.message) &&
    (mode === 'form' || (mode === 'url' && str(r.url))) &&
    (r.elicitation_id === undefined || str(r.elicitation_id)) &&
    (r.requested_schema === undefined || isRecord(r.requested_schema)) &&
    (r.property_order === undefined || (Array.isArray(r.property_order) && r.property_order.every(str)))
  );
}

// / のコマンド（initialize の返事の commands と同じ形）。候補に使う name・description・aliases を確かめる
function isCommand(value: unknown): boolean {
  return isRecord(value) && str(value.name) && str(value.description) && (value.aliases === undefined || (Array.isArray(value.aliases) && value.aliases.every(str)));
}

// 種類は、どれも次の 3 つのどれか 1 か所にだけ書く（docs/claude-code-events.md の ✅・⏭・⚠️ と同じ分け方）
// - 使う: messageOf の case と SYSTEM_CHECKS（使う項目の形を確かめる）
// - 意図して捨てる: IGNORED_KINDS（理由つき。数えず、未知のイベントにもしない）
// - 知らない: どこにも書かない（数えて警告を出し、未知のイベントとしてチャットに出す）

// 意図して捨てる種類（種類、system は system/subtype）。理由ごとに並べる
const IGNORED_KINDS = new Set([
  // 時間で出る、生きている知らせ（2.1.302 は 30 秒ごとに出すことがある。知らない種類として数えると、控えのテスト
  // （unreadableStreamLines）がテストの長さしだいで落ちたり通ったりする）
  'keep_alive',
  // Remote Control のときに出る内部用（@internal）の、ターンの途中の「今していること」の一言と、ターンごとのまとめ（2.1.302）
  'system/task_summary',
  'system/post_turn_summary',
  // ほかの道で足りている
  // - 圧縮の区切り・お知らせの文・ローカルのコマンドの出力は、会話ログの行から出す（chat.ts）
  'system/compact_boundary',
  'system/informational',
  'system/local_command',
  // - 裏のタスクの経過・状態・一覧は、会話ログとタスクの出力のファイルから数える（task-router.ts と各トラッカー）
  'system/task_progress',
  'system/task_updated',
  'system/background_tasks_changed',
  // - 進み具合は stream_event から、フックは hook_started・hook_response と会話ログから作る
  'system/thinking_tokens',
  'system/hook_progress',
  // - 確認なしで断ったツールの理由は、会話ログのツールの結果に出る
  'system/permission_denied',
  // - セッションの名前は会話ログの custom-title、PR は会話ログの pr-link、Remote Control の終わりは bridge_state で分かる
  'system/session_title_changed',
  'system/code_change_published',
  'system/worker_shutting_down',
  // - 断られて取り直さなかった知らせは中身（content）が空。断られた応答そのものは会話ログに出る
  'system/model_refusal_no_fallback',
  // - モデルの切り替え（混雑など）と、思い出したメモリのお知らせは、会話ログの同じもの（model_fallback の行・relevant_memories）から出す（二重にしない）
  'system/model_fallback',
  'system/memory_recall',
  // tanacode の起動のしかたでは出ない（その機能を有効にしない・SessionStore を使わない・side_question を送らない・モデルを選ばせない）
  'prompt_suggestion',
  'auth_status',
  'transcript_mirror',
  'system/session_state_changed',
  'system/plugin_install',
  'system/mirror_error',
  'system/control_request_progress',
  'system/model_consent_fallback',
  // クラウドの開発環境・Remote Control・別の機能（プラグインの画面・フィードバックなど）向け
  'active_goal',
  'autocompact_state',
  'system/cloud_session_delta',
  'system/vcs_state_changed',
  'system/file_attachments_missing',
  'system/peer_message_hold',
  'system/feedback_draft_queued',
  'system/instruction_size_warning',
  'system/ui_invalidate',
  'system/ui_panes',
  'system/ui_scroll',
  'system/ui_focus',
  // 使い道がない（ターンごとのエフォートの変化・ツールの呼び出しのまとめの一言）
  'system/per_turn_effort_changed',
  'tool_use_summary',
]);

// Claude Code からの要求のうち、意図して断るもの（error で返し、知らない種類には数えない）。どれも、アプリがフック・MCP サーバー・
// ダイアログの種類・認証・Remote Control の鍵を、制御の要求で登録・宣言したときだけ来る（tanacode はしないので来ない）
const DECLINED_REQUESTS = new Set(['hook_callback', 'mcp_message', 'request_user_dialog', 'oauth_token_refresh', 'host_auth_token_refresh', 'remote_control_work_secret']);

// system の知らせのうち、使うもの（使う項目の形を確かめる）
const SYSTEM_CHECKS: Record<string, (v: Record<string, unknown>) => boolean> = {
  init: (v) => str(v.session_id) && str(v.model) && str(v.permissionMode),
  // 圧縮の終わり（compact_result・compact_error）は、作業中の表示とチャットの失敗の知らせに使う
  status: (v) =>
    (v.status === null || v.status === undefined || str(v.status)) &&
    (v.permissionMode === undefined || str(v.permissionMode)) &&
    (v.compact_result === undefined || v.compact_result === 'success' || v.compact_result === 'failed') &&
    (v.compact_error === undefined || typeof v.compact_error === 'string'),
  permission_check_status: (v) => str(v.tool_use_id) && (v.status === 'checking' || v.status === 'done') && (v.agent_id === undefined || str(v.agent_id)),
  task_started: (v) => str(v.task_id),
  task_notification: (v) => str(v.task_id) && str(v.status),
  bridge_state: (v) => str(v.state),
  api_retry: (v) => typeof v.attempt === 'number',
  commands_changed: (v) => Array.isArray(v.commands) && v.commands.every(isCommand),
  // URL の形の MCP サーバーの質問の完了。完了を待っているカードを閉じる
  elicitation_complete: (v) => str(v.mcp_server_name) && str(v.elicitation_id),
  hook_started: (v) => str(v.hook_id),
  // stdout・stderr は、何も出力しなかったフックをチャットに出すかを決めるので、どちらも文字列のときだけ使う（欄が無い・形が違えば、
  // 出さない側に倒す。読めない行として数えるので、毎日の確認で気づける）
  hook_response: (v) => str(v.hook_id) && str(v.hook_name) && str(v.hook_event) && str(v.outcome) && typeof v.stdout === 'string' && typeof v.stderr === 'string',
  // Claude Code の警告。key で出すかを決め、text をチャットに出す
  notification: (v) => str(v.key) && str(v.text),
  // 断られた応答の取り直し。お知らせは会話ログの同じ行から出し、ここでは取り消された応答を、書いている途中の文から外す
  model_refusal_fallback: (v) => v.retracted_message_uuids === undefined || (Array.isArray(v.retracted_message_uuids) && v.retracted_message_uuids.every(str)),
};

// 知っている種類の行を、使う項目の形を確かめて型にする。知らない種類は 'unknown'、形が違えば null
function messageOf(value: Record<string, unknown>): StreamMessage | 'unknown' | null {
  const ok = (check: boolean) => (check ? (value as unknown as StreamMessage) : null);
  switch (value.type) {
    case 'user':
      return ok(isRecord(value.message) && (str(value.message.content) || Array.isArray(value.message.content)));
    case 'assistant':
      return ok(isRecord(value.message) && str(value.uuid));
    case 'result':
      return ok(str(value.subtype) && typeof value.is_error === 'boolean');
    case 'conversation_reset':
      return ok(str(value.session_id));
    case 'stream_event':
      return ok(isRecord(value.event) && str(value.event.type));
    case 'tool_progress':
      return ok(str(value.tool_use_id));
    case 'rate_limit_event':
      return ok(isRecord(value.rate_limit_info));
    case 'command_lifecycle':
      return ok(str(value.command_uuid) && str(value.state));
    case 'system': {
      const check = str(value.subtype) ? SYSTEM_CHECKS[value.subtype] : undefined;
      return check ? ok(check(value)) : 'unknown';
    }
    default:
      return 'unknown';
  }
}

export const testing = { messageOf, parse };
