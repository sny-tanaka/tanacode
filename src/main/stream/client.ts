import { randomBytes } from 'node:crypto';
import type { PipeHandle } from '../pty-host-client';
import type { HostedLine, HostedPipeInfo } from '../pty-host-protocol';
import type { LineLog } from './log';
import type { CanUseToolRequest, ControlResponseMessage, PermissionResult, StreamMessage, UserInput } from './protocol';

// stream-json の claude 1 つとの、行の読み書き・制御の要求と返事の対応・待っている要求の管理（設計書 6 節）。
// SessionManager は行の形を知らずに、ここの関数と知らせだけを使う。
// 全部が JSON で届くので、予期しないものは機械的に見分ける: 読めない行・知らない種類は捨てて数え、控え（LineLog）とコンソールに残す。
// 使う項目の形が違う行も捨てて「読めない行」として数える。知らない要求が Claude Code から来たら、必ず error で返す（返さないと待ち続ける）

// 制御の要求の返事を待つ既定の上限
export const REQUEST_TIMEOUT_MS = 30_000;

export type StreamEvents = {
  // 出力の行（制御の要求・返事以外）。past: 引き継いだときに送り直してもらった、前のアプリの頃の行（通知などを出さない）
  onMessage(message: StreamMessage, past: boolean): void;
  // Claude Code が答えを待つ要求（can_use_tool）。答えは respond で返す
  // replayed: 引き継いだときに、前のアプリの頃から答えを待っている要求を出し直した
  onPermission(requestId: string, request: CanUseToolRequest, replayed: boolean): void;
  // 待っていた要求を、Claude Code が取り下げた（スマホなど、ほかで先に答えた）
  onCancel(requestId: string): void;
  // claude が終わった。stderr: 標準エラーの末尾
  onExit(exitCode: number, stderr: string): void;
  // 引き継いだとき、前のアプリの頃の行を読み終えた
  onCaughtUp?(): void;
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
      return;
    }
    // 制御の要求・返事・取り下げも、形が違えば読めない行として数え、使わない種類の要求は知らない種類として数える
    // （控えのテストの unreadableStreamLines で、Claude Code の更新による変化に気づけるように）
    switch (value.type) {
      case 'control_response':
        // 形が違っても、待っている要求には渡す（受け取らないと、要求が時間切れまで待ち続ける）
        if (!isControlResponse(value)) this.malformed += 1;
        // 前のアプリが送った要求への返事は、受け取らない
        if (!past) this.answered(value);
        return;
      case 'control_request':
        // 前のアプリの頃の要求は、ホストが控えている未回答のもの（adopt）だけを出し直す
        if (!past) this.raise(line);
        return;
      case 'control_cancel_request':
        if (typeof value.request_id !== 'string') this.malformed += 1;
        else if (this.permissions.delete(value.request_id)) this.events.onCancel(value.request_id);
        return;
    }
    if (IGNORED_KINDS.has(kindOf(value))) return;
    const message = messageOf(value);
    if (message === 'unknown') {
      this.countUnknown(kindOf(value));
      return;
    }
    if (!message) {
      this.malformed += 1;
      console.warn(`stream-json: 形の違う行を捨てました（${kindOf(value)}）`);
      return;
    }
    this.events.onMessage(message, past);
  }

  // 控えの頭より前の、種類ごとの最新の行（引き継いだときだけ）
  private receivePast(item: HostedLine): void {
    const value = parse(item.line);
    const message = value ? messageOf(value) : null;
    if (message && message !== 'unknown') this.events.onMessage(message, true);
  }

  // Claude Code からの制御の要求。can_use_tool は待っている要求にし、ほかは使わないので error で返す
  private raise(line: string, replayed = false): void {
    const value = parse(line) as { request_id?: unknown; request?: { subtype?: unknown } } | null;
    const requestId = value?.request_id;
    if (typeof requestId !== 'string') {
      this.malformed += 1;
      return;
    }
    if (this.permissions.has(requestId)) return;
    const request = value?.request;
    if (request?.subtype === 'can_use_tool' && isPermission(request)) {
      this.permissions.set(requestId, request);
      this.events.onPermission(requestId, request, replayed);
      return;
    }
    const subtype = typeof request?.subtype === 'string' ? request.subtype : 'unknown';
    if (subtype === 'can_use_tool' || subtype === 'unknown') this.malformed += 1;
    else this.countUnknown(`control_request/${subtype}`);
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
    for (const requestId of [...this.permissions.keys()]) {
      this.permissions.delete(requestId);
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

// 使わないと分かっていて、黙って捨てる種類。時間で出る行（keep_alive。2.1.302 は 30 秒ごとに出すことがある）は、
// 知らない種類として数えると、控えのテスト（unreadableStreamLines）がテストの長さしだいで落ちたり通ったりする
const IGNORED_KINDS = new Set(['keep_alive']);

// system の知らせのうち、使うもの（使う項目の形を確かめる）と、種類だけを見るもの
const SYSTEM_CHECKS: Record<string, (v: Record<string, unknown>) => boolean> = {
  init: (v) => str(v.session_id) && str(v.model) && str(v.permissionMode),
  status: (v) => v.permissionMode === undefined || str(v.permissionMode),
  task_started: (v) => str(v.task_id),
  task_notification: (v) => str(v.task_id) && str(v.status),
  bridge_state: (v) => str(v.state),
  compact_boundary: (v) => isRecord(v.compact_metadata),
  api_retry: (v) => typeof v.attempt === 'number',
  task_progress: () => true,
  task_updated: () => true,
  background_tasks_changed: () => true,
  thinking_tokens: () => true,
  hook_started: () => true,
  hook_progress: () => true,
  hook_response: () => true,
  local_command: () => true,
  informational: () => true,
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
