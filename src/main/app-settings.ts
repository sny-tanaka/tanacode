import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// 登録した Claude Code の設定ファイル。覚えるのは名前とパスだけ（中身は預からない）
export type StoredSettingsFile = { id: string; name: string; path: string };

// notifications: macOS の通知を出すか / updateCheck: GitHub の Releases で新しいバージョンが出たら通知するか /
// settingsFiles: セッションごとに選んで、標準の設定に重ねて起動する設定ファイル /
// browserControl: Claude にアプリ内ブラウザを操作させるか（起動する Claude Code に MCP サーバーを足すか）/
// browserHosts: アプリ内ブラウザで Claude に許す先（localhost などの既定に足すもの）/
// sessionsControl: Claude にほかのセッションを扱わせるか（起動する Claude Code に、セッションの MCP サーバーを足すか）/
// checklistControl: Claude にチェックリストを扱わせるか（起動する Claude Code に、チェックリストの MCP サーバーを足すか）/
// walkthroughControl: Claude にウォークスルーさせるか（起動する Claude Code に、ウォークスルーの MCP サーバーを足すか）
type Values = {
  notifications: boolean;
  updateCheck: boolean;
  settingsFiles: StoredSettingsFile[];
  browserControl: boolean;
  browserHosts: string[];
  sessionsControl: boolean;
  checklistControl: boolean;
  walkthroughControl: boolean;
};

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

  browserControlEnabled(): boolean {
    return this.values.browserControl;
  }

  setBrowserControlEnabled(on: boolean): void {
    this.update({ browserControl: on });
  }

  browserHosts(): string[] {
    return this.values.browserHosts;
  }

  sessionsControlEnabled(): boolean {
    return this.values.sessionsControl;
  }

  setSessionsControlEnabled(on: boolean): void {
    this.update({ sessionsControl: on });
  }

  checklistControlEnabled(): boolean {
    return this.values.checklistControl;
  }

  setChecklistControlEnabled(on: boolean): void {
    this.update({ checklistControl: on });
  }

  walkthroughControlEnabled(): boolean {
    return this.values.walkthroughControl;
  }

  setWalkthroughControlEnabled(on: boolean): void {
    this.update({ walkthroughControl: on });
  }

  setBrowserHosts(hosts: string[]): void {
    this.update({ browserHosts: hosts });
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

// 無い・読めない値は、オン（通知は、この設定ができる前のバージョンと同じく出す）。設定ファイルと許す先は、無ければ無し
function load(file: string): Values {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      notifications?: unknown;
      updateCheck?: unknown;
      settingsFiles?: unknown;
      browserControl?: unknown;
      browserHosts?: unknown;
      sessionsControl?: unknown;
      checklistControl?: unknown;
      walkthroughControl?: unknown;
    };
    return {
      notifications: data.notifications !== false,
      updateCheck: data.updateCheck !== false,
      settingsFiles: storedFiles(data.settingsFiles),
      browserControl: data.browserControl !== false,
      browserHosts: Array.isArray(data.browserHosts) ? data.browserHosts.filter((h): h is string => typeof h === 'string') : [],
      sessionsControl: data.sessionsControl !== false,
      checklistControl: data.checklistControl !== false,
      walkthroughControl: data.walkthroughControl !== false,
    };
  } catch {
    return { notifications: true, updateCheck: true, settingsFiles: [], browserControl: true, browserHosts: [], sessionsControl: true, checklistControl: true, walkthroughControl: true };
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
