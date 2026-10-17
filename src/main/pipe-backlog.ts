import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { BACKLOG_BYTES, MAX_LINE_BYTES, matchesKind, valueAt, type HostedLine, type LineKind, type RetainRule } from './pty-host-protocol';

// パイプでつながるプロセス（stream-json の claude）の出力の行の控え。常駐のホスト（pty-host.ts）と、互換性の確認の偽物のホスト
// （test/cli）が使う。ホストの解釈はここに書いたことに限る（設計書 5 節）:
// - 行に通し番号（1 から）を付けて控える。合計が上限を超えたら古い行から捨てる（チャットの中身は会話ログから追いつける）
// - 種類ごとの最新の行（RetainRule）は、上限と別に持ち、捨てない（控えの頭が欠けても、モードや裏のタスクを組み立て直せるように）
// - claude が送った制御の要求は、アプリの答え（control_response）か、claude の取り消し（control_cancel_request）まで控える
// - 書いている途中の行（transient）は控えない
export class PipeBacklog {
  private lines: HostedLine[] = [];
  private bytes = 0;
  lastSeq = 0;
  // 決まりの番号と key の値 → 行
  private readonly retainedLines = new Map<string, HostedLine>();
  // request_id → 行
  private readonly pendingLines = new Map<string, HostedLine>();

  constructor(
    private readonly retainRules: RetainRule[],
    private readonly transient: LineKind[],
    private readonly maxBytes = BACKLOG_BYTES,
  ) {}

  // claude の出力の 1 行を受け取り、通し番号を返す。読めない行も番号は付けるが、控えない
  receive(line: string): number {
    const seq = ++this.lastSeq;
    const item: HostedLine = { seq, line };
    const value = parseObject(line);
    if (!value) return seq;
    if (value.type === 'control_request' && typeof value.request_id === 'string') this.pendingLines.set(value.request_id, item);
    if (value.type === 'control_cancel_request' && typeof value.request_id === 'string') this.pendingLines.delete(value.request_id);
    this.retain(value, item);
    if (!this.transient.some((kind) => matchesKind(value, kind))) this.keep(item);
    return seq;
  }

  // アプリが入力に書いた行。claude の要求への答えなら、その要求を控えから外す（同じ要求に二重に答えないため）
  sent(line: string): void {
    const value = parseObject(line) as { type?: unknown; response?: { request_id?: unknown } } | null;
    if (value?.type === 'control_response' && typeof value.response?.request_id === 'string') this.pendingLines.delete(value.response.request_id);
  }

  // プロセスが終わった。終わったプロセスへの要求には、もう答えられない
  exited(): void {
    this.pendingLines.clear();
  }

  // from 以降の控えている行（送り直し）
  since(from: number): HostedLine[] {
    return this.lines.filter((item) => item.seq >= from);
  }

  // 控えに残っているいちばん古い行の番号（空なら lastSeq + 1）
  get firstSeq(): number {
    return this.lines[0]?.seq ?? this.lastSeq + 1;
  }

  // 種類ごとの最新の行（古い順）
  retained(): HostedLine[] {
    return [...this.retainedLines.values()].sort((a, b) => a.seq - b.seq);
  }

  // まだ答えも取り消しも無い要求（来た順）
  pending(): HostedLine[] {
    return [...this.pendingLines.values()];
  }

  private retain(value: Record<string, unknown>, item: HostedLine): void {
    this.retainRules.forEach((rule, index) => {
      for (const until of rule.until ?? []) {
        if (!matchesKind(value, until)) continue;
        if (until.key === undefined) {
          // その決まりの行をすべて捨てる
          for (const name of [...this.retainedLines.keys()]) if (name.startsWith(`${index}:`)) this.retainedLines.delete(name);
          continue;
        }
        const key = keyOf(valueAt(value, until.key));
        if (key !== null) this.retainedLines.delete(`${index}:${key}`);
      }
      if (!matchesKind(value, rule)) return;
      if (!rule.key) {
        this.retainedLines.set(`${index}:`, item);
        return;
      }
      const key = keyOf(valueAt(value, rule.key));
      if (key !== null) this.retainedLines.set(`${index}:${key}`, item);
    });
  }

  private keep(item: HostedLine): void {
    this.lines.push(item);
    this.bytes += item.line.length;
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      const dropped = this.lines.shift()!;
      this.bytes -= dropped.line.length;
    }
  }
}

// 残す行の key の値（文字か数だけ）。使えなければ null
function keyOf(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 捨てた長すぎる行のうち、知らせに添える頭の長さ（答えを待っている要求かを見分けるのに使う）
export const DROPPED_HEAD_CHARS = 4096;

// 出力を改行で区切って 1 行ずつ渡す（空の行は飛ばす）。出力の終わりに改行の無い最後の行も渡す。
// 長すぎる行（maxBytes バイトを超える）は捨てて、長さ（バイト）と行の頭を onDropped で知らせ、次の改行から読み直す
export function readLines(
  stream: Readable,
  onLine: (line: string) => void,
  onDropped: (bytes: number, head: string) => void,
  maxBytes = MAX_LINE_BYTES,
): void {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let bufferedBytes = 0;
  // 捨てている途中の行の長さ（バイト。捨てていなければ 0）と、その行の頭
  let dropping = 0;
  let droppedHead = '';
  // 改行で終わった（または出力が終わった）1 行
  const finish = (rest: string) => {
    if (dropping > 0) {
      onDropped(dropping + Buffer.byteLength(rest), droppedHead);
      dropping = 0;
      droppedHead = '';
      return;
    }
    const line = buffered + rest;
    const bytes = bufferedBytes + Buffer.byteLength(rest);
    buffered = '';
    bufferedBytes = 0;
    if (bytes > maxBytes) onDropped(bytes, line.slice(0, DROPPED_HEAD_CHARS));
    else if (line.trim()) onLine(line);
  };
  // 改行の無い続き
  const hold = (text: string) => {
    if (dropping > 0) {
      dropping += Buffer.byteLength(text);
      return;
    }
    buffered += text;
    bufferedBytes += Buffer.byteLength(text);
    if (bufferedBytes > maxBytes) {
      dropping = bufferedBytes;
      droppedHead = buffered.slice(0, DROPPED_HEAD_CHARS);
      buffered = '';
      bufferedBytes = 0;
    }
  };
  const read = (text: string) => {
    for (;;) {
      const newline = text.indexOf('\n');
      if (newline === -1) break;
      finish(text.slice(0, newline));
      text = text.slice(newline + 1);
    }
    hold(text);
  };
  stream.on('data', (chunk: Buffer | string) => read(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  stream.on('end', () => {
    read(decoder.end());
    if (dropping > 0 || buffered) finish('');
  });
}
