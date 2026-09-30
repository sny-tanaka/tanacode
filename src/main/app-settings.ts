import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// アプリ自身の設定（Claude Code の設定ではない）。今あるのは、macOS の通知を出すか
export class AppSettings {
  private notifications: boolean;

  constructor(private readonly file: string) {
    this.notifications = load(file);
  }

  notificationsEnabled(): boolean {
    return this.notifications;
  }

  // 保存できなかったら、値を元に戻して例外を投げる（画面の表示と食い違わせない）
  setNotificationsEnabled(on: boolean): void {
    const before = this.notifications;
    this.notifications = on;
    try {
      this.save();
    } catch (error) {
      this.notifications = before;
      throw error;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, notifications: this.notifications }, null, 2));
    renameSync(tmp, this.file);
  }
}

// 無い・読めないときは、オン（この設定ができる前の版と同じく通知を出す）
function load(file: string): boolean {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { notifications?: unknown };
    return data.notifications !== false;
  } catch {
    return true;
  }
}
