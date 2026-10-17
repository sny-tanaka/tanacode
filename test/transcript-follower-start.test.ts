import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranscriptFollower } from '../src/main/transcript-follower';

// 会話ログを読み始めるときの大きさは、1 回だけ取る（TranscriptFollower）。読み始め（TranscriptTail）と、読み終えたかを
// 決める所で別々に取ると、その間に Claude Code が書いた行で食い違い、読み終えた知らせが出ないことがある。
// その間に書かれたことを作るため、statSync が返す大きさを、ファイルごとに決めた順に差し替える

const sizes = new Map<string, number[]>();
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const statSync = (path: string) => {
    const stat = fs.statSync(path);
    const next = sizes.get(path)?.shift();
    return next === undefined ? stat : { ...stat, size: next };
  };
  return { ...fs, default: { ...fs, statSync }, statSync };
});

let dir: string;
let follower: TranscriptFollower | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-follower-start-'));
  // 見回り（150 ミリ秒ごと）で読ませない。読み始めは、乗り換えのときの大きさだけで決まる
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => {
  follower?.stop();
  follower = null;
  sizes.clear();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

it('乗り換えた先が、読み始めたときに空なら、その直後に行が書かれても、読み終えたことにする', async () => {
  const first = join(dir, 's1.jsonl');
  writeFileSync(first, `${JSON.stringify({ uuid: 'a1', type: 'user' })}\n`);
  const next = join(dir, 's2.jsonl');
  writeFileSync(next, '');
  let loaded = 0;
  follower = new TranscriptFollower(first, { onEntry: () => {}, onHistoryLoaded: () => loaded++, onSwitch: () => {} }, 0);
  follower.start();
  // 読み始めたときは空（0）。そのすぐあとに、Claude Code が 1 行書いた（120）
  sizes.set(next, [0, 120]);
  await follower.offer(next);
  expect(loaded).toBe(1);
});
