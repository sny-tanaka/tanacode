import { watch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import { IGNORED_NAMES } from './workspace';

// 保存が連続しても 1 回にまとめて通知する
const DEBOUNCE_MS = 100;

type Watch = { watcher: FSWatcher; refs: number; pending: Set<string>; timer: NodeJS.Timeout | null };

// フォルダ配下のファイル変更を監視する。同じフォルダを開くセッション同士でひとつの監視を共有する
export class WorkspaceWatchers {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly onChange: (root: string, relPaths: string[]) => void) {}

  retain(root: string): void {
    const existing = this.watches.get(root);
    if (existing) {
      existing.refs++;
      return;
    }
    let watcher: FSWatcher;
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename && !isIgnored(filename)) this.enqueue(root, filename);
      });
    } catch {
      return;
    }
    watcher.on('error', () => this.close(root));
    this.watches.set(root, { watcher, refs: 1, pending: new Set(), timer: null });
  }

  release(root: string): void {
    const w = this.watches.get(root);
    if (w && --w.refs <= 0) this.close(root);
  }

  closeAll(): void {
    for (const root of [...this.watches.keys()]) this.close(root);
  }

  private enqueue(root: string, relPath: string): void {
    const w = this.watches.get(root);
    if (!w) return;
    w.pending.add(relPath);
    w.timer ??= setTimeout(() => {
      w.timer = null;
      const paths = [...w.pending];
      w.pending.clear();
      this.onChange(root, paths);
    }, DEBOUNCE_MS);
  }

  private close(root: string): void {
    const w = this.watches.get(root);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.watcher.close();
    this.watches.delete(root);
  }
}

function isIgnored(relPath: string): boolean {
  return relPath.split(sep).some((name) => IGNORED_NAMES.has(name));
}
