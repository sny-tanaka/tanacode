import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IpcChannel, type IpcChannelName, type IpcEvent, type IpcInvoke, type IpcSend } from '@shared/ipc';

// 画面（preload）と main の間の配線。引数・戻り値・知らせの中身は、shared/ipc.ts の表（IpcInvoke・IpcSend・IpcEvent）で
// preload と main の両方に型を付けて、型チェック（npm run typecheck）で守る。ここでは、型では分からないもの
// （受け口・送り手があるか、二重に登録していないか、使っていないチャンネルが無いか）を確かめる。
// 受け口が無いと、画面の操作が「No handler registered」で失敗する。送り手が無い知らせは、画面がいつまでも待つ。
// main の配線はほかのテストや Storybook を通らないので、ここで確かめる

// チャンネルの表に入っていないもの・2 つの表に入っているものがあれば、型チェックで止まる
type Typed = keyof IpcInvoke | keyof IpcSend | keyof IpcEvent;
const untyped: [Exclude<IpcChannelName, Typed>] extends [never] ? true : Exclude<IpcChannelName, Typed> = true;
type Overlap = Extract<keyof IpcInvoke, keyof IpcSend> | Extract<keyof IpcInvoke, keyof IpcEvent> | Extract<keyof IpcSend, keyof IpcEvent>;
const overlapping: [Overlap] extends [never] ? true : Overlap = true;

// コメントを除いたソース（コメントにしたコードを、配線と数えない。https:// の // は残す）
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const preload = code('src/preload/index.ts');
const main = readdirSync('src/main')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => code(join('src/main', f)))
  .join('\n');
const names = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((m) => m[1]);
const duplicates = (list: string[]) => [...new Set(list.filter((name, i) => list.indexOf(name) !== i))];

// preload: 呼び出し（invoke）・知らせ（send）・知らせを受ける（subscribe）
const invoked = names(preload, /\binvoke\(IpcChannel\.(\w+)/g);
const sent = names(preload, /\bsend\(IpcChannel\.(\w+)/g);
const subscribed = names(preload, /\bsubscribe\(IpcChannel\.(\w+)/g);
// main: 呼び出しの受け口（handle）・知らせの受け口（listen）。それ以外で出てくるチャンネルは、画面へ送る知らせ
// （send・notify のクリックの知らせ・アプリ内ブラウザの制御に渡すチャンネル）
const handled = names(main, /\bhandle\(\s*IpcChannel\.(\w+)/g);
const listened = names(main, /\blisten\(\s*IpcChannel\.(\w+)/g);
const registered = new Set([...handled, ...listened]);
const emitted = new Set(names(main, /IpcChannel\.(\w+)/g).filter((name) => !registered.has(name)));

describe('画面と main の配線', () => {
  it('どのチャンネルも、型の表のどれか 1 つにある（型チェックで止める）', () => {
    expect(untyped).toBe(true);
    expect(overlapping).toBe(true);
  });

  it('チャンネルの名前（値）は重ならない', () => {
    expect(duplicates(Object.values(IpcChannel))).toEqual([]);
  });

  it('preload が読み取れる', () => {
    // 書き方が変わって、ここの読み取りが空振りしていないか
    expect(invoked.length).toBeGreaterThan(50);
    expect(sent.length).toBeGreaterThan(5);
    expect(subscribed.length).toBeGreaterThan(20);
  });

  it('どのチャンネルも、preload でちょうど 1 回使う（2 つのメソッドが同じチャンネルを使わない・使っていないチャンネルが無い）', () => {
    const used = [...invoked, ...sent, ...subscribed];
    expect(duplicates(used)).toEqual([]);
    expect(Object.keys(IpcChannel).filter((name) => !used.includes(name))).toEqual([]);
  });

  it('preload が invoke するチャンネルには、main の受け口（handle）がちょうど 1 つある。受け口だけのものも無い', () => {
    expect(invoked.filter((name) => !handled.includes(name))).toEqual([]);
    // 同じチャンネルを 2 回 handle すると、起動時に例外で止まる
    expect(duplicates(handled)).toEqual([]);
    expect(handled.filter((name) => !invoked.includes(name))).toEqual([]);
  });

  it('preload が send するチャンネルには、main の受け口（listen）がちょうど 1 つある。受け口だけのものも無い', () => {
    expect(sent.filter((name) => !listened.includes(name))).toEqual([]);
    expect(duplicates(listened)).toEqual([]);
    expect(listened.filter((name) => !sent.includes(name))).toEqual([]);
  });

  it('画面が受ける知らせは、main がどこかで送る。main が送る知らせは、画面が受ける', () => {
    expect(subscribed.filter((name) => !emitted.has(name))).toEqual([]);
    expect([...emitted].filter((name) => !subscribed.includes(name))).toEqual([]);
  });
});
