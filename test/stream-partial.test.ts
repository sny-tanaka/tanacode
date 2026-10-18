import type { TranscriptEntry } from '@shared/chat';
import { CHECKLIST_UNCHANGED_MARK } from '@shared/checklist-tools';
import { describe, expect, it } from 'vitest';
import type { StreamEventMessage } from '../src/main/stream/protocol';
import { PartialText } from '../src/main/stream/partial';

// 書いている途中の応答から、チャットに出す途中の文を組み立てる（src/main/stream/partial.ts）

// 書いている途中の行（stream_event）。extra: 行の外側の欄（abandoned_blocks など）
const event = (value: StreamEventMessage['event'], extra: Partial<StreamEventMessage> = {}): StreamEventMessage => ({
  type: 'stream_event',
  event: value,
  parent_tool_use_id: null,
  uuid: 'u',
  session_id: 's',
  ...extra,
});
const start = (id: string) => event({ type: 'message_start', message: { id } });
const block = (index: number, type: string, initial?: string) =>
  event({
    type: 'content_block_start',
    index,
    content_block: { type, ...(initial === undefined ? {} : type === 'thinking' ? { thinking: initial } : { text: initial }) },
  });
const text = (index: number, value: string) => event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } });
const thinking = (index: number, value: string) => event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: value } });
const stop = (index: number) => event({ type: 'content_block_stop', index });
// 応答の終わり。abandoned: 取り直すために捨てたブロック（この応答の from_block_index から先）
const end = (abandoned?: StreamEventMessage['abandoned_blocks']) => event({ type: 'message_stop' }, abandoned ? { abandoned_blocks: abandoned } : {});
// 会話ログの本体の応答の行
const line = (id: string, apiBlockIndex?: number, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text: 'x' }] },
  ...(apiBlockIndex === undefined ? {} : { apiBlockIndex }),
  ...extra,
});

function feed(partial: PartialText, ...lines: StreamEventMessage[]): void {
  for (const line of lines) partial.event(line);
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
    feed(partial, start('m'), block(0, 'tool_use'), event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } }), block(1, 'redacted_thinking'));
    feed(partial, block(2, 'thinking'), text(2, '思考に文の続き'), thinking(2, '考え'));
    feed(partial, block(3, 'text'), thinking(3, '文に思考の続き'), text(3, '答え'));
    feed(partial, event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '位置が無い' } }), event({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta' } }));
    feed(partial, event({ type: 'content_block_start', index: 4 }), event({ type: 'message_delta' }));
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
    feed(partial, event({ type: 'message_start', message: {} }), block(0, 'text'), text(0, 'id が無い'));
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

  it('渡す前に会話ログに出たブロックは、一度も渡さない（まとめて送る前に会話ログの応答が読めたとき。チャットには会話ログの応答だけが出る）', () => {
    const partial = new PartialText();
    feed(partial, start('m'), block(0, 'text'), text(0, 'すぐ書き終えた文'), stop(0));
    expect(partial.cover(line('m', 0))).toBe(true);
    expect(partial.take()).toBeNull();
  });

  it('次の応答が始まったら、書き終わらなかったブロックは外し、書き終わったブロックは会話ログに出るまで残す', () => {
    const partial = new PartialText();
    feed(partial, start('a'), block(0, 'text'), text(0, '書き終えた'), stop(0), block(1, 'text'), text(1, '書きかけ'));
    feed(partial, start('b'), block(0, 'text'), text(0, '次'));
    expect(partial.view().map((b) => b.id)).toEqual(['a:0', 'b:0']);
  });

  it('abandoned_blocks の付いた message_stop で、書き終わったブロックも外す（取り直した答えだけが残る）', () => {
    // 接続が途中で切れて取り直すとき、Claude Code は書きかけのブロックを閉じ（content_block_stop）、捨てたブロックを
    // message_stop で知らせる。捨てた応答は会話ログに出ない（2.1.302 で実測。#233）
    const partial = new PartialText();
    feed(partial, start('msg_A'), block(0, 'text'), text(0, '書きかけの文です。これは取り消されるはず'), stop(0));
    expect(partial.event(end({ api_message_id: 'msg_A', from_block_index: 0 }))).toBe(true);
    expect(partial.view()).toEqual([]);
    feed(partial, start('msg_B2'), block(0, 'text'), text(0, '取り直した答えです。'), stop(0), end());
    expect(partial.view()).toEqual([{ id: 'msg_B2:0', kind: 'text', text: '取り直した答えです。' }]);
  });

  it('abandoned_blocks の from_block_index より前のブロック（会話ログに出るもの）は残す。ほかの応答や形の違うものでは外さない', () => {
    const partial = new PartialText();
    feed(partial, start('m'), block(0, 'text'), text(0, '書き終えた'), stop(0), block(1, 'text'), text(1, '書きかけ'), stop(1));
    expect(partial.event(end({ api_message_id: 'other', from_block_index: 0 }))).toBe(false);
    expect(partial.event(end({ api_message_id: 'm' }))).toBe(false);
    expect(partial.view().map((b) => b.id)).toEqual(['m:0', 'm:1']);
    feed(partial, end({ api_message_id: 'm', from_block_index: 1 }));
    expect(partial.view().map((b) => b.id)).toEqual(['m:0']);
  });

  it('abandoned_blocks を付けずに取り消された応答（会話ログに出ない）のブロックは、あとから始まった応答の行が会話ログに出たら外す', () => {
    // ツールの呼び出しの形が壊れた応答の取り直し（tombstone）では、Claude Code は abandoned_blocks を付けずに流れを閉じ、
    // 取り消した応答を会話ログに書かない（2.1.302 で実測）。会話ログは応答の順に書かれるので、あとの応答の行が出たら、
    // 前の応答の残りはもう出ない
    const partial = new PartialText();
    const tombstoned = () => [start('a'), block(0, 'text'), text(0, '取り消される'), stop(0), event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }), end()];
    feed(partial, ...tombstoned(), start('b'), block(0, 'text'), text(0, '取り直した答え'), stop(0));
    // 次の応答が始まっただけでは、会話ログの行がまだ読めていないだけかもしれないので残す
    expect(partial.view().map((b) => b.id)).toEqual(['a:0', 'b:0']);
    // 流れていない応答（ほかの応答の行）では外さない
    expect(partial.cover(line('other', 0))).toBe(false);
    expect(partial.cover(line('b', 0))).toBe(true);
    expect(partial.view()).toEqual([]);

    // 会話ログの行が、あとの応答の始まりより先に読めたときも外す
    const early = new PartialText();
    feed(early, ...tombstoned());
    early.cover(line('b', 0));
    expect(early.view().map((b) => b.id)).toEqual(['a:0']);
    feed(early, start('b'));
    expect(early.view()).toEqual([]);
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
