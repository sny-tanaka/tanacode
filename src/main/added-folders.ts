import { realpath, stat } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import { t } from '@shared/i18n';

// ワークスペースに追加するフォルダを確かめて、リンクを解いた絶対パスを返す。追加できなければ理由を添えて投げる。
// cwd: セッションのフォルダ（その中のフォルダは、もうエクスプローラーに出ているので足さない）
export async function resolveAddedFolder(cwd: string, folder: string): Promise<string> {
  const real = await realpath(folder).catch(() => null);
  if (!real || !(await stat(real).then((s) => s.isDirectory(), () => false))) throw new Error(t('main.error.folderNotFound', { path: folder }));
  // ディスクのいちばん上は足さない（中身をすべて見張ることになる）
  if (dirname(real) === real) throw new Error(t('main.addFolder.diskRoot', { path: real }));
  const base = await realpath(cwd).catch(() => cwd);
  const rel = relative(base, real);
  if (rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep))) throw new Error(t('main.addFolder.inside', { path: real }));
  return real;
}

// 新規セッションの画面で追加したフォルダを、始めるときに確かめ直す（画面を開いてから消した・動かしたものは外す）。重なりも除く
export async function resolveAddedFolders(cwd: string, folders: readonly string[] | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const folder of folders ?? []) {
    const real = await resolveAddedFolder(cwd, folder).catch(() => null);
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}
