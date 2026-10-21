import { watch, type FSWatcher } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { IGNORED_NAMES } from './workspace';

// ファイルごとに見張るファイルの数の上限。超えた分は見張らない（エディタで開き直したときに、ディスクから読み直す）
export const MAX_OPEN_FILE_WATCHES = 100;
// 保存が連続しても 1 回にまとめて通知する（WorkspaceWatchers と同じ）
const DEBOUNCE_MS = 100;

// エディタで開いているタブ。dir はエディタのフォルダ、path はタブのパス（dir からの相対か、絶対）
type Tab = { dir: string; path: string };
// 見張っているフォルダ（ファイルの実体の親フォルダ）。files は、その中で見張るファイルの名前 → そのファイルを開いているタブ
type Watch = { watcher: FSWatcher; files: Map<string, Tab[]> };

// エディタで開いているタブのうち、フォルダの監視（WorkspaceWatchers）の知らせでは読み直せないものを、ファイルごとに見張る。
// フォルダの外のファイル（Claude が送ったもの・チャットのツールから開いたもの）、監視しないフォルダ（IGNORED_NAMES の out など）の中、
// 途中にリンクのあるもの（フォルダの監視の知らせは実体のパスで来る）。ファイルそのものではなく、実体の親フォルダを recursive なしで
// 見張る（Claude Code は一時ファイルに書いてから rename で置き換えるので、ファイルを見張ると、置き換えたあとの知らせが来ない）
export class OpenFileWatchers {
  // エディタのフォルダ → 開いているタブのパス（画面から届いたもの）
  private tabs: Record<string, string[]> = {};
  private readonly dirs = new Map<string, Watch>();
  private pending = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  // 見張るものを決め直すたびに増やす。決め直している間（realpath を待つ間）に次の決め直しが始まったら、古いほうは捨てる
  private generation = 0;
  private closed = false;

  // roots: 今見張っているフォルダ（WorkspaceWatchers）。onChange は WorkspaceWatchers と同じ形（root と、root からの相対パス）
  constructor(
    private readonly roots: () => readonly string[],
    private readonly onChange: (root: string, relPaths: string[]) => void,
  ) {}

  // 画面のエディタで開いているタブ（エディタのフォルダ → タブのパス）。届くたびに、前のものと置き換える
  set(tabs: unknown): void {
    const next: Record<string, string[]> = {};
    if (tabs && typeof tabs === 'object') {
      for (const [dir, paths] of Object.entries(tabs)) {
        if (isAbsolute(dir) && Array.isArray(paths)) next[dir] = paths.filter((p): p is string => typeof p === 'string' && p !== '');
      }
    }
    this.tabs = next;
    void this.refresh();
  }

  // フォルダの監視が始まった・終わった（タブがフォルダの監視で読み直せるかが変わる）
  rootsChanged(): void {
    void this.refresh();
  }

  // 見張っているファイル（実体の絶対パス）
  watched(): string[] {
    return [...this.dirs].flatMap(([dir, w]) => [...w.files.keys()].map((name) => join(dir, name)));
  }

  closeAll(): void {
    this.closed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    for (const w of this.dirs.values()) w.watcher.close();
    this.dirs.clear();
  }

  // 見張るものを、今のタブとフォルダの監視に合わせて決め直す
  private async refresh(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    const roots = await Promise.all(this.roots().map(async (root) => ({ root, real: await realpath(root).catch(() => null) })));
    const wanted = new Map<string, Map<string, Tab[]>>();
    let count = 0;
    for (const [dir, paths] of Object.entries(this.tabs)) {
      for (const path of paths) {
        const tab = { dir, path };
        const abs = isAbsolute(path) ? path : join(dir, path);
        const real = await realFile(abs);
        if (!real || roots.some((r) => covers(r.root, r.real, tab, abs, real))) continue;
        const parent = dirname(real);
        const name = basename(real);
        const same = wanted.get(parent)?.get(name);
        if (same) {
          same.push(tab);
          continue;
        }
        if (count >= MAX_OPEN_FILE_WATCHES) continue;
        count++;
        if (!wanted.has(parent)) wanted.set(parent, new Map());
        wanted.get(parent)!.set(name, [tab]);
      }
    }
    if (generation !== this.generation) return;
    for (const [dir, w] of this.dirs) {
      if (wanted.has(dir)) continue;
      w.watcher.close();
      this.dirs.delete(dir);
    }
    for (const [dir, files] of wanted) {
      const existing = this.dirs.get(dir);
      if (existing) {
        existing.files = files;
        continue;
      }
      let watcher: FSWatcher;
      try {
        watcher = watch(dir, (_event, filename) => {
          if (filename) this.changed(dir, filename);
        });
      } catch {
        continue;
      }
      // 見張れなくなったら（フォルダを消したなど）やめる。次にタブかフォルダの監視が変わったときに、見張り直す
      watcher.on('error', () => {
        if (this.dirs.get(dir)?.watcher !== watcher) return;
        watcher.close();
        this.dirs.delete(dir);
      });
      this.dirs.set(dir, { watcher, files });
    }
  }

  // 画面の読み直し（App の reloadFiles）が見分ける形で知らせる。相対パスのタブはエディタのフォルダからの相対、
  // 絶対パスのタブは親フォルダとファイル名
  private changed(dir: string, name: string): void {
    for (const tab of this.dirs.get(dir)?.files.get(name) ?? []) {
      if (isAbsolute(tab.path)) this.enqueue(dirname(tab.path), basename(tab.path));
      else this.enqueue(tab.dir, tab.path);
    }
  }

  private enqueue(root: string, relPath: string): void {
    const paths = this.pending.get(root) ?? new Set<string>();
    paths.add(relPath);
    this.pending.set(root, paths);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const pending = this.pending;
      this.pending = new Map();
      for (const [root, paths] of pending) this.onChange(root, [...paths]);
    }, DEBOUNCE_MS);
  }
}

// ファイルの実体のパス。無ければ（消えた・まだ無い）、親フォルダの実体の下の同じ名前（作り直されたら知らせる）
async function realFile(abs: string): Promise<string | null> {
  return realpath(abs).catch(async () => {
    const parent = await realpath(dirname(abs)).catch(() => null);
    return parent && join(parent, basename(abs));
  });
}

// フォルダ root の監視の知らせで、画面がこのタブを読み直せるか（App の reloadFiles と同じ見分け方）。相対パスのタブは
// エディタのフォルダそのものの監視、絶対パスのタブはそれを含むフォルダの監視で読み直す。監視しないフォルダの中と、
// 途中にリンクのあるもの（知らせは実体のパスで来るので、タブのパスと合わない）は読み直せない
function covers(root: string, realRoot: string | null, tab: Tab, abs: string, real: string): boolean {
  if (realRoot === null || (!isAbsolute(tab.path) && tab.dir !== root)) return false;
  const rel = relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return !rel.split(sep).some((name) => IGNORED_NAMES.has(name)) && real === join(realRoot, rel);
}
