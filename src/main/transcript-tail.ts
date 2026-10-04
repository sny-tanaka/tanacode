import { statSync, watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';

// 変更の通知（fs.watch）ですぐ読む。通知が来ないとき（ファイルがまだ無い・取りこぼし）に備えて、定期的にも見る
const POLL_MS = 150;
// 親の行がまだ届いていない行を待つ長さ。過ぎたら、親を待たずに書かれた順に出す
const HOLD_MS = 1000;

// isHistory: 追跡開始時点で既にファイルにあった行（再開したセッションの過去ログ）
export type EntryHandler = (entry: unknown, isHistory: boolean) => void;

type Held = { entry: unknown; isHistory: boolean; parent: string; since: number };

// 書き込み途中の行やマルチバイト文字の分断に備え、改行までをバイト列のまま溜めてから parse する。
// 最初の応答の行が発言の行より先に書かれ（parentFirst を参照）、発言の行があとの読み込みで届くこともあるので、
// 親（parentUuid）の行がまだ届いていない行は、親が届くまで（長くても HOLD_MS）出さずに待つ
export class TranscriptTail {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  // 読んでいる間に届いた変更の通知。読み終えたらもう一度読む
  private again = false;
  private watcher: FSWatcher | null = null;
  private historyBytes = 0;
  private historySignaled = false;
  // 出した行の uuid と、親を待っている行（届いた順）
  private readonly seen = new Set<string>();
  private held: Held[] = [];

  constructor(
    private readonly file: string,
    private readonly onEntry: EntryHandler,
    // 既存の行（再開したセッションの過去ログ）を読み終えたとき。既存の行が無ければ呼ばれない
    private readonly onHistoryLoaded?: () => void,
  ) {}

  start(): void {
    try {
      this.historyBytes = statSync(this.file).size;
    } catch {
      this.historyBytes = 0;
    }
    this.timer = setInterval(() => {
      this.watchFile();
      this.releaseExpired();
      void this.poll();
    }, POLL_MS);
    this.watchFile();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  // 新しいセッションでは、会話ログは最初の発言まで作られないので、できるまで試し続ける
  private watchFile(): void {
    if (this.watcher || !this.timer) return;
    try {
      this.watcher = watch(this.file, () => void this.poll());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    this.again = false;
    try {
      const size = await stat(this.file).then((s) => s.size, () => 0);
      if (size <= this.offset) return;
      const handle = await open(this.file, 'r');
      try {
        const chunk = Buffer.alloc(size - this.offset);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.offset);
        const chunkStart = this.offset;
        this.offset += bytesRead;
        if (this.timer) this.consume(chunk.subarray(0, bytesRead), chunkStart);
      } finally {
        await handle.close();
      }
    } catch {
      // stat のあとに会話ログが消された（セッションの削除など）・読めなかったときは、offset を進めずに次の機会に読み直す
    } finally {
      this.reading = false;
      if (this.again && this.timer) void this.poll();
    }
  }

  private consume(chunk: Buffer, chunkStart: number): void {
    let buffer = Buffer.concat([this.pending, chunk]);
    let bufferStart = chunkStart - this.pending.length;
    let newline: number;
    const read: { entry: unknown; isHistory: boolean }[] = [];
    while ((newline = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      const lineEnd = bufferStart + newline + 1;
      buffer = buffer.subarray(newline + 1);
      bufferStart = lineEnd;
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      read.push({ entry, isHistory: lineEnd <= this.historyBytes });
    }
    for (const { entry, isHistory } of parentFirst(read, (r) => r.entry)) this.accept(entry, isHistory);
    this.pending = buffer;
    if (!this.historySignaled && this.historyBytes > 0 && this.offset >= this.historyBytes) {
      this.historySignaled = true;
      this.onHistoryLoaded?.();
    }
  }

  // 追跡を始めた時点で既にあった行（過去ログ）は全部そろっているので待たない。親が届いていない行と、待っている行の子孫は待たせる
  private accept(entry: unknown, isHistory: boolean): void {
    const parent = parentUuidOf(entry);
    if (!isHistory && parent !== null && !this.seen.has(parent)) {
      this.held.push({ entry, isHistory, parent, since: Date.now() });
      return;
    }
    this.emit(entry, isHistory);
  }

  // 出した行を親にして待っていた行も、続けて出す
  private emit(entry: unknown, isHistory: boolean): void {
    this.onEntry(entry, isHistory);
    const uuid = uuidOf(entry);
    if (uuid === null) return;
    this.seen.add(uuid);
    const children = this.held.filter((h) => h.parent === uuid);
    if (children.length === 0) return;
    this.held = this.held.filter((h) => h.parent !== uuid);
    for (const child of children) this.emit(child.entry, child.isHistory);
  }

  // 親が来ないまま待ちすぎた行は、届いた順に出す（その子孫も続けて出る）
  private releaseExpired(): void {
    const now = Date.now();
    while (this.held.length > 0 && now - this.held[0].since >= HOLD_MS) {
      const [first] = this.held.splice(0, 1);
      this.emit(first.entry, first.isHistory);
    }
  }
}

function uuidOf(entry: unknown): string | null {
  const uuid = (entry as { uuid?: unknown } | null)?.uuid;
  return typeof uuid === 'string' ? uuid : null;
}

function parentUuidOf(entry: unknown): string | null {
  const parent = (entry as { parentUuid?: unknown } | null)?.parentUuid;
  return typeof parent === 'string' ? parent : null;
}

// Claude Code は新しい会話ログを作るとき、最初の応答の行を、発言の行（とそれに続く attachment の行）より先に書くことがある。
// 親（parentUuid）が同じまとまりの後ろにある行は、親を読んだすぐ後ろに回す（親の無い行・親がまとまりに無い行はそのまま）
export function parentFirst<T>(items: T[], entryOf: (item: T) => unknown): T[] {
  const uuidOf = (item: T) => {
    const uuid = (entryOf(item) as { uuid?: unknown } | null)?.uuid;
    return typeof uuid === 'string' ? uuid : null;
  };
  const parentOf = (item: T) => {
    const parent = (entryOf(item) as { parentUuid?: unknown } | null)?.parentUuid;
    return typeof parent === 'string' ? parent : null;
  };
  const uuids = new Set(items.map(uuidOf).filter((u) => u !== null));
  const done = new Set<string>();
  const waiting = new Map<string, T[]>();
  const out: T[] = [];
  const emit = (item: T) => {
    out.push(item);
    const uuid = uuidOf(item);
    if (uuid === null) return;
    done.add(uuid);
    const children = waiting.get(uuid);
    waiting.delete(uuid);
    children?.forEach(emit);
  };
  for (const item of items) {
    const parent = parentOf(item);
    if (parent !== null && uuids.has(parent) && !done.has(parent)) waiting.set(parent, [...(waiting.get(parent) ?? []), item]);
    else emit(item);
  }
  // 親が出てこなかったもの（同じ uuid の行が親より前にしか無いなど）は、最後にそのまま出す
  for (const children of waiting.values()) out.push(...children);
  return out;
}
