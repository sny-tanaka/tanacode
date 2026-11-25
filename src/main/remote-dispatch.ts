import type { WebContents } from 'electron';
import { t } from '@shared/i18n';
import { REMOTE_CHANNELS, type ArgShape, type RemoteChannel } from '@shared/remote-channels';

// 画面 → main の頼みの呼び出し元（Issue #464）。
// app: アプリの画面（主ウインドウと、足したプロファイルの画面）。ipcMain から届き、fromApp で確かめたもの
// remote: 遠隔の接続（スマホ）。本人確認を通ったもの。profileId: その頼みのプロファイル（その接続に許したもの）/ clientId: 接続の id /
// registrationId: どの登録から入ったか（遠隔から入れた予約などに控え、登録を取り消すときに見せる）
export type Caller = { kind: 'app'; contents: WebContents } | { kind: 'remote'; profileId: string; clientId: string; registrationId: string };
export type RemoteCaller = Extract<Caller, { kind: 'remote' }>;

type Listener = (caller: Caller, ...args: unknown[]) => unknown;

// 遠隔から届いた頼みを断ったときの例外（遠隔の相手に返す）
export class RemoteCallError extends Error {
  override name = 'RemoteCallError';
}

// オブジェクトの深さ・キーの数の上限。ふつうの頼みは、どれもこれより小さい
const MAX_DEPTH = 16;
const MAX_KEYS = 10000;
// プロトタイプを書き換えうるキー（Object.assign などで __proto__ が効くのを避ける）。constructor・prototype は、
// 質問の答え（キーが質問の文）や MCP サーバーの項目名に入りうるので断らない（受け口は Object.entries で作り直している）
const FORBIDDEN_KEY = '__proto__';

// 値がふつうのデータか（オブジェクト・配列の入れ子の深さ・キーの数・危ないキー）。違えば理由（画面の言語の文）を返す
function plainDataProblem(value: unknown, index: number): string | null {
  let keys = 0;
  const walk = (v: unknown, depth: number): string | null => {
    if (v === null || typeof v !== 'object') return null;
    if (v instanceof Uint8Array) return null;
    if (depth > MAX_DEPTH) return t('main.error.remoteArg.tooDeep', { index });
    if (Array.isArray(v)) {
      keys += v.length;
      if (keys > MAX_KEYS) return t('main.error.remoteArg.tooManyEntries', { index });
      for (const item of v) {
        const problem = walk(item, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return t('main.error.remoteArg.notPlain', { index });
    for (const key of Object.keys(v)) {
      if (key === FORBIDDEN_KEY) return t('main.error.remoteArg.forbiddenKey', { index, key });
      keys += 1;
      if (keys > MAX_KEYS) return t('main.error.remoteArg.tooManyEntries', { index });
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

// { "$bytes": "<base64>" } を Uint8Array に戻す。ほかの値はそのまま
function bytesOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array) return value;
  const keys = Object.keys(value);
  const text = (value as Record<string, unknown>).$bytes;
  if (keys.length !== 1 || keys[0] !== '$bytes' || typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return value;
  return new Uint8Array(Buffer.from(text, 'base64'));
}

// 引数を、表の形と照らし合わせる。合えば受け口に渡す引数（省略できる引数の null は undefined にする）、合わなければ理由（画面の言語の文）
export function checkArgs(shapes: readonly ArgShape[], args: unknown): unknown[] | string {
  if (!Array.isArray(args)) return t('main.error.remoteArg.notArray');
  if (args.length > shapes.length) return t('main.error.remoteArg.tooMany', { count: args.length, max: shapes.length });
  const checked: unknown[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i];
    const optional = shape.endsWith('?');
    const base = optional ? shape.slice(0, -1) : shape;
    let value = args[i];
    if (optional && value === null && !base.startsWith('nullable-')) value = undefined;
    if (value === undefined) {
      if (!optional) return t('main.error.remoteArg.missing', { index: i + 1 });
      checked.push(undefined);
      continue;
    }
    // 遠隔の接続は Uint8Array を JSON で運ぶ（{ "$bytes": "<base64>" }）。形が bytes の位置でだけ戻す（ほかの位置の同じ形のオブジェクトは、そのまま）
    if (base === 'bytes') value = bytesOf(value);
    if (!matches(base, value)) return t('main.error.remoteArg.wrongType', { index: i + 1, shape: base });
    const problem = plainDataProblem(value, i + 1);
    if (problem) return problem;
    checked.push(value);
  }
  // 省略された末尾の引数は渡さない（Mac の画面からの頼みと同じ数にする）
  return checked.slice(0, args.length);
}

// 相手が決めた名前を、文や記録に入れられる形にする（制御文字を除き、80 文字まで）
function safeName(value: unknown): string {
  const text = typeof value === 'string' ? value : String(typeof value);
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').slice(0, 80);
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
  async fromRemote(caller: RemoteCaller, channel: unknown, args: unknown): Promise<unknown> {
    const name = typeof channel === 'string' ? channel : '';
    const spec = Object.hasOwn(REMOTE_CHANNELS, name) ? REMOTE_CHANNELS[name as RemoteChannel] : undefined;
    const listener = this.listeners.get(name);
    // 断る文に入れるチャンネルの名前は、相手が決めた文字列なので、制御文字を除いて短くする（記録にも書くため）
    const shown = safeName(channel);
    if (!spec || !listener) throw new RemoteCallError(t('main.error.remoteUnknownChannel', { channel: shown }));
    if (spec.use !== 'same') throw new RemoteCallError(t('main.error.remoteNotAvailable', { channel: shown }));
    const checked = checkArgs(spec.args, args);
    if (typeof checked === 'string') throw new RemoteCallError(t('main.error.remoteBadArguments', { channel: shown, reason: checked }));
    return listener(caller, ...checked);
  }

  // 登録した受け口のチャンネル（テストで、表と食い違いが無いかを見る）
  channels(): string[] {
    return [...this.listeners.keys()];
  }
}
