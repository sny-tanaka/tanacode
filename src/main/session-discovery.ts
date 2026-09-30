import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { transcriptTitle, type TranscriptEntry } from '@shared/chat';
import type { DiscoveredSession } from '@shared/ipc';

const MAX_SESSIONS = 200;
// 先頭（cwd と最初の発言）と末尾（最新のタイトル）だけ読む
const CHUNK_BYTES = 64 * 1024;

// アプリの外（ターミナルの claude など）で作られた会話を ~/.claude/projects から探す。新しい順
export async function discoverSessions(known: ReadonlySet<string>): Promise<DiscoveredSession[]> {
  const root = join(homedir(), '.claude', 'projects');
  const files: { file: string; mtime: number }[] = [];
  for (const dir of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, dir)).catch(() => [] as string[])) {
      if (!name.endsWith('.jsonl') || known.has(basename(name, '.jsonl'))) continue;
      const file = join(root, dir, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile() && info.size > 0) files.push({ file, mtime: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const found: DiscoveredSession[] = [];
  for (const { file, mtime } of files) {
    if (found.length >= MAX_SESSIONS) break;
    const session = await summarize(file, mtime);
    if (session) found.push(session);
  }
  return found;
}

async function summarize(file: string, mtime: number): Promise<DiscoveredSession | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const head = await readLines(handle, 0, Math.min(size, CHUNK_BYTES));
    const tail = size > CHUNK_BYTES ? await readLines(handle, Math.max(0, size - CHUNK_BYTES), CHUNK_BYTES) : [];
    let cwd: string | null = null;
    let best: { title: string; priority: number } | null = null;
    for (const entry of [...head, ...tail]) {
      const e = entry as TranscriptEntry & { cwd?: string };
      cwd ??= typeof e.cwd === 'string' ? e.cwd : null;
      const title = transcriptTitle(e);
      // 最初の発言は最初のもの、custom / ai タイトルは最新のものを使う
      if (title && (!best || title.priority > best.priority || (title.priority === best.priority && title.priority > 1))) best = title;
    }
    // 発言の無い会話（起動しただけ）は再開できないので出さない
    if (!cwd || !best) return null;
    return { claudeSessionId: basename(file, '.jsonl'), cwd, title: best.title, updatedAt: mtime };
  } finally {
    await handle.close();
  }
}

async function readLines(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<unknown[]> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
  // 途中から読んだ最初の行と、書きかけの最後の行は捨てる
  if (position > 0) lines.shift();
  lines.pop();
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out;
}
