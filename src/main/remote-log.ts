import { appendFile, rename, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { RemoteLogEntry, RemoteLogKind } from '@shared/remote-settings';

// 遠隔操作の記録（Issue #464 の「気づき方と止め方」「記録」）。userData/remote.log に、1 行に 1 つの JSON で足す。
// - 書くのは、時刻・何が起きたか・端末の名前だけ。Cookie・コード・券・WebAuthn の中身・発言・打ったキー・絵は書かない
// - 端末の名前は相手が決められるので、制御文字を除いて短くする
// - 消す口は作らない（遠隔の接続からは消せない）。大きくなりすぎたら、ひとつ前のもの（remote.log.1）に回して書き直す
const MAX_BYTES = 256 * 1024;
// Mac のダイアログに出す数
export const REMOTE_LOG_RECENT = 50;
const KINDS: ReadonlySet<string> = new Set<RemoteLogKind>(['login', 'login-failures', 'ticket-failures', 'pairing-approved', 'pairing-rejected', 'pairing-hijack', 'device-removed', 'devices-reset', 'disconnect-all']);

// 制御文字（改行を含む）を除き、64 文字までにする
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').slice(0, 64);
}

function parseLine(line: string): RemoteLogEntry | null {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (!v || typeof v.at !== 'number' || typeof v.kind !== 'string' || !KINDS.has(v.kind)) return null;
    return { at: v.at, kind: v.kind as RemoteLogKind, ...(typeof v.name === 'string' ? { name: cleanName(v.name) } : {}) };
  } catch {
    return null;
  }
}

export class RemoteLog {
  // 新しいものが先
  private recentEntries: RemoteLogEntry[];
  // 書き込みは順に並べる（回す（rename）のと書くのがぶつからないように）
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.recentEntries = [...this.readLines(`${path}.1`), ...this.readLines(path)].reverse().slice(0, REMOTE_LOG_RECENT);
  }

  add(kind: RemoteLogKind, name?: string): RemoteLogEntry {
    const entry: RemoteLogEntry = { at: this.now(), kind, ...(name !== undefined ? { name: cleanName(name) } : {}) };
    this.recentEntries = [entry, ...this.recentEntries].slice(0, REMOTE_LOG_RECENT);
    const run = this.queue.then(() => this.write(entry));
    this.queue = run.catch((error: unknown) => this.onError(error));
    return entry;
  }

  recent(): RemoteLogEntry[] {
    return [...this.recentEntries];
  }

  // 書き終えるのを待つ（テストと、終わるとき）
  flush(): Promise<void> {
    return this.queue;
  }

  private readLines(path: string): RemoteLogEntry[] {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').flatMap((line) => {
      const entry = line ? parseLine(line) : null;
      return entry ? [entry] : [];
    });
  }

  private async write(entry: RemoteLogEntry): Promise<void> {
    const size = await stat(this.path).then((s) => s.size, () => 0);
    if (size > MAX_BYTES) await rename(this.path, `${this.path}.1`).catch(() => undefined);
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}
