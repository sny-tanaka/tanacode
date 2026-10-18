import { hash } from 'node:crypto';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';

// 変更の通知（fs.watch）ですぐ読む。通知が来ないとき（ファイルがまだ無い・取りこぼし）に備えて、定期的にも見る
const POLL_MS = 150;
// 親の行がまだ届いていない行を待つ長さ。過ぎたら、親を待たずに書かれた順に出す
const HOLD_MS = 1000;
// 読み終えたところの手前を、この長さだけ控えておく。次に読むときに照らして、会話ログが書き直されていないかを見る
const CHECK_BYTES = 1024;

// isHistory: 追跡開始時点で既にファイルにあった行（再開したセッションの過去ログ）
export type EntryHandler = (entry: unknown, isHistory: boolean) => void;
// もう出した行のうち、会話ログから消えた行の uuid（Claude Code が取り消した応答の行。TranscriptTail を参照）
export type RemovedHandler = (uuids: string[]) => void;

type Held = { entry: unknown; isHistory: boolean; parent: string; since: number };
type Read = { entry: unknown; isHistory: boolean };
// 読んだ行（空の行を除く）の中身のハッシュと uuid。会話ログが書き直されたとき、前に読んだ行と突き合わせるのに使う
type ReadLine = { hash: string; uuid: string | null };

// 書き込み途中の行やマルチバイト文字の分断に備え、改行までをバイト列のまま溜めてから parse する。
// 最初の応答の行が発言の行より先に書かれ（parentFirst を参照）、発言の行があとの読み込みで届くこともあるので、
// 親（parentUuid）の行がまだ届いていない行は、親が届くまで（長くても HOLD_MS）出さずに待つ。
// Claude Code は、取り消した応答（tombstone。形の壊れたツールの呼び出しを取り直すときなど）の行を、会話ログに書いたあとで消す
// （2.1.302 の removeMessageByUuid。その行の頭で切り詰め、後ろの行を詰めて書き戻す）。消したあとすぐ次の行を書き足すので、
// 大きさだけでは書き直しに気づけず、前の位置から読むと、消えた行の長さの分だけ後ろの行を読み落とす。そこで、読み終えたところの
// 手前（checked）を次に読むときに照らし、食い違えば（短くなったときも）はじめから読み直して、前に読んだ行と突き合わせる。
// 消えた行は onRemoved で知らせ、まだ読んでいなかった行はふつうに出す
export class TranscriptTail {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  // 読んだところ（offset）の手前、長くても CHECK_BYTES
  private checked = Buffer.alloc(0);
  // 読んだ行（書かれた順）
  private lines: ReadLine[] = [];
  // 書き直しの途中か、消されたのか分からない行（lines の unsureFrom から後ろ）を見つけた時刻。分からない間は、読むたびに読み直す
  private unsure: number | null = null;
  private unsureFrom = 0;
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  // 読んでいる間に届いた変更の通知。読み終えたらもう一度読む
  private again = false;
  private watcher: FSWatcher | null = null;
  // start で取った大きさ。ここまでの行が、前からあった行（過去ログ）
  private startBytes = 0;
  private historySignaled = false;
  // 出した行の uuid と、親を待っている行（届いた順）
  private readonly seen = new Set<string>();
  private held: Held[] = [];

  constructor(
    private readonly file: string,
    private readonly onEntry: EntryHandler,
    // 既存の行（再開したセッションの過去ログ）を読み終えたとき。既存の行が無ければ呼ばれない
    private readonly onHistoryLoaded?: () => void,
    private readonly onRemoved?: RemovedHandler,
  ) {}

  start(): void {
    try {
      this.startBytes = statSync(this.file).size;
    } catch {
      this.startBytes = 0;
    }
    this.timer = setInterval(() => {
      this.watchFile();
      this.releaseExpired();
      this.settle();
      void this.poll();
    }, POLL_MS);
    this.watchFile();
  }

  // 前からあった行の大きさ（start で取ったもの）。0 なら、読み終えた知らせ（onHistoryLoaded）は来ない
  get historyBytes(): number {
    return this.startBytes;
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
      if (size === this.offset) return;
      const handle = await open(this.file, 'r');
      try {
        // 短くなった・手前が前と食い違う: 書き直された
        const readOn = this.unsure === null && size > this.offset && (await this.readOn(handle, size));
        if (!readOn) await this.reread(handle);
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

  // 前に読んだところから先を読む。手前（checked）も読み直して照らし、前と食い違えば（会話ログが書き直された）読まずに false を返す
  private async readOn(handle: FileHandle, size: number): Promise<boolean> {
    const from = this.offset - this.checked.length;
    const chunk = Buffer.alloc(size - from);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, from);
    if (bytesRead < this.checked.length || !chunk.subarray(0, this.checked.length).equals(this.checked)) return false;
    const chunkStart = this.offset;
    this.offset = from + bytesRead;
    this.checked = Buffer.from(chunk.subarray(Math.max(0, bytesRead - CHECK_BYTES), bytesRead));
    if (this.timer) this.consume(chunk.subarray(chunkStart - from, bytesRead), chunkStart);
    return true;
  }

  private consume(chunk: Buffer, chunkStart: number): void {
    const { lines, rest } = splitLines(Buffer.concat([this.pending, chunk]), chunkStart - this.pending.length);
    const read: Read[] = [];
    for (const { text, lineEnd } of lines) {
      const entry = parse(text);
      this.lines.push({ hash: hashOf(text), uuid: uuidOf(entry) });
      if (entry !== NOT_JSON) read.push({ entry, isHistory: lineEnd <= this.startBytes });
    }
    // 読んだまとまり（過去ログなら会話ログ全体）を抱えたままにしない
    this.pending = Buffer.from(rest);
    this.deliver(read);
    if (this.offset >= this.startBytes) this.historyRead();
  }

  // 会話ログが書き直された。はじめから読み直し、前に読んだ行と書かれた順に突き合わせる。前に読んだ行のうち、同じ中身の行が
  // 見つからなかったものは消えた行（取り消された応答の行）、前に読んだ行に無い行は、まだ読んでいなかった行（書き直しのあとに書き足された行）。
  // 書き直しの途中（切り詰めてから書き戻すまでの間）を読むこともある（変更の通知は、切り詰めた時点で届く）。そのときは、前に読んだ行の
  // 後ろの方がまとめて欠けて見え、あとに書き足された行は無い。消されたのと見分けがつかないので、次に読むまで（変わらないまま HOLD_MS
  // たったら、消えたことにする。settle）決めずにおく
  private async reread(handle: FileHandle): Promise<void> {
    const { size } = await handle.stat();
    const data = Buffer.alloc(size);
    const { bytesRead } = await handle.read(data, 0, size, 0);
    const { lines, rest } = splitLines(data.subarray(0, bytesRead), 0);
    // 中身ごとの、前に読んだ行の位置（小さいものが後ろ。突き合わせた位置より前のものは、もう使わない）
    const positions = new Map<string, number[]>();
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const at = positions.get(this.lines[i].hash);
      if (at) at.push(i);
      else positions.set(this.lines[i].hash, [i]);
    }
    const kept: ReadLine[] = [];
    const removed: string[] = [];
    const fresh: Read[] = [];
    // 過去ログを読み終える前なら、まだ読んでいなかった行も過去ログの続き
    const past = this.startBytes > 0 && !this.historySignaled;
    let next = 0;
    // 最後に突き合わせた行より後ろに、まだ読んでいなかった行がある（書き直しを終えて、書き足し始めた）
    let movedOn = false;
    const drop = (until: number) => {
      for (; next < until; next++) {
        const uuid = this.lines[next].uuid;
        if (uuid !== null) removed.push(uuid);
      }
    };
    for (const { text } of lines) {
      const digest = hashOf(text);
      const at = positions.get(digest);
      while (at && at.length > 0 && at[at.length - 1] < next) at.pop();
      const found = at?.pop();
      if (found === undefined) {
        const entry = parse(text);
        kept.push({ hash: digest, uuid: uuidOf(entry) });
        if (entry !== NOT_JSON) fresh.push({ entry, isHistory: past });
        movedOn = true;
        continue;
      }
      drop(found);
      kept.push(this.lines[found]);
      next = found + 1;
      movedOn = false;
    }
    // 最後に突き合わせた行より後ろの、前に読んだ行。あとに書き足された行があれば消えた行、無ければ決めずに残す
    const trailing = movedOn ? [] : this.lines.slice(next);
    if (trailing.length === 0) drop(this.lines.length);
    // 同じ uuid の行が残っていれば、消えたことにしない
    const left = new Set([...kept, ...trailing].map((l) => l.uuid));
    this.unsureFrom = kept.length;
    this.lines = [...kept, ...trailing];
    // 変わり続けている（書き直しの途中）間は、決めるのを延ばす
    this.unsure = trailing.length > 0 ? Date.now() : null;
    this.offset = bytesRead;
    this.pending = Buffer.from(rest);
    this.checked = Buffer.from(data.subarray(Math.max(0, bytesRead - CHECK_BYTES), bytesRead));
    if (!this.timer) return;
    this.forget(removed.filter((uuid) => !left.has(uuid)));
    this.deliver(fresh);
    this.historyRead();
  }

  // 書き直しの途中か分からなかった行が、変わらないまま HOLD_MS たった。消えた行とする
  private settle(): void {
    if (this.unsure === null || this.reading || Date.now() - this.unsure < HOLD_MS) return;
    const gone = this.lines.slice(this.unsureFrom);
    this.lines = this.lines.slice(0, this.unsureFrom);
    this.unsure = null;
    const left = new Set(this.lines.map((l) => l.uuid));
    this.forget(gone.flatMap((l) => (l.uuid !== null && !left.has(l.uuid) ? [l.uuid] : [])));
  }

  // 消えた行のうち、もう出したものを知らせる。親を待っていた（まだ出していない）行は、出さずに捨てる。
  // 出した行は seen に残す（消えた行を親にする行を、来ない親を待たせない）
  private forget(removed: string[]): void {
    if (removed.length === 0) return;
    const gone = new Set(removed);
    this.held = this.held.filter((h) => !gone.has(uuidOf(h.entry) ?? ''));
    const shown = removed.filter((uuid) => this.seen.has(uuid));
    if (shown.length > 0) this.onRemoved?.(shown);
  }

  private deliver(read: Read[]): void {
    for (const { entry, isHistory } of parentFirst(read, (r) => r.entry)) this.accept(entry, isHistory);
  }

  private historyRead(): void {
    if (this.historySignaled || this.startBytes === 0) return;
    this.historySignaled = true;
    this.onHistoryLoaded?.();
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

// 改行までの行（空の行を除く）と、その終わりの位置（ファイルの中のバイト数）。残り（rest）は、まだ書き終わっていない行
function splitLines(buffer: Buffer, start: number): { lines: { text: string; lineEnd: number }[]; rest: Buffer } {
  const lines: { text: string; lineEnd: number }[] = [];
  let from = 0;
  let newline: number;
  while ((newline = buffer.indexOf(0x0a, from)) !== -1) {
    const text = buffer.subarray(from, newline).toString('utf8').trim();
    from = newline + 1;
    if (text) lines.push({ text, lineEnd: start + from });
  }
  return { lines, rest: buffer.subarray(from) };
}

// 書きかけで JSON として読めなかった行
const NOT_JSON = Symbol('not-json');

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

function hashOf(text: string): string {
  return hash('sha1', text, 'base64');
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
