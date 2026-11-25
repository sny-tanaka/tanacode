import { describe, expect, it } from 'vitest';
import { REMOTE_CHANNELS, type RemoteChannel } from '@shared/remote-channels';
import { arity, invokes, sends } from './helpers/ipc-tables';

// 遠隔（スマホ）から届いた頼みの扱いと引数の形の表（src/shared/remote-channels.ts）が、
// src/shared/ipc.ts の表と食い違っていないか。表の漏れは型チェックで止まるので、ここでは引数の数と、扱いの理由を見る
describe('遠隔の頼みの表', () => {
  const entries = [...invokes, ...sends];

  it('画面 → main の呼び出しと知らせが、どれも表にちょうど 1 つずつある', () => {
    expect(Object.keys(REMOTE_CHANNELS).sort()).toEqual(entries.map((e) => e.channel).sort());
  });

  it.each(entries)('$key の引数の数が、TanacodeApi の $method と同じ', ({ channel, method }) => {
    expect(REMOTE_CHANNELS[channel as RemoteChannel].args).toHaveLength(arity.get(method) ?? -1);
  });

  it('スマホから呼べないもの（replace・mac）には、理由が書いてある', () => {
    for (const [channel, spec] of Object.entries(REMOTE_CHANNELS)) {
      if (spec.use === 'same') expect(spec.reason, channel).toBeUndefined();
      else expect(spec.reason, channel).toMatch(/\S/);
    }
  });

  it('省略できる引数のあとに、省略できない引数が来ない', () => {
    for (const [channel, spec] of Object.entries(REMOTE_CHANNELS)) {
      const firstOptional = spec.args.findIndex((shape) => shape.endsWith('?'));
      if (firstOptional === -1) continue;
      expect(spec.args.slice(firstOptional).every((shape) => shape.endsWith('?')), channel).toBe(true);
    }
  });
});
