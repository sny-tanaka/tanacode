import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SessionRecord = {
  id: string;
  // /clear で変わるため、アプリ側の id とは別に持つ
  claudeSessionId: string;
  cwd: string;
  title: string | null;
  titlePriority: number;
  archived: boolean;
  // 起動時に --model / --effort で渡す。null は Claude Code の既定値（ユーザー設定）のまま
  model?: string | null;
  effort?: string | null;
  // 起動に重ねる、登録した設定ファイルの ID（SettingsFile.id）。null・無いものは標準の設定のまま
  settingsFile?: string | null;
  // Remote Control を使うか。無いもの（この指定ができる前のセッション）は使う
  remoteControl?: boolean;
  // 起動時の表示で分かった、1M コンテキストのモデルか（再開時は表示が読めないことがあるので覚えておく）
  oneMillion?: boolean;
  createdAt: number;
  updatedAt: number;
};

const SAVE_DELAY_MS = 500;

export class SessionStore {
  private records: SessionRecord[];
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.records = load(file);
  }

  all(): SessionRecord[] {
    return this.records;
  }

  get(id: string): SessionRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  add(record: SessionRecord): void {
    this.records.push(record);
    this.scheduleSave();
  }

  remove(id: string): void {
    this.records = this.records.filter((r) => r.id !== id);
    this.scheduleSave();
  }

  update(id: string, patch: Partial<SessionRecord>): void {
    const record = this.get(id);
    if (!record) return;
    Object.assign(record, patch);
    this.scheduleSave();
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: this.records }, null, 2));
    renameSync(tmp, this.file);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }
}

function load(file: string): SessionRecord[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { sessions?: SessionRecord[] };
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}
