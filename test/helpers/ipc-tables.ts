import { readFileSync } from 'node:fs';
import { IpcChannel, type IpcChannelName } from '@shared/ipc';

// src/shared/ipc.ts の表（IpcInvoke・IpcSend・IpcEvent）と、TanacodeApi の型の宣言を、ソースから読む。
// 画面と main の配線の正しい組み合わせ（どのメソッドが、どのチャンネルを、いくつの引数で使うか）として、
// preload（test/preload-api.test.ts）と main（test/main-ipc.test.ts）を動かして確かめるのに使う

const source = readFileSync('src/shared/ipc.ts', 'utf8');

function block(head: string): string {
  const start = source.indexOf(head);
  if (start === -1) throw new Error(`${head} が見つかりません`);
  return source.slice(start, source.indexOf('\n};', start));
}

export type IpcEntry = { key: keyof typeof IpcChannel; channel: IpcChannelName; method: string };

function entries(head: string): IpcEntry[] {
  return [...block(head).matchAll(/\[IpcChannel\.(\w+)\]: (?:Payload<)?Api\['(\w+)'\]\['(\w+)'\]/g)].map((m) => {
    const key = m[1] as keyof typeof IpcChannel;
    return { key, channel: IpcChannel[key], method: `${m[2]}.${m[3]}` };
  });
}

// 中身の無い知らせ（表では undefined）。受けるメソッドは表から分からないので、ここに書く。
// 増えたら、test/preload-api.test.ts の「中身の無い知らせ」のテストが落ちるので、ここに足す
export const EMPTY_EVENTS: Record<string, string> = {
  SessionsNew: 'sessions.onNew',
  BrowserHostsOpen: 'browser.onHostsOpen',
};
export const emptyEventKeys = [...block('export type IpcEvent = {').matchAll(/\[IpcChannel\.(\w+)\]: undefined;/g)].map((m) => m[1]);

// 画面 → main の呼び出し（invoke ↔ handle）
export const invokes = entries('export type IpcInvoke = {');
// 画面 → main の知らせ（send ↔ listen）
export const sends = entries('export type IpcSend = {');
// main → 画面の知らせ（send ↔ subscribe）。empty: 中身の無い知らせ
export const events: (IpcEntry & { empty: boolean })[] = [
  ...entries('export type IpcEvent = {').map((e) => ({ ...e, empty: false })),
  ...emptyEventKeys.map((name) => {
    const key = name as keyof typeof IpcChannel;
    return { key, channel: IpcChannel[key], method: EMPTY_EVENTS[name] ?? `（${name} を受けるメソッドを EMPTY_EVENTS に足す）`, empty: true };
  }),
];

// TanacodeApi の、メソッドごとの引数の数（型の宣言から数える。省略できる引数も数える）
export const arity = new Map<string, number>();
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
