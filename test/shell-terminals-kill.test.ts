import { SerializeAddon } from '@xterm/addon-serialize';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellTerminals } from '../src/main/shell-terminals';

// 止めたシェル（kill したが、まだ終わっていない）の扱いと、画面への引き継ぎで描き直せないときの扱い。
// 本物のシェルでは「打った文字が届かない」「SIGKILL を送らない」を、待たずに確かめられないので、node-pty を偽物にする
// （打った文字・大きさ・送った知らせを控え、終わりはテストが起こす）。本物のシェルでの動きは test/shell-terminals.test.ts

const fake = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class FakePty {
    static all: FakePty[] = [];
    pid = 4000 + FakePty.all.length;
    process = 'zsh';
    written: string[] = [];
    resized: [number, number][] = [];
    // kill で送った知らせ（省いたものは undefined。node-pty は SIGHUP にする）
    signals: (string | undefined)[] = [];
    private exitListeners: Listener<{ exitCode: number }>[] = [];
    constructor() {
      FakePty.all.push(this);
    }
    onData() {
      return { dispose() {} };
    }
    onExit(listener: Listener<{ exitCode: number }>) {
      this.exitListeners.push(listener);
      return { dispose() {} };
    }
    write(data: string) {
      this.written.push(data);
    }
    resize(cols: number, rows: number) {
      this.resized.push([cols, rows]);
    }
    kill(signal?: string) {
      this.signals.push(signal);
    }
    // シェルが終わったことにする
    exit(exitCode = 0) {
      this.exitListeners.forEach((listener) => listener({ exitCode }));
    }
  }
  return { FakePty };
});
vi.mock('node-pty', () => ({ spawn: () => new fake.FakePty() }));

let shells: ShellTerminals;
// 時間をおいて動かすもの（強く止める待ち）。テストが流し、片付けた数を数える
let later: (() => void)[];
let cancelled: number;
let exits: Map<string, number>;

beforeEach(() => {
  fake.FakePty.all = [];
  later = [];
  cancelled = 0;
  exits = new Map();
  shells = new ShellTerminals({ onData: () => {}, onExit: (id, code) => exits.set(id, code) }, null, Date.now, (fn) => {
    later.push(fn);
    return () => cancelled++;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('止めたシェル', () => {
  it('止めたら（終わる前でも）、打った文字も大きさの変更も渡さない', () => {
    const { id } = shells.create('session-1', '/work', 80, 24);
    const pty = fake.FakePty.all[0];
    shells.write(id, 'ls\r');
    shells.resize(id, 100, 30);
    shells.kill(id);
    shells.write(id, 'rm -rf build\r');
    shells.resize(id, 120, 40);
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.resized).toEqual([[100, 30]]);
    expect(pty.signals).toEqual([undefined]);
  });

  it('待ちが過ぎても終わっていなければ SIGKILL で止める。終わっていれば送らず、待ちも片付ける', () => {
    const stubborn = shells.create('session-1', '/work', 80, 24);
    const quiet = shells.create('session-1', '/work', 80, 24);
    const [stubbornPty, quietPty] = fake.FakePty.all;
    shells.kill(stubborn.id);
    shells.kill(quiet.id);
    quietPty.exit(129);
    expect(cancelled).toBe(1);
    later.forEach((fn) => fn());
    expect(stubbornPty.signals).toEqual([undefined, 'SIGKILL']);
    expect(quietPty.signals).toEqual([undefined]);
    expect(exits.get(quiet.id)).toBe(129);
  });

  it('一覧のタブの番号は、止めている途中のシェルも数えたパネルの並びのまま（止めたものは出さない）', () => {
    const first = shells.create('session-1', '/work', 80, 24);
    const second = shells.create('session-1', '/work', 80, 24);
    shells.kill(first.id);
    expect(shells.list('session-1').map((t) => [t.id, t.tab])).toEqual([[second.id, 2]]);
    expect(shells.info(second.id)?.tab).toBe(2);
    expect(shells.info(first.id)).toBeNull();
    // 終わったら、パネルもタブを閉じるので、番号を詰める
    fake.FakePty.all[0].exit(129);
    expect(shells.info(second.id)?.tab).toBe(1);
  });
});

describe('引き継ぎ（attach）', () => {
  it('画面を描き直す文字列を作れなかったシェルは、止めて渡さない（見えないまま動かし続けない）。ほかのシェルは渡す', () => {
    const broken = shells.create('session-1', '/work', 80, 24);
    const kept = shells.create('session-1', '/work', 80, 24);
    shells.detach();
    vi.spyOn(SerializeAddon.prototype, 'serialize').mockImplementationOnce(() => {
      throw new Error('描き直せません');
    });
    expect(shells.attach().map((s) => s.id)).toEqual([kept.id]);
    expect(fake.FakePty.all[0].signals).toEqual([undefined]);
    expect(fake.FakePty.all[1].signals).toEqual([]);
    expect(shells.info(broken.id)).toBeNull();
  });
});
