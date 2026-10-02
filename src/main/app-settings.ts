import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// 登録した Claude Code の設定ファイル。覚えるのは名前とパスだけ（中身は預からない）
export type StoredSettingsFile = { id: string; name: string; path: string };

// notifications: macOS の通知を出すか / updateCheck: GitHub の Releases で新しいバージョンが出たら通知するか /
// settingsFiles: セッションごとに選んで、標準の設定に重ねて起動する設定ファイル
type Values = { notifications: boolean; updateCheck: boolean; settingsFiles: StoredSettingsFile[] };

// アプリ自身の設定（Claude Code の設定ではない）
export class AppSettings {
  private values: Values;

  constructor(private readonly file: string) {
    this.values = load(file);
  }

  notificationsEnabled(): boolean {
    return this.values.notifications;
  }

  setNotificationsEnabled(on: boolean): void {
    this.update({ notifications: on });
  }

  updateCheckEnabled(): boolean {
    return this.values.updateCheck;
  }

  setUpdateCheckEnabled(on: boolean): void {
    this.update({ updateCheck: on });
  }

  settingsFiles(): StoredSettingsFile[] {
    return this.values.settingsFiles;
  }

  setSettingsFiles(files: StoredSettingsFile[]): void {
    this.update({ settingsFiles: files });
  }

  // 保存できなかったら、値を元に戻して例外を投げる（画面の表示と食い違わせない）
  private update(change: Partial<Values>): void {
    const before = this.values;
    this.values = { ...before, ...change };
    try {
      this.save();
    } catch (error) {
      this.values = before;
      throw error;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.values }, null, 2));
    renameSync(tmp, this.file);
  }
}

// 無い・読めない値は、オン（通知は、この設定ができる前のバージョンと同じく出す）。設定ファイルは、無ければ登録なし
function load(file: string): Values {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { notifications?: unknown; updateCheck?: unknown; settingsFiles?: unknown };
    return {
      notifications: data.notifications !== false,
      updateCheck: data.updateCheck !== false,
      settingsFiles: storedFiles(data.settingsFiles),
    };
  } catch {
    return { notifications: true, updateCheck: true, settingsFiles: [] };
  }
}

function storedFiles(value: unknown): StoredSettingsFile[] {
  if (!Array.isArray(value)) return [];
  const files: StoredSettingsFile[] = [];
  for (const item of value as { id?: unknown; name?: unknown; path?: unknown }[]) {
    if (typeof item?.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string') {
      files.push({ id: item.id, name: item.name, path: item.path });
    }
  }
  return files;
}
