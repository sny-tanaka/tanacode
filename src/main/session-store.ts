import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PermissionMode } from '@shared/screen';

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
  // 最適化圧縮を自動で始めるか。無いもの（新しいセッション・この指定ができる前のセッション）はオン
  autoCompact?: boolean;
  // worktree で始めたセッション（claude --worktree）。cwd は worktree のフォルダ（root/.claude/worktrees/<name>）、
  // root は元のフォルダ（リポジトリのいちばん上）、branch は Claude Code が作ったブランチ。無いものはふつうのセッション
  worktree?: { name: string; branch: string; root: string } | null;
  // 起動時の表示で分かった、1M コンテキストのモデルか（再開時は表示が読めないことがあるので覚えておく）
  oneMillion?: boolean;
  // 親セッションの ID（親の Claude が start_session で起動した子セッション）。無いものは親のないセッション
  parentId?: string | null;
  // 子セッションの起動の権限モード（起動したときのモードか、そのあとアプリで切り替えたモード。画面のモード欄・親の configure_session）。
  // 止まった子を起動し直すときも、このモードで起動する（ユーザーの既定のモードが親より強くても、上げないため）
  launchMode?: PermissionMode | null;
  // アプリが決めた権限モード（起動の引数か、アプリでの切り替え。Runtime.knownMode）。アプリを起動し直して、動いている claude を
  // 引き継ぐときに戻す（claude のモードは変わっていないのに、戻さないと manual 扱いになり、そのあとに始める子の上限が下がる）
  knownMode?: PermissionMode | null;
  // ワークスペースに追加したフォルダ（絶対パス。リンクは解いてある）。起動時に --add-dir で渡す。無いものは追加なし
  addedFolders?: string[];
  // 追加したフォルダを変えたが、動いている claude にはまだ渡していない（手が空いたら --resume で起動し直す）。
  // アプリを動かしたまま終了して、次のアプリが claude を引き継いだときも、起動し直すまで残す
  addedFoldersPending?: boolean;
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

// 読めないファイル（壊れた JSON・形の違う中身）は空として始めるが、次の保存で上書きして一覧をすべて消してしまわないよう、
// 元の中身を横（sessions.json.broken-<時刻>）に控えておく
function load(file: string): SessionRecord[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // まだ無い
    return [];
  }
  try {
    const data = JSON.parse(text) as { sessions?: unknown };
    if (Array.isArray(data.sessions)) return data.sessions as SessionRecord[];
  } catch {
    // 下で控える
  }
  try {
    copyFileSync(file, `${file}.broken-${Date.now()}`);
  } catch {
    // 控えられなくても、アプリは起動する
  }
  return [];
}
