import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, type IpcChannelName, type TanacodeApi } from '@shared/ipc';

// preload（window.tanacode）の契約。electron の ipcRenderer・contextBridge・webUtils を作り物に差し替えて、preload を本当に読み込み、
// どのメソッドが、どのチャンネルを、どの引数で呼ぶか・知らせの受け手が、どのチャンネルを購読し、どう解除するかを確かめる。
// 正しい組み合わせは、src/shared/ipc.ts の表（IpcInvoke・IpcSend・IpcEvent。main の受け口も同じ表で型を付ける）から読む。
// 型チェックと test/ipc-wiring.test.ts（ソースの文字を読む）では、同じ型どうしの入れ替え（open と unarchive のチャンネル、
// mergeBase と relPath の順番など）・省略できる引数の渡し忘れ・受け手に渡す中身の取り違えは止まらないので、ここで動かして止める

const electron = vi.hoisted(() => ({
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));
vi.mock('electron', () => electron);

await import('../src/preload/index');
// 読み込んだときに渡した API（このあと beforeEach で呼び出しの控えを消すので、先に取っておく）
const exposed = electron.contextBridge.exposeInMainWorld.mock.calls.map((call) => [...call]);
const api = exposed[0]?.[1] as TanacodeApi;
const callsAtLoad = {
  invoke: electron.ipcRenderer.invoke.mock.calls.length,
  send: electron.ipcRenderer.send.mock.calls.length,
  on: electron.ipcRenderer.on.mock.calls.length,
};

type Method = (...args: unknown[]) => unknown;
const methodOf = (path: string): Method => {
  const [ns, name] = path.split('.');
  return (api as unknown as Record<string, Record<string, Method>>)[ns][name];
};

// --- src/shared/ipc.ts の表を読む ---
const ipcSource = readFileSync('src/shared/ipc.ts', 'utf8');
const block = (head: string) => {
  const start = ipcSource.indexOf(head);
  if (start === -1) throw new Error(`${head} が見つかりません`);
  return ipcSource.slice(start, ipcSource.indexOf('\n};', start));
};
type Entry = { key: keyof typeof IpcChannel; channel: IpcChannelName; method: string };
const entries = (head: string): Entry[] =>
  [...block(head).matchAll(/\[IpcChannel\.(\w+)\]: (?:Payload<)?Api\['(\w+)'\]\['(\w+)'\]/g)].map((m) => {
    const key = m[1] as keyof typeof IpcChannel;
    return { key, channel: IpcChannel[key], method: `${m[2]}.${m[3]}` };
  });
// 中身の無い知らせ（表では undefined）。受けるメソッドは表から分からないので、ここに書く。
// 増えたら、下の「中身の無い知らせ」のテストが落ちるので、ここに足す
const EMPTY_EVENTS: Record<string, string> = {
  SessionsNew: 'sessions.onNew',
  BrowserHostsOpen: 'browser.onHostsOpen',
};
const emptyEventKeys = [...block('export type IpcEvent = {').matchAll(/\[IpcChannel\.(\w+)\]: undefined;/g)].map((m) => m[1]);
const invokes = entries('export type IpcInvoke = {');
const sends = entries('export type IpcSend = {');
const events: (Entry & { empty: boolean })[] = [
  ...entries('export type IpcEvent = {').map((e) => ({ ...e, empty: false })),
  ...emptyEventKeys.map((key) => ({
    key: key as keyof typeof IpcChannel,
    channel: IpcChannel[key as keyof typeof IpcChannel],
    method: EMPTY_EVENTS[key] ?? `（${key} を受けるメソッドを EMPTY_EVENTS に足す）`,
    empty: true,
  })),
];

// TanacodeApi の、メソッドごとの引数の数（型の宣言から数える。省略できる引数も数える）
const arity = new Map<string, number>();
{
  let ns = '';
  for (const line of block('export type TanacodeApi = {').split('\n')) {
    const space = line.match(/^ {2}(\w+): \{/);
    if (space) ns = space[1];
    const method = line.match(/^ {4}(\w+)\((.*)\): /);
    if (!method) continue;
    let depth = 0;
    let count = method[2].trim() === '' ? 0 : 1;
    for (const ch of method[2]) {
      if ('(<[{'.includes(ch)) depth++;
      else if (')>]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) count++;
    }
    arity.set(`${ns}.${method[1]}`, count);
  }
}

// 見分けのつく引数（どの引数がどこへ渡ったか分かるように）。どのメソッドより多く渡し、余分に渡したものが届かないことも確かめる
const ARGS = ['引数1', '引数2', '引数3', '引数4', '引数5', '引数6'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('preload の読み込み', () => {
  it('window.tanacode として、API をちょうど 1 つ渡す。読み込んだだけでは、IPC を呼ばない・購読しない', () => {
    expect(exposed).toHaveLength(1);
    expect(exposed[0][0]).toBe('tanacode');
    expect(typeof api.sessions.list).toBe('function');
    expect(callsAtLoad).toEqual({ invoke: 0, send: 0, on: 0 });
  });

  it('表と API の型の読み取りが空振りしていない', () => {
    expect(invokes.length).toBeGreaterThan(50);
    expect(sends.length).toBeGreaterThan(5);
    expect(events.length).toBeGreaterThan(20);
    expect(arity.size).toBeGreaterThan(100);
    expect(arity.get('scheduled.add')).toBe(4);
    expect(arity.get('sessions.archive')).toBe(2);
    expect(arity.get('sessions.list')).toBe(0);
  });

  it('API のメソッドは、どれも表のどれか 1 つのチャンネルに対応する（pathForFile を除く）。表のメソッドは、どれも API にある', () => {
    const inApi = Object.entries(api as unknown as Record<string, unknown>).flatMap(([ns, value]) =>
      typeof value === 'function' ? [ns] : Object.keys(value as object).map((name) => `${ns}.${name}`),
    );
    const inTable = [...invokes, ...sends, ...events].map((e) => e.method);
    expect([...inApi].sort()).toEqual([...inTable, 'pathForFile'].sort());
    // 型の宣言にあるメソッドと、実際の API が同じ
    expect([...arity.keys()].sort()).toEqual(inApi.filter((m) => m !== 'pathForFile').sort());
  });

  it('中身の無い知らせ（表で undefined）は、受けるメソッドが分かっているものだけ', () => {
    expect(emptyEventKeys.sort()).toEqual(Object.keys(EMPTY_EVENTS).sort());
  });
});

describe('呼び出し（invoke）', () => {
  it.each(invokes)('$method は invoke で $channel を呼び、引数をそのままの順で渡して、返事をそのまま返す', ({ method, channel }) => {
    const reply = Promise.resolve(`${channel} の返事`);
    electron.ipcRenderer.invoke.mockReturnValueOnce(reply);
    const n = arity.get(method);
    expect(n).toBeDefined();
    const result = methodOf(method)(...ARGS);
    expect(result).toBe(reply);
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([[channel, ...ARGS.slice(0, n)]]);
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled();
    expect(electron.ipcRenderer.on).not.toHaveBeenCalled();
  });

  it('省略できる引数を省くと、省いたまま渡す（undefined を詰めない）', () => {
    void api.sessions.archive('s1');
    void api.settingsFiles.add('/p/settings.json');
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [IpcChannel.SessionsArchive, 's1', undefined],
      [IpcChannel.SettingsFilesAdd, '/p/settings.json', undefined],
    ]);
  });
});

describe('知らせ（send）', () => {
  it.each(sends)('$method は send で $channel を送り、引数をそのままの順で渡す。返事は待たない', ({ method, channel }) => {
    const n = arity.get(method);
    expect(n).toBeDefined();
    const result = methodOf(method)(...ARGS);
    expect(result).toBeUndefined();
    expect(electron.ipcRenderer.send.mock.calls).toEqual([[channel, ...ARGS.slice(0, n)]]);
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('セッションの選択を外す（focus(null)）ときも、null をそのまま送る', () => {
    api.sessions.focus(null);
    api.browser.activate('s1', null);
    expect(electron.ipcRenderer.send.mock.calls).toEqual([
      [IpcChannel.SessionsFocus, null],
      [IpcChannel.BrowserActivate, 's1', null],
    ]);
  });
});

describe('知らせを受ける（subscribe）', () => {
  it.each(events)('$method は $channel を購読し、中身だけを受け手に渡す。返した関数で、同じ受け口を解除する', ({ method, channel, empty }) => {
    const listener = vi.fn();
    const unsubscribe = methodOf(method)(listener) as () => void;
    expect(electron.ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [onChannel, wrapped] = electron.ipcRenderer.on.mock.calls[0] as [string, (...args: unknown[]) => void];
    expect(onChannel).toBe(channel);
    expect(listener).not.toHaveBeenCalled();

    // Electron は (event, 中身) で呼ぶ。受け手には event を渡さない
    const payload = { from: channel };
    wrapped({ sender: 'イベント' }, payload);
    expect(listener.mock.calls).toEqual(empty ? [[]] : [[payload]]);

    expect(electron.ipcRenderer.off).not.toHaveBeenCalled();
    expect(unsubscribe()).toBeUndefined();
    expect(electron.ipcRenderer.off.mock.calls).toEqual([[channel, wrapped]]);
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled();
  });

  it('同じ知らせを 2 か所で受けると、それぞれ別の受け口を付け、解除は自分の受け口だけ', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = api.sessions.onChanged(first);
    api.sessions.onChanged(second);
    const [[, wrappedFirst], [, wrappedSecond]] = electron.ipcRenderer.on.mock.calls as [string, (...args: unknown[]) => void][];
    expect(wrappedFirst).not.toBe(wrappedSecond);
    offFirst();
    expect(electron.ipcRenderer.off.mock.calls).toEqual([[IpcChannel.SessionsChanged, wrappedFirst]]);
    // 残ったほうは、届いた中身をそのまま受ける
    wrappedSecond({}, [{ id: 's1' }]);
    expect(second.mock.calls).toEqual([[[{ id: 's1' }]]]);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('ファイルのパス', () => {
  it('pathForFile は webUtils.getPathForFile にファイルを渡し、そのパスを返す（IPC は使わない）', () => {
    electron.webUtils.getPathForFile.mockReturnValueOnce('/Users/me/画像.png');
    const file = { name: '画像.png' } as unknown as File;
    expect(api.pathForFile(file)).toBe('/Users/me/画像.png');
    expect(electron.webUtils.getPathForFile.mock.calls).toEqual([[file]]);
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled();
  });
});
