import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TranscriptTail, type EntryHandler } from './transcript-tail';

const HEAD_BYTES = 16 * 1024;

type Handlers = {
  onEntry: EntryHandler;
  onHistoryLoaded: () => void;
  // /clear などで Claude Code が別の会話ログファイルに切り替えたとき
  onSwitch: (file: string) => void;
};

// Claude Code は /clear で新しいセッション ID の会話ログに書き始める。手がかりは 2 つ。
// - statusLine: 今の会話ログのパス（transcript_path）が届く。Remote Control を使っていなくても追える（offer）
// - Remote Control のブリッジ ID: 新しいファイルにも同じ ID が記録される
export class TranscriptFollower {
  private tail: TranscriptTail | null = null;
  private current: string;
  // --resume では過去のブリッジ ID も履歴に残っているため、最後に見たものを使う
  private bridgeSessionId: string | null = null;
  private dirWatcher: FSWatcher | null = null;
  private stopped = false;

  constructor(
    initialFile: string,
    private readonly handlers: Handlers,
    // この時刻より後に作られた会話ログだけを、切り替え先の候補にする
    private readonly startedAt = Date.now(),
  ) {
    this.current = initialFile;
  }

  start(): void {
    this.follow(this.current, true);
  }

  stop(): void {
    this.stopped = true;
    this.tail?.stop();
    this.tail = null;
    this.dirWatcher?.close();
    this.dirWatcher = null;
  }

  private follow(file: string, initial = false): void {
    this.tail?.stop();
    this.current = file;
    const onHistoryLoaded = initial ? this.handlers.onHistoryLoaded : undefined;
    this.tail = new TranscriptTail(file, (entry, isHistory) => {
      const e = entry as { type?: string; bridgeSessionId?: string };
      if (e.type === 'bridge-session' && e.bridgeSessionId) {
        this.bridgeSessionId = e.bridgeSessionId;
        this.watchDir();
      }
      this.handlers.onEntry(entry, isHistory);
    }, onHistoryLoaded);
    this.tail.start();
  }

  private watchDir(): void {
    if (this.dirWatcher || this.stopped) return;
    const dir = dirname(this.current);
    this.dirWatcher = watch(dir, (_event, filename) => {
      if (!filename?.endsWith('.jsonl')) return;
      const file = join(dir, filename);
      if (file !== this.current) void this.checkCandidate(file);
    });
  }

  // statusLine が教えてくれた、今の会話ログ。同じフォルダで、この claude の起動より後にできたものなら乗り換える
  // （--resume や /resume で前からある会話を開いたときは、乗り換えない）
  async offer(file: string): Promise<void> {
    if (this.stopped || file === this.current || dirname(file) !== dirname(this.current)) return;
    const info = await stat(file).catch(() => null);
    if (!info || info.birthtimeMs < this.startedAt || this.stopped || file === this.current) return;
    this.handlers.onSwitch(file);
    this.follow(file);
  }

  private async checkCandidate(file: string): Promise<void> {
    const info = await stat(file).catch(() => null);
    if (!info || info.birthtimeMs < this.startedAt || !this.bridgeSessionId) return;
    const head = await readHead(file);
    const matches = head.some((line) => {
      try {
        const e = JSON.parse(line) as { type?: string; bridgeSessionId?: string };
        return e.type === 'bridge-session' && e.bridgeSessionId === this.bridgeSessionId;
      } catch {
        return false;
      }
    });
    if (!matches || this.stopped || file === this.current) return;
    this.handlers.onSwitch(file);
    this.follow(file);
  }
}

async function readHead(file: string): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, -1);
  } finally {
    await handle.close();
  }
}
