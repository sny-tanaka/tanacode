import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptFollower } from '../src/main/transcript-follower';

// /clear などで Claude Code が新しい会話ログに書き始めたときに、乗り換えて読み続ける（TranscriptFollower）。
// 手がかりは statusLine の transcript_path（offer）と、Remote Control のブリッジ ID（bridge-session の行）。
// bridge-session の行は、Claude Code の会話ログから取った控えに無いので、src の読み取り（type と bridgeSessionId）に合わせて組み立てた

type Row = { uuid?: string; parentUuid?: string | null; type: string; bridgeSessionId?: string };
const line = (r: Row) => `${JSON.stringify({ parentUuid: null, ...r })}\n`;

let dir: string;
let follower: TranscriptFollower | null = null;
let seen: { uuid: string | undefined; isHistory: boolean }[];
let switches: string[];
let historyLoaded: number;

function follow(file: string, startedAt?: number): TranscriptFollower {
  follower = new TranscriptFollower(
    file,
    {
      onEntry: (entry, isHistory) => seen.push({ uuid: (entry as Row).uuid, isHistory }),
      onHistoryLoaded: () => historyLoaded++,
      onSwitch: (next) => switches.push(next),
    },
    startedAt,
  );
  follower.start();
  return follower;
}
const uuids = () => seen.map((s) => s.uuid);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-follower-'));
  seen = [];
  switches = [];
  historyLoaded = 0;
});

afterEach(() => {
  follower?.stop();
  follower = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('TranscriptFollower', () => {
  it('はじめの会話ログを読み、前からあった行は過去のものとして渡して、読み終えたら知らせる', async () => {
    const first = join(dir, 's1.jsonl');
    writeFileSync(first, line({ uuid: 'old', type: 'user' }));
    follow(first);
    await expect.poll(() => historyLoaded).toBe(1);
    appendFileSync(first, line({ uuid: 'new', parentUuid: 'old', type: 'assistant' } as Row));
    await expect.poll(uuids).toEqual(['old', 'new']);
    expect(seen).toEqual([
      { uuid: 'old', isHistory: true },
      { uuid: 'new', isHistory: false },
    ]);
  });

  it('statusLine が教えた会話ログが、同じフォルダで起動より後にできたものなら乗り換える', async () => {
    const first = join(dir, 's1.jsonl');
    writeFileSync(first, line({ uuid: 'a1', type: 'user' }));
    const f = follow(first, Date.now() - 1000);
    await expect.poll(uuids).toEqual(['a1']);
    const next = join(dir, 's2.jsonl');
    writeFileSync(next, line({ uuid: 'b1', type: 'user' }));
    await f.offer(next);
    expect(switches).toEqual([next]);
    // 乗り換えた先の行は今のもの。読み終えた知らせは、はじめの会話ログでだけ
    await expect.poll(uuids).toEqual(['a1', 'b1']);
    expect(seen[1]).toEqual({ uuid: 'b1', isHistory: true });
    // 別のフォルダにできた会話ログには乗り換えない
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'other', 's3.jsonl'), line({ uuid: 'c1', type: 'user' }));
    await f.offer(join(dir, 'other', 's3.jsonl'));
    expect(switches).toEqual([next]);
    // 前の会話ログに書き足されても、もう読まない
    appendFileSync(first, line({ uuid: 'a2', type: 'user' }));
    appendFileSync(next, line({ uuid: 'b2', type: 'user' }));
    await expect.poll(uuids).toEqual(['a1', 'b1', 'b2']);
    // 今のものをもう一度教えられても、乗り換え直さない
    await f.offer(next);
    expect(switches).toEqual([next]);
    expect(historyLoaded).toBe(1);
  });

  it('別のフォルダ・まだ無いファイル・起動より前からある会話ログ（--resume で開いた会話）には乗り換えない', async () => {
    const first = join(dir, 's1.jsonl');
    writeFileSync(first, line({ uuid: 'a1', type: 'user' }));
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 's2.jsonl'), line({ uuid: 'x', type: 'user' }));
    const older = join(dir, 'older.jsonl');
    writeFileSync(older, line({ uuid: 'o', type: 'user' }));
    // 起動は、どのファイルができたよりも後
    const f = follow(first, Date.now() + 60_000);
    await f.offer(join(other, 's2.jsonl'));
    await f.offer(join(dir, 'missing.jsonl'));
    await f.offer(older);
    await f.offer(first);
    expect(switches).toEqual([]);
    // 止めたあとは乗り換えない
    f.stop();
    const later = new TranscriptFollower(first, { onEntry: () => {}, onHistoryLoaded: () => {}, onSwitch: (n) => switches.push(n) }, 0);
    later.start();
    later.stop();
    await later.offer(older);
    expect(switches).toEqual([]);
  });

  it('Remote Control のブリッジ ID が同じ新しい会話ログができたら乗り換える。違う ID・壊れた行・jsonl でないファイルでは乗り換えない', async () => {
    const first = join(dir, 's1.jsonl');
    writeFileSync(first, line({ uuid: 'a1', type: 'user' }) + line({ type: 'bridge-session', bridgeSessionId: 'cse_old' }));
    follow(first, Date.now() - 1000);
    // --resume では過去のブリッジ ID も残っているので、最後に見たものを使う
    appendFileSync(first, line({ type: 'bridge-session', bridgeSessionId: 'cse_now' }));
    await expect.poll(() => seen.length).toBe(3);
    // 関係の無いファイル・違うブリッジの会話ログ・頭が壊れた会話ログ
    writeFileSync(join(dir, 'notes.txt'), line({ type: 'bridge-session', bridgeSessionId: 'cse_now' }));
    writeFileSync(join(dir, 'other.jsonl'), line({ type: 'bridge-session', bridgeSessionId: 'cse_old' }));
    writeFileSync(join(dir, 'broken.jsonl'), '{書きかけ\n');
    await sleep(300);
    expect(switches).toEqual([]);
    const next = join(dir, 's2.jsonl');
    writeFileSync(next, line({ type: 'mode' }) + 'not json\n' + line({ type: 'bridge-session', bridgeSessionId: 'cse_now' }) + line({ uuid: 'b1', type: 'user' }));
    await expect.poll(() => switches).toEqual([next]);
    await expect.poll(uuids).toContain('b1');
    // 乗り換えたあと、前の会話ログの書き足しで乗り換え直さない（今の会話ログそのものの変更でも）
    appendFileSync(next, line({ uuid: 'b2', type: 'user' }));
    await expect.poll(uuids).toContain('b2');
    expect(switches).toEqual([next]);
    // 止めたら、フォルダの見張りもやめる
    const f = follower!;
    expect((f as unknown as { dirWatcher: unknown }).dirWatcher).not.toBeNull();
    f.stop();
    expect((f as unknown as { dirWatcher: unknown }).dirWatcher).toBeNull();
  });

  it('ブリッジ ID が同じでも、起動より前からある会話ログには乗り換えない', async () => {
    const first = join(dir, 's1.jsonl');
    writeFileSync(first, line({ uuid: 'a1', type: 'user' }) + line({ type: 'bridge-session', bridgeSessionId: 'cse_now' }));
    follow(first, Date.now() + 60_000);
    await expect.poll(() => seen.length).toBe(2);
    writeFileSync(join(dir, 's2.jsonl'), line({ type: 'bridge-session', bridgeSessionId: 'cse_now' }));
    await sleep(300);
    expect(switches).toEqual([]);
  });

  it('止めたら、ブリッジ ID の行が来てもフォルダを見張らない', async () => {
    const first = join(dir, 's1.jsonl');
    writeFileSync(first, line({ uuid: 'a1', type: 'user' }));
    const f = follow(first, 0);
    await expect.poll(uuids).toEqual(['a1']);
    f.stop();
    (f as unknown as { watchDir: () => void }).watchDir();
    expect((f as unknown as { dirWatcher: unknown }).dirWatcher).toBeNull();
    // ブリッジ ID が無い・空の bridge-session の行では見張らない
    const g = follow(join(dir, 's9.jsonl'), 0);
    appendFileSync(join(dir, 's9.jsonl'), line({ uuid: 'z', type: 'bridge-session', bridgeSessionId: '' }));
    await expect.poll(uuids).toContain('z');
    expect((g as unknown as { dirWatcher: unknown }).dirWatcher).toBeNull();
  });
});
