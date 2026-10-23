// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, PartialBlock } from '@shared/chat';
import { chatFromEvents, useSessionChats } from '../../src/renderer/src/chat/chatState';
import { mockApi } from './mock-api';
import { random, randomChatEvents } from './random-chat-events';

// チャットの行の組み立て。行の位置の索引を、配信をまたいで引き継いでも、まとめて組み立てたときと同じ行になるか。
// 前の配列は書き換えず（React の不変性）、変えない行は同じもののままか

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi();
  api.install();
});

function receiver() {
  const { result } = renderHook(() => useSessionChats('s1', null));
  let seq = 0;
  return {
    chat: () => result.current.chatOf('s1'),
    send(events: ChatEvent[], partial?: PartialBlock[]) {
      act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: seq, events, live: true, partial }));
      seq += events.length;
    },
  };
}

describe('チャットの行の組み立て', () => {
  it('ばらばらの配信で受けても、まとめて組み立てたのと同じ行になる', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rnd = random(seed);
      const events = randomChatEvents(rnd, 120);
      const chat = receiver();
      for (let i = 0; i < events.length; ) {
        const n = 1 + Math.floor(rnd() * 5);
        chat.send(events.slice(i, i + n));
        i += n;
      }
      expect(chat.chat().items, `seed ${seed}`).toEqual(chatFromEvents(events).items);
    }
  });

  it('前の配列は書き換えず、変えない行は同じもののまま、変えた行は新しいものになる', () => {
    const chat = receiver();
    chat.send([
      { type: 'user', id: 'u1', text: '一' },
      { type: 'tool-use', id: 't1', name: 'Bash', target: 'ls', input: '' },
      { type: 'tool-use', id: 't2', name: 'Bash', target: 'pwd', input: '' },
    ]);
    const before = chat.chat().items;
    const copy = [...before];
    chat.send([{ type: 'tool-result', id: 't1', isError: false, output: 'ok' }]);
    const after = chat.chat().items;
    expect(after).not.toBe(before);
    expect(before).toEqual(copy);
    expect(before.every((item, i) => item === copy[i])).toBe(true);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]).toMatchObject({ status: 'done', output: 'ok' });
    expect(after[2]).toBe(before[2]);
    // ターンの終わりで、結果の来なかったツールだけを中断にする
    chat.send([{ type: 'turn-end' }]);
    const ended = chat.chat().items;
    expect(ended[1]).toBe(after[1]);
    expect(ended[2]).toMatchObject({ status: 'error' });
  });

  it('書いている途中の文が外れた配信では、同じ配信で出た本文に印を付ける。前の配信の本文には付けない', () => {
    const chat = receiver();
    chat.send([{ type: 'assistant-text', id: 'a1', text: '前' }]);
    chat.send([], [{ id: 'p1', kind: 'text', text: '途' }]);
    chat.send([{ type: 'tool-use', id: 't1', name: 'Bash', target: '', input: '' }, { type: 'assistant-text', id: 'a2', text: '後' }], []);
    const items = chat.chat().items;
    expect(items.map((i) => ('settled' in i ? i.settled : undefined))).toEqual([undefined, undefined, true]);
    // 印を付けたあとも、続く配信が同じ行を探せる
    chat.send([{ type: 'tool-result', id: 't1', isError: false }]);
    expect(chat.chat().items[1]).toMatchObject({ status: 'done' });
  });
});
