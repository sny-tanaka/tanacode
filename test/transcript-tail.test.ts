import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptTail } from '../src/main/transcript-tail';

// 会話ログの末尾読み（TranscriptTail）。親（parentUuid）の行より先に書かれた行を、親の後ろに並べ直す

type Row = { uuid: string; parentUuid: string | null; type: string };
const row = (uuid: string, parentUuid: string | null, type = 'assistant'): Row => ({ uuid, parentUuid, type });
const line = (r: Row) => `${JSON.stringify(r)}\n`;

let dir: string;
let file: string;
let tail: TranscriptTail | null = null;
let read: { uuid: string; isHistory: boolean }[];

function start(): void {
  tail = new TranscriptTail(file, (entry, isHistory) => read.push({ uuid: (entry as Row).uuid, isHistory }));
  tail.start();
}
const uuids = () => read.map((r) => r.uuid);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-tail-'));
  file = join(dir, 'session.jsonl');
  read = [];
});

afterEach(() => {
  tail?.stop();
  tail = null;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('TranscriptTail', () => {
  it('同じ読み込みの中なら、親の行を先に出す', async () => {
    start();
    appendFileSync(file, line(row('a1', 'u1')) + line(row('u1', null, 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'a1']));
  });

  // 新しい会話ログで、最初の応答の行（親は発言に続く最後の attachment の行）が発言の行より先に書かれ、
  // 別々の読み込みに分かれたとき。応答を先に出すと、あとから来た発言（親が null）を巻き戻しと取り違える
  it('親の行があとの読み込みで届いても、親を先に出し、子孫の行はその後ろに並べる', async () => {
    start();
    appendFileSync(file, line(row('a1', 'att2')) + line(row('a2', 'a1')));
    // 親が届くまでは出さない
    await new Promise((r) => setTimeout(r, 400));
    expect(uuids()).toEqual([]);
    appendFileSync(file, line(row('u1', null, 'user')) + line(row('att1', 'u1', 'attachment')) + line(row('att2', 'att1', 'attachment')));
    await vi.waitFor(() => expect(uuids()).toEqual(['u1', 'att1', 'att2', 'a1', 'a2']));
  });

  it('親の行が来ないままなら、しばらく待ってから書かれた順に出す', async () => {
    start();
    appendFileSync(file, line(row('a1', 'missing')) + line(row('a2', 'a1')));
    await vi.waitFor(() => expect(uuids()).toEqual(['a1', 'a2']), { timeout: 3000 });
  });

  it('親を待っている行と関係のない行は、待たずに出す', async () => {
    start();
    appendFileSync(file, line(row('s1', null, 'system')));
    await vi.waitFor(() => expect(uuids()).toEqual(['s1']));
    appendFileSync(file, line(row('a1', 'u1')) + line(row('s2', 's1', 'system')));
    await vi.waitFor(() => expect(uuids()).toEqual(['s1', 's2']));
    appendFileSync(file, line(row('u1', 's2', 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['s1', 's2', 'u1', 'a1']));
  });

  // 再開したセッションの過去ログは、読み始めた時点で全部そろっているので待たない
  it('追跡を始めた時点で既にあった行は、親が無くても待たずに出す', async () => {
    writeFileSync(file, line(row('a1', 'old')) + line(row('a2', 'a1')));
    start();
    await vi.waitFor(() =>
      expect(read).toEqual([
        { uuid: 'a1', isHistory: true },
        { uuid: 'a2', isHistory: true },
      ]),
    );
    // 過去ログの行を親にする新しい行も、待たない
    appendFileSync(file, line(row('u1', 'a2', 'user')));
    await vi.waitFor(() => expect(uuids()).toEqual(['a1', 'a2', 'u1']));
  });
});
