import type { TranscriptEntry } from '@shared/chat';
import { CHECKLIST_UNCHANGED_MARK } from '@shared/checklist-tools';
import { describe, expect, it } from 'vitest';
import type { StreamEventMessage } from '../src/main/stream/protocol';
import { PartialText } from '../src/main/stream/partial';

// 書いている途中の応答から、チャットに出す途中の文を組み立てる（src/main/stream/partial.ts）

type Event = StreamEventMessage['event'];
const start = (id: string): Event => ({ type: 'message_start', message: { id } });
const block = (index: number, type: string, initial?: string): Event => ({
  type: 'content_block_start',
  index,
  content_block: { type, ...(initial === undefined ? {} : type === 'thinking' ? { thinking: initial } : { text: initial }) },
});
const text = (index: number, value: string): Event => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } });
const thinking = (index: number, value: string): Event => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: value } });
const stop = (index: number): Event => ({ type: 'content_block_stop', index });
// 会話ログの本体の応答の行
const line = (id: string, apiBlockIndex?: number, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text: 'x' }] },
  ...(apiBlockIndex === undefined ? {} : { apiBlockIndex }),
  ...extra,
});

function feed(partial: PartialText, ...events: Event[]): void {
  for (const event of events) partial.event(event);
}

describe('PartialText', () => {
  it('ブロックの始まりの文と続きをためる。前に渡したときから変わっていなければ take は null', () => {
    const partial = new PartialText();
    feed(partial, start('m'), block(0, 'text', 'は'), text(0, 'じめ'));
    expect(partial.take()).toEqual([{ id: 'm:0', kind: 'text', text: 'はじめ' }]);
    expect(partial.take()).toBeNull();
    expect(partial.event(text(0, 'まして'))).toBe(true);
    expect(partial.take()).toEqual([{ id: 'm:0', kind: 'text', text: 'はじめまして' }]);
  });

  it('文と思考だけを出す。ツールの入力・中身の無い思考（redacted_thinking）・種類の合わない続き・形の違う行は無視する', () => {
    const partial = new PartialText();
    feed(partial, start('m'), block(0, 'tool_use'), { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } }, block(1, 'redacted_thinking'));
    feed(partial, block(2, 'thinking'), text(2, '思考に文の続き'), thinking(2, '考え'));
    feed(partial, block(3, 'text'), thinking(3, '文に思考の続き'), text(3, '答え'));
    feed(partial, { type: 'content_block_delta', delta: { type: 'text_delta', text: '位置が無い' } }, { type: 'content_block_delta', index: 3, delta: { type: 'text_delta' } });
    feed(partial, { type: 'content_block_start', index: 4 }, { type: 'message_delta' });
    expect(partial.view()).toEqual([
      { id: 'm:2', kind: 'thinking', text: '考え' },
      { id: 'm:3', kind: 'text', text: '答え' },
    ]);
  });

  it('前後の空白は除き、空白だけのものと、チェックリストの目印の書きかけは出さない', () => {
    const partial = new PartialText();
    feed(partial, start('m'), block(0, 'text'), text(0, '\n\n'), block(1, 'text'), text(1, CHECKLIST_UNCHANGED_MARK.slice(0, 12)));
    expect(partial.view()).toEqual([]);
    feed(partial, block(2, 'text'), text(2, '\n本文\n'));
    expect(partial.view()).toEqual([{ id: 'm:2', kind: 'text', text: '本文' }]);
    // 目印の続きでなくなったら出す
    feed(partial, text(1, 'ではない文'));
    expect(partial.view().map((b) => b.id)).toEqual(['m:1', 'm:2']);
  });

  it('応答の始まりを見ていない続きの行は出さない', () => {
    const partial = new PartialText();
    expect(partial.event(block(0, 'text'))).toBe(false);
    expect(partial.event(text(0, '途中から'))).toBe(false);
    expect(partial.view()).toEqual([]);
    // id の無い応答の始まりも、出す応答にしない
    feed(partial, { type: 'message_start', message: {} }, block(0, 'text'), text(0, 'id が無い'));
    expect(partial.view()).toEqual([]);
  });

  it('会話ログの本体の応答の行で、そのブロックを外す（apiBlockIndex、無ければ同じ応答の行の数で）。サブエージェント・ほかの応答・ほかの種類の行では外さない', () => {
    const partial = new PartialText();
    feed(partial, start('m'), block(0, 'text'), text(0, 'a'), block(1, 'text'), text(1, 'b'), block(2, 'text'), text(2, 'c'));
    expect(partial.cover(line('m', 0, { isSidechain: true }))).toBe(false);
    expect(partial.cover(line('other', 0))).toBe(false);
    expect(partial.cover({ type: 'user', message: { id: 'm', content: [] } })).toBe(false);
    expect(partial.cover(line('', 0))).toBe(false);
    expect(partial.cover(line('m', 1))).toBe(true);
    expect(partial.view().map((b) => b.id)).toEqual(['m:0', 'm:2']);
    // apiBlockIndex の無い行は、同じ応答の行の数から決める（ここまでに見た位置の次）
    expect(partial.cover(line('m'))).toBe(true);
    expect(partial.view().map((b) => b.id)).toEqual(['m:0']);
    // 空でない文のブロックを外さなかった行は false
    expect(partial.cover(line('m', 2))).toBe(false);
  });

  it('外したブロックの続きの行（会話ログの方が先に読めたとき）は、出さない', () => {
    const partial = new PartialText();
    feed(partial, start('m'), block(0, 'text'), text(0, 'a'));
    partial.cover(line('m', 0));
    expect(partial.event(text(0, 'b'))).toBe(false);
    expect(partial.view()).toEqual([]);
  });

  it('会話ログの行が応答の始まりより先に届いても、そのブロックを出さない', () => {
    const partial = new PartialText();
    expect(partial.cover(line('m', 0))).toBe(false);
    feed(partial, start('m'), block(0, 'text'), text(0, 'もう出た'), block(1, 'text'), text(1, 'まだ'));
    expect(partial.view()).toEqual([{ id: 'm:1', kind: 'text', text: 'まだ' }]);
  });

  it('次の応答が始まったら、書き終わらなかったブロックは外し、書き終わったブロックは会話ログに出るまで残す', () => {
    const partial = new PartialText();
    feed(partial, start('a'), block(0, 'text'), text(0, '書き終えた'), stop(0), block(1, 'text'), text(1, '書きかけ'));
    feed(partial, start('b'), block(0, 'text'), text(0, '次'));
    expect(partial.view().map((b) => b.id)).toEqual(['a:0', 'b:0']);
  });

  it('覚えておく応答は 4 つまで。古いものから忘れ、今の応答は残す', () => {
    const partial = new PartialText();
    feed(partial, start('now'), block(0, 'text'), text(0, '今'));
    for (const id of ['x', 'y', 'z', 'w']) partial.cover(line(id, 0));
    expect(partial.view()).toEqual([{ id: 'now:0', kind: 'text', text: '今' }]);
    for (const id of ['a', 'b', 'c', 'd', 'e']) feed(partial, start(id), block(0, 'text'), text(0, id), stop(0));
    expect(partial.view().map((b) => b.id)).toEqual(['b:0', 'c:0', 'd:0', 'e:0']);
  });

  it('clear で全部を捨て、今の応答も忘れる（次の応答の始まりまで、続きの行を出さない）。捨てたあとの take は空を返す', () => {
    const partial = new PartialText();
    feed(partial, start('m'), block(0, 'text'), text(0, 'a'));
    partial.take();
    partial.clear();
    expect(partial.take()).toEqual([]);
    expect(partial.event(text(0, 'b'))).toBe(false);
    expect(partial.take()).toBeNull();
  });
});
