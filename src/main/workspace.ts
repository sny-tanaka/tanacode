import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { t } from '@shared/i18n';
import type { DirEntry, FileContent, SearchOptions, SearchResult, WorkspaceInfo, WriteResult } from '@shared/ipc';
import { git } from './git';

// ツリーに出さず、変更の監視もしないもの
export const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'out', 'dist', '.next', '.turbo']);
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};
const MAX_LISTED_FILES = 50000;
const MAX_SEARCH_MATCHES = 2000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

export class Workspace {
  constructor(readonly root: string) {}

  async info(): Promise<WorkspaceInfo> {
    return { root: this.root, name: basename(this.root), branch: await this.branch() };
  }

  async listDir(relPath: string): Promise<DirEntry[]> {
    const entries = await readdir(this.resolve(relPath), { withFileTypes: true });
    return entries
      .filter((e) => !IGNORED_NAMES.has(e.name))
      .map((e) => ({ name: e.name, path: join(relPath, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }

  async readFile(relPath: string): Promise<FileContent> {
    const abs = this.resolve(relPath);
    const { size } = await stat(abs);
    // 画像は、エディタに絵として出す（SVG は文字として編集できるので、ここでは扱わない）
    const ext = extname(relPath).toLowerCase();
    if (IMAGE_TYPES[ext] && ext !== '.svg') {
      if (size > MAX_IMAGE_BYTES) return { kind: 'too-large', size };
      return { kind: 'image', url: await this.imageUrl(abs, IMAGE_TYPES[ext]) };
    }
    if (size > MAX_FILE_BYTES) return { kind: 'too-large', size };
    const buf = await readFile(abs);
    if (buf.includes(0)) return { kind: 'binary' };
    return { kind: 'text', text: buf.toString('utf8') };
  }

  // Markdown プレビューに出す画像。レンダラーはファイルを直接読めないので data URL で渡す。
  // 読むのは、ワークスペースの中の画像だけ（追加したフォルダ addedFolders の中も）。リンクは解いた場所で確かめる
  async readImage(relPath: string, addedFolders: readonly string[] = []): Promise<string | null> {
    const mime = IMAGE_TYPES[extname(relPath).toLowerCase()];
    if (!mime) return null;
    const abs = await this.resolveInside(relPath, addedFolders);
    const { size } = await stat(abs);
    if (size > MAX_IMAGE_BYTES) return null;
    return this.imageUrl(abs, mime);
  }

  private async imageUrl(abs: string, mime: string): Promise<string> {
    return `data:${mime};base64,${(await readFile(abs)).toString('base64')}`;
  }

  // エディタの保存。expected は、エディタが読んだとき（または最後に保存したとき）の中身。今のディスクがそれと違えば
  // （Claude Code などが書き換えた）、書かずに今の内容を返す。変更の知らせが届く前（監視のまとめの間）や、監視しないフォルダ
  // （IGNORED_NAMES の out など）のファイルでも、外の変更を黙って上書きしないため。消えていたファイルは書き直す（中身は失われない）。
  // null なら確かめずに書く（衝突の知らせで「このまま保存」を選んだとき）
  async writeFile(relPath: string, text: string, expected: string | null): Promise<WriteResult> {
    const abs = this.resolve(relPath);
    if (expected !== null) {
      const disk = await this.readFile(relPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (disk && !(disk.kind === 'text' && disk.text === expected)) return { ok: false, disk };
    }
    await writeFile(abs, text, 'utf8');
    return { ok: true };
  }

  // @ファイル名の補完用。git 管理下なら追跡中と未追跡（.gitignore を除く）、そうでなければフォルダをたどる。
  // git の一覧は -z で読む（無いと、日本語などのファイル名を "\343\203\241.md" のようにエスケープして返す）
  async listFiles(): Promise<string[]> {
    // tanacode が自分で動かす git なので、フォルダの設定のコマンドを打ち消して動かす（git.ts の git）
    const fromGit = await git(this.root, ['ls-files', '-co', '--exclude-standard', '-z']).then(
      (stdout) => stdout.split('\0').filter(Boolean),
      () => null,
    );
    if (fromGit) return fromGit.slice(0, MAX_LISTED_FILES);
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(join(this.root, dir), { withFileTypes: true }).catch(() => [])) {
        if (out.length >= MAX_LISTED_FILES || IGNORED_NAMES.has(entry.name)) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else out.push(path);
      }
    };
    await walk('');
    return out;
  }

  // 全文検索。1 行ずつ探し、行の抜き出しは前後を詰めて返す
  async search(query: string, options: SearchOptions): Promise<SearchResult> {
    if (!query) return { files: [], truncated: false };
    let pattern: RegExp;
    try {
      const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = new RegExp(source, options.caseSensitive ? 'g' : 'gi');
    } catch {
      return { files: [], truncated: false, error: t('main.search.invalidRegex') };
    }
    const result: SearchResult = { files: [], truncated: false };
    let total = 0;
    for (const path of await this.listFiles()) {
      const abs = join(this.root, path);
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile() || info.size > MAX_SEARCH_FILE_BYTES) continue;
      const buf = await readFile(abs).catch(() => null);
      if (!buf || buf.includes(0)) continue;
      const matches: SearchResult['files'][number]['matches'] = [];
      buf
        .toString('utf8')
        .split('\n')
        .forEach((text, i) => {
          pattern.lastIndex = 0;
          const m = pattern.exec(text);
          if (!m || total >= MAX_SEARCH_MATCHES) return;
          total++;
          const start = Math.max(0, m.index - 40);
          matches.push({ line: i + 1, column: m.index + 1, text: text.slice(start, start + 200), matchStart: m.index - start, matchLength: m[0].length });
        });
      if (matches.length > 0) result.files.push({ path, matches });
      if (total >= MAX_SEARCH_MATCHES) {
        result.truncated = true;
        break;
      }
    }
    return result;
  }

  // 絶対パスはフォルダの外のファイル（Claude がユーザーに送ったファイルなど）。アプリの画面から開くときだけ渡ってくる
  private resolve(relPath: string): string {
    if (isAbsolute(relPath)) return relPath;
    const abs = resolve(this.root, relPath);
    const rel = relative(this.root, abs);
    // .. そのものか ../ で始まるものが外（..notes.md のような名前のファイルは中）
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`outside workspace: ${relPath}`);
    return abs;
  }

  // ワークスペースの中（追加したフォルダの中も）のファイルの、リンクを解いた場所。外を指していれば投げる
  private async resolveInside(relPath: string, addedFolders: readonly string[]): Promise<string> {
    const real = await realpath(isAbsolute(relPath) ? relPath : this.resolve(relPath));
    for (const folder of [this.root, ...addedFolders]) {
      const root = await realpath(folder).catch(() => null);
      if (!root) continue;
      const rel = relative(root, real);
      if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return real;
    }
    throw new Error(`outside workspace: ${relPath}`);
  }

  private async branch(): Promise<string | null> {
    const head = await readFile(join(this.root, '.git', 'HEAD'), 'utf8').catch(() => null);
    if (!head) return null;
    const ref = head.match(/^ref: refs\/heads\/(.+)$/m)?.[1];
    return ref ?? head.trim().slice(0, 7);
  }
}
