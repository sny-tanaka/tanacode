import type { WebContents } from 'electron';
import { REMOTE_CHANNELS, type ArgShape, type RemoteChannel } from '../shared/remote-channels';
import { t } from '../shared/i18n';

// 画面 → main の頼みの呼び出し元（Issue #464）。
// app: アプリの画面（主ウインドウと、足したプロファイルの画面）。ipcMain から届き、fromApp で確かめたもの
// remote: 遠隔の接続（スマホ）。遠隔サーバーで本人確認を通ったもの。profileId: その接続のプロファイル / clientId: 接続の id
export type Caller = { kind: 'app'; contents: WebContents } | { kind: 'remote'; profileId: string; clientId: string };
export type RemoteCaller = Extract<Caller, { kind: 'remote' }>;

type Listener = (caller: Caller, ...args: unknown[]) => unknown;

// 遠隔から届いた頼みを断ったときの例外（遠隔の相手に返す）
export class RemoteCallError extends Error {
  override name = 'RemoteCallError';
}

// オブジェクトの深さ・キーの数の上限。ふつうの頼みは、どれもこれより小さい
const MAX_DEPTH = 16;
const MAX_KEYS = 10000;
// プロトタイプを書き換えうるキー（Object.assign などで __proto__ が効くのを避ける）
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// 値がふつうのデータか（オブジェクト・配列の入れ子の深さ・キーの数・危ないキー）。違えば理由を返す
function plainDataProblem(value: unknown): string | null {
  let keys = 0;
  const walk = (v: unknown, depth: number): string | null => {
    if (v === null || typeof v !== 'object') return null;
    if (v instanceof Uint8Array) return null;
    if (depth > MAX_DEPTH) return 'too deep';
    if (Array.isArray(v)) {
      keys += v.length;
      if (keys > MAX_KEYS) return 'too many entries';
      for (const item of v) {
        const problem = walk(item, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return 'not a plain object';
    for (const key of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(key)) return `forbidden key ${key}`;
      keys += 1;
      if (keys > MAX_KEYS) return 'too many entries';
      const problem = walk((v as Record<string, unknown>)[key], depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  return walk(value, 0);
}

function matches(base: string, value: unknown): boolean {
  switch (base) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'strings':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
    case 'array':
      return Array.isArray(value);
    case 'bytes':
      return value instanceof Uint8Array;
    case 'nullable-string':
      return value === null || typeof value === 'string';
    case 'nullable-object':
      return value === null || (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array));
    default:
      return false;
  }
}

// 引数を、表の形と照らし合わせる。合えば受け口に渡す引数（省略できる引数の null は undefined にする）、合わなければ理由
export function checkArgs(shapes: readonly ArgShape[], args: unknown): unknown[] | string {
  if (!Array.isArray(args)) return 'arguments must be an array';
  if (args.length > shapes.length) return `too many arguments (${args.length} > ${shapes.length})`;
  const checked: unknown[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i];
    const optional = shape.endsWith('?');
    const base = optional ? shape.slice(0, -1) : shape;
    let value = args[i];
    if (optional && value === null && !base.startsWith('nullable-')) value = undefined;
    if (value === undefined) {
      if (!optional) return `argument ${i + 1} is missing`;
      checked.push(undefined);
      continue;
    }
    if (!matches(base, value)) return `argument ${i + 1} must be ${base}`;
    const problem = plainDataProblem(value);
    if (problem) return `argument ${i + 1}: ${problem}`;
    checked.push(value);
  }
  // 省略された末尾の引数は渡さない（Mac の画面からの頼みと同じ数にする）
  return checked.slice(0, args.length);
}

// 画面 → main の受け口の一覧。index.ts の handle・listen が、ipcMain に登録するのと同時にここにも登録する。
// 遠隔の接続は fromRemote で、Mac の画面と同じ受け口を呼ぶ
export class IpcDispatcher {
  private readonly listeners = new Map<string, Listener>();

  register(channel: RemoteChannel, listener: Listener): void {
    if (this.listeners.has(channel)) throw new Error(`the listener for ${channel} is already registered`);
    this.listeners.set(channel, listener);
  }

  // 遠隔の接続から届いた頼みを、表の扱いと引数の形を確かめてから受け口に渡す。断るときは RemoteCallError を投げる
  async fromRemote(caller: RemoteCaller, channel: string, args: unknown): Promise<unknown> {
    const spec = Object.hasOwn(REMOTE_CHANNELS, channel) ? REMOTE_CHANNELS[channel as RemoteChannel] : undefined;
    const listener = this.listeners.get(channel);
    if (!spec || !listener) throw new RemoteCallError(t('main.error.remoteUnknownChannel', { channel }));
    if (spec.use !== 'same') throw new RemoteCallError(t('main.error.remoteNotAvailable', { channel }));
    const checked = checkArgs(spec.args, args);
    if (typeof checked === 'string') throw new RemoteCallError(t('main.error.remoteBadArguments', { channel, reason: checked }));
    return listener(caller, ...checked);
  }

  // 登録した受け口のチャンネル（テストで、表と食い違いが無いかを見る）
  channels(): string[] {
    return [...this.listeners.keys()];
  }
}
