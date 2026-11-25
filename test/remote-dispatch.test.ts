import { describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { checkArgs, IpcDispatcher, RemoteCallError, type RemoteCaller } from '../src/main/remote-dispatch';

const caller: RemoteCaller = { kind: 'remote', profileId: 'default', clientId: 'c1' };

describe('checkArgs（遠隔から届いた引数の形）', () => {
  it('形が合えば、届いた数のまま返す', () => {
    expect(checkArgs(['string', 'number', 'boolean', 'strings'], ['a', 1, true, ['x']])).toEqual(['a', 1, true, ['x']]);
    expect(checkArgs(['string', 'string?'], ['a'])).toEqual(['a']);
  });

  it('省略できる引数の null は undefined にする（nullable のものは null のまま）', () => {
    expect(checkArgs(['string', 'object?'], ['a', null])).toEqual(['a', undefined]);
    expect(checkArgs(['nullable-string'], [null])).toEqual([null]);
    expect(checkArgs(['nullable-object?'], [null])).toEqual([null]);
  });

  it.each([
    [['string'], 'a', 'arguments must be an array'],
    [['string'], [], 'argument 1 is missing'],
    [['string'], ['a', 'b'], 'too many arguments (2 > 1)'],
    [['string'], [1], 'argument 1 must be string'],
    [['number'], [Number.NaN], 'argument 1 must be number'],
    [['strings'], [['a', 1]], 'argument 1 must be strings'],
    [['object'], [[1]], 'argument 1 must be object'],
    [['object'], [null], 'argument 1 must be object'],
    [['array'], [{}], 'argument 1 must be array'],
    [['bytes'], [[1, 2]], 'argument 1 must be bytes'],
  ] as const)('形が違えば断る: %j に %j', (shapes, args, reason) => {
    expect(checkArgs(shapes, args)).toBe(reason);
  });

  it('プロトタイプを書き換えうるキーを、どの深さでも断る', () => {
    expect(checkArgs(['object'], [JSON.parse('{"__proto__":{"polluted":true}}')])).toBe('argument 1: forbidden key __proto__');
    expect(checkArgs(['object'], [{ a: [{ constructor: 1 }] }])).toBe('argument 1: forbidden key constructor');
  });

  it('深すぎる入れ子と、多すぎる要素を断る', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { a: deep };
    expect(checkArgs(['object'], [deep])).toBe('argument 1: too deep');
    expect(checkArgs(['array'], [Array.from({ length: 10001 }, () => 0)])).toBe('argument 1: too many entries');
  });

  it('ふつうのオブジェクトでないもの（Date など）を断る', () => {
    expect(checkArgs(['object'], [new Date()])).toBe('argument 1: not a plain object');
  });
});

describe('IpcDispatcher（遠隔の接続から、Mac の画面と同じ受け口を呼ぶ）', () => {
  it('扱いが same のチャンネルは、確かめた引数と呼び出し元を受け口に渡し、返事をそのまま返す', async () => {
    const dispatcher = new IpcDispatcher();
    const listener = vi.fn((_caller: unknown, ...args: unknown[]) => ({ args }));
    dispatcher.register(IpcChannel.SessionsRename, listener);
    await expect(dispatcher.fromRemote(caller, IpcChannel.SessionsRename, ['s1', '名前'])).resolves.toEqual({ args: ['s1', '名前'] });
    expect(listener).toHaveBeenCalledWith(caller, 's1', '名前');
  });

  it('Mac にしか無いもの（replace）と Mac の設定（mac）は、受け口を呼ばずに断る', async () => {
    const dispatcher = new IpcDispatcher();
    const listener = vi.fn();
    dispatcher.register(IpcChannel.FolderPick, listener);
    dispatcher.register(IpcChannel.McpEnabledSet, listener);
    await expect(dispatcher.fromRemote(caller, IpcChannel.FolderPick, [])).rejects.toBeInstanceOf(RemoteCallError);
    await expect(dispatcher.fromRemote(caller, IpcChannel.McpEnabledSet, ['browser', false])).rejects.toBeInstanceOf(RemoteCallError);
    expect(listener).not.toHaveBeenCalled();
  });

  it('表に無いチャンネル・受け口の無いチャンネル・プロトタイプの名前は断る', async () => {
    const dispatcher = new IpcDispatcher();
    await expect(dispatcher.fromRemote(caller, 'nope:channel', [])).rejects.toBeInstanceOf(RemoteCallError);
    await expect(dispatcher.fromRemote(caller, IpcChannel.SessionsList, [])).rejects.toBeInstanceOf(RemoteCallError);
    await expect(dispatcher.fromRemote(caller, 'toString', [])).rejects.toBeInstanceOf(RemoteCallError);
  });

  it('引数の形が違えば、受け口を呼ばずに断る', async () => {
    const dispatcher = new IpcDispatcher();
    const listener = vi.fn();
    dispatcher.register(IpcChannel.SessionsRename, listener);
    await expect(dispatcher.fromRemote(caller, IpcChannel.SessionsRename, ['s1', 2])).rejects.toThrow(/argument 2 must be string/);
    expect(listener).not.toHaveBeenCalled();
  });

  it('同じチャンネルを 2 回登録すると止まる', () => {
    const dispatcher = new IpcDispatcher();
    dispatcher.register(IpcChannel.SessionsList, vi.fn());
    expect(() => dispatcher.register(IpcChannel.SessionsList, vi.fn())).toThrow();
  });
});
