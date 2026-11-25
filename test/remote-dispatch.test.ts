import { describe, expect, it, vi } from 'vitest';
import { t } from '@shared/i18n';
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

  const wrong = (shape: string) => t('main.error.remoteArg.wrongType', { index: 1, shape });
  it.each([
    [['string'], 'a', t('main.error.remoteArg.notArray')],
    [['string'], [], t('main.error.remoteArg.missing', { index: 1 })],
    [['string'], ['a', 'b'], t('main.error.remoteArg.tooMany', { count: 2, max: 1 })],
    [['string'], [1], wrong('string')],
    [['number'], [Number.NaN], wrong('number')],
    [['strings'], [['a', 1]], wrong('strings')],
    [['object'], [[1]], wrong('object')],
    [['object'], [null], wrong('object')],
    [['array'], [{}], wrong('array')],
    [['bytes'], [[1, 2]], wrong('bytes')],
  ] as const)('形が違えば断る: %j に %j', (shapes, args, reason) => {
    expect(checkArgs(shapes, args)).toBe(reason);
  });

  it('__proto__ のキーを、どの深さでも断る', () => {
    const reason = t('main.error.remoteArg.forbiddenKey', { index: 1, key: '__proto__' });
    expect(checkArgs(['object'], [JSON.parse('{"__proto__":{"polluted":true}}')])).toBe(reason);
    expect(checkArgs(['object'], [{ a: [JSON.parse('{"__proto__":1}')] }])).toBe(reason);
  });

  it('constructor・prototype というキーは受ける（質問の文や MCP の項目名に入りうる）', () => {
    const answers = { constructor: 'はい', prototype: ['いいえ'] };
    expect(checkArgs(['object'], [answers])).toEqual([answers]);
  });

  it('深すぎる入れ子と、多すぎる要素を断る', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { a: deep };
    expect(checkArgs(['object'], [deep])).toBe(t('main.error.remoteArg.tooDeep', { index: 1 }));
    expect(checkArgs(['array'], [Array.from({ length: 10001 }, () => 0)])).toBe(t('main.error.remoteArg.tooManyEntries', { index: 1 }));
  });

  it('ふつうのオブジェクトでないもの（Date など）を断る', () => {
    expect(checkArgs(['object'], [new Date()])).toBe(t('main.error.remoteArg.notPlain', { index: 1 }));
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

  it('表に無いチャンネル・受け口の無いチャンネル・プロトタイプの名前・文字列でない名前は断る', async () => {
    const dispatcher = new IpcDispatcher();
    await expect(dispatcher.fromRemote(caller, 'nope:channel', [])).rejects.toBeInstanceOf(RemoteCallError);
    await expect(dispatcher.fromRemote(caller, 42, [])).rejects.toBeInstanceOf(RemoteCallError);
    await expect(dispatcher.fromRemote(caller, IpcChannel.SessionsList, [])).rejects.toBeInstanceOf(RemoteCallError);
    await expect(dispatcher.fromRemote(caller, 'toString', [])).rejects.toBeInstanceOf(RemoteCallError);
  });

  it('引数の形が違えば、受け口を呼ばずに断る', async () => {
    const dispatcher = new IpcDispatcher();
    const listener = vi.fn();
    dispatcher.register(IpcChannel.SessionsRename, listener);
    await expect(dispatcher.fromRemote(caller, IpcChannel.SessionsRename, ['s1', 2])).rejects.toThrow(t('main.error.remoteArg.wrongType', { index: 2, shape: 'string' }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('同じチャンネルを 2 回登録すると止まる', () => {
    const dispatcher = new IpcDispatcher();
    dispatcher.register(IpcChannel.SessionsList, vi.fn());
    expect(() => dispatcher.register(IpcChannel.SessionsList, vi.fn())).toThrow();
  });

  it('断る文に入れる名前は、制御文字を除いて 80 文字までにする', async () => {
    const dispatcher = new IpcDispatcher();
    const name = `a\u0000b\nc${'x'.repeat(100)}`;
    await expect(dispatcher.fromRemote(caller, name, [])).rejects.toThrow(t('main.error.remoteUnknownChannel', { channel: `abc${'x'.repeat(77)}` }));
  });
});
