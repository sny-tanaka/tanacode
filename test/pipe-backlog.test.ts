import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PipeBacklog, readLines } from '../src/main/pipe-backlog';
import { RETAIN_RULES, TRANSIENT_KINDS } from '../src/main/stream/protocol';

// パイプでつながる claude の出力の行の控え（常駐のホストと、互換性の確認の偽物のホストが使う）

const line = (value: Record<string, unknown>) => JSON.stringify(value);

describe('PipeBacklog', () => {
  it('行に 1 から通し番号を付けて控え、from 以降を送り直せる。書いている途中の行と読めない行は、番号だけ付けて控えない', () => {
    const backlog = new PipeBacklog(RETAIN_RULES, TRANSIENT_KINDS);
    expect(backlog.firstSeq).toBe(1);
    expect(backlog.receive(line({ type: 'system', subtype: 'init', session_id: 'a' }))).toBe(1);
    expect(backlog.receive(line({ type: 'stream_event', event: {} }))).toBe(2);
    expect(backlog.receive('{壊れた')).toBe(3);
    expect(backlog.receive('[1]')).toBe(4);
    expect(backlog.receive(line({ type: 'assistant' }))).toBe(5);
    expect(backlog.lastSeq).toBe(5);
    expect(backlog.since(1).map((l) => l.seq)).toEqual([1, 5]);
    expect(backlog.since(2).map((l) => l.seq)).toEqual([5]);
    expect(backlog.firstSeq).toBe(1);
  });

  it('合計が上限を超えたら古い行から捨てる（最後の 1 行は残す）。種類ごとの最新の行は、捨てずに別に持つ', () => {
    const backlog = new PipeBacklog(RETAIN_RULES, TRANSIENT_KINDS, 140);
    backlog.receive(line({ type: 'system', subtype: 'init', session_id: 'first' }));
    backlog.receive(line({ type: 'assistant', text: 'x'.repeat(40) }));
    backlog.receive(line({ type: 'assistant', text: 'y'.repeat(40) }));
    expect(backlog.firstSeq).toBe(2);
    backlog.receive(line({ type: 'assistant', text: 'z'.repeat(200) }));
    expect(backlog.since(1).map((l) => l.seq)).toEqual([4]);
    expect(backlog.firstSeq).toBe(4);
    expect(backlog.retained().map((l) => l.seq)).toEqual([1]);
  });

  it('種類ごとの最新: key が無ければ種類ごとに 1 つ。key があれば値ごとに 1 つで、until の行が同じ値で来たら捨てる', () => {
    const backlog = new PipeBacklog(RETAIN_RULES, TRANSIENT_KINDS);
    backlog.receive(line({ type: 'system', subtype: 'init', session_id: 'a' }));
    backlog.receive(line({ type: 'system', subtype: 'status', status: 'requesting' }));
    backlog.receive(line({ type: 'system', subtype: 'task_started', task_id: 't1' }));
    backlog.receive(line({ type: 'system', subtype: 'task_started', task_id: 't2' }));
    backlog.receive(line({ type: 'system', subtype: 'init', session_id: 'b' }));
    backlog.receive(line({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' }));
    backlog.receive(line({ type: 'rate_limit_event', rate_limit_info: {} }));
    // key の値が文字でない行は、残さない・捨てない
    backlog.receive(line({ type: 'system', subtype: 'task_started', task_id: 3 }));
    backlog.receive(line({ type: 'system', subtype: 'task_notification', task_id: 4 }));
    expect(backlog.retained().map((l) => [l.seq, JSON.parse(l.line).session_id ?? JSON.parse(l.line).task_id ?? JSON.parse(l.line).type])).toEqual([
      [2, 'system'],
      [4, 't2'],
      [5, 'b'],
      [7, 'rate_limit_event'],
    ]);
  });

  it('claude の制御の要求を、答え（アプリの control_response）か取り消しか終了まで控える', () => {
    const backlog = new PipeBacklog(RETAIN_RULES, TRANSIENT_KINDS);
    backlog.receive(line({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool' } }));
    backlog.receive(line({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool' } }));
    backlog.receive(line({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool' } }));
    backlog.receive(line({ type: 'control_request', request: { subtype: 'can_use_tool' } }));
    backlog.sent(line({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } }));
    backlog.sent(line({ type: 'user', message: {} }));
    backlog.sent(line({ type: 'control_response', response: {} }));
    backlog.sent('{壊れた');
    backlog.receive(line({ type: 'control_cancel_request', request_id: 'r2' }));
    expect(backlog.pending().map((l) => JSON.parse(l.line).request_id)).toEqual(['r3']);
    backlog.exited();
    expect(backlog.pending()).toEqual([]);
  });
});

describe('readLines', () => {
  const collect = (maxLength?: number) => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const dropped: number[] = [];
    readLines(stream, (l) => lines.push(l), (n) => dropped.push(n), maxLength);
    return { stream, lines, dropped };
  };

  it('改行で区切り、途中で切れた行は次の出力とつなぐ。空の行は飛ばす。文字の途中で切れても、正しくつなぐ', () => {
    const { stream, lines } = collect();
    stream.write('{"a":1}\n{"b":');
    stream.write('2}\n\n   \n');
    const bytes = Buffer.from('{"c":"日本"}\n', 'utf8');
    stream.write(bytes.subarray(0, 8));
    stream.write(bytes.subarray(8));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":"日本"}']);
  });

  it('長すぎる行は、次の改行まで捨てて長さを知らせ、そのあとは読み直す', () => {
    const { stream, lines, dropped } = collect(10);
    stream.write('short\n0123456789');
    stream.write('ABCDEF');
    stream.write('GHI\nnext\n');
    stream.write('0123456789ABC\n');
    expect(lines).toEqual(['short', 'next']);
    expect(dropped).toEqual([19, 13]);
  });
});
