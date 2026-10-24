import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UnsentPrompt } from '@shared/chat';
import type { PermissionMode } from '@shared/screen';
import type { SessionState } from '@shared/session-tools';
import type { ClaudeProcess } from './leftover-claude';
import type { SavedInit } from './stream/protocol';

// 起動を待って送る発言（SessionManager.submitWhenReady）の本文。子への最初の指示は、送る直前に、worktree の準備でうまくいかなかったことを
// 本文に添えて、親の指示の囲みに入れる（parent: 親の ID / body: 指示の本文。記録に残すときも、この形のまま残す）
export type WaitingText = string | { parent: string; body: string; setupNote: true };

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
  // worktree を消したときに残したもの（作り直すときに使い、作り直したら外す）。branch: worktree で使っていて残したブランチ
  // （子が git switch -c で作ったものなど）/ backupRef: 未コミットの変更の控え
  worktreeSaved?: { branch: string | null; backupRef: string | null } | null;
  // 起動時の表示で分かった、1M コンテキストのモデルか（再開時は表示が読めないことがあるので覚えておく）
  oneMillion?: boolean;
  // 親セッションの ID（親の Claude が start_session で起動した子セッション）。無いものは親のないセッション
  parentId?: string | null;
  // 子セッションの起動の権限モード（起動したときのモードか、そのあとアプリで切り替えたモード。画面のモード欄・親の configure_session）。
  // 止まった子を起動し直すときも、このモードで起動する（ユーザーの既定のモードが親より強くても、上げないため）
  launchMode?: PermissionMode | null;
  // ターミナルモード（Claude Code の画面のまま）で起動したか。Claude Code が終わっても、アプリを起動し直しても、ターミナルモードの
  // まま止まった状態で開き、「再開」もターミナルモードで起動する（チャットには、人が切り替えボタンで戻す）
  terminal?: boolean;
  // アプリが決めた権限モード（起動の引数か、アプリでの切り替え。Runtime.knownMode）。アプリを起動し直して、動いている claude を
  // 引き継ぐときに戻す（claude のモードは変わっていないのに、戻さないと manual 扱いになり、そのあとに始める子の上限が下がる）
  knownMode?: PermissionMode | null;
  // ワークスペースに追加したフォルダ（絶対パス。リンクは解いてある）。起動時に --add-dir で渡す。無いものは追加なし
  addedFolders?: string[];
  // 追加したフォルダを変えたが、動いている claude にはまだ渡していない（手が空いたら --resume で起動し直す）。
  // アプリを動かしたまま終了して、次のアプリが claude を引き継いだときも、起動し直すまで残す
  addedFoldersPending?: boolean;
  // Claude がフォルダの外で読んだ・書いたもの（outside-reads.ts）。readFolders: git のリポジトリのいちばん上 / readFiles: どのリポジトリにも
  // 入っていないファイル。どれも絶対パス。エクスプローラーに出すだけで、--add-dir には渡さない（人が追加フォルダに移したら渡す）
  readFolders?: string[];
  readFiles?: string[];
  // エクスプローラーから消したもの（パス → 消した時刻のミリ秒）。起動し直して会話を読み直しても、消す前の行では出し直さない
  dismissedReads?: Record<string, number>;
  // 最後に起動したチャットの claude（initialize の返事の pid と、起動したときの会話の ID）。常駐のホストが止める間もなく落ちると
  // claude だけが残るので、開き直す前に残っていないかを確かめて止める（leftover-claude.ts）
  claudeProcess?: ClaudeProcess | null;
  // 最後に起動したチャットの claude の initialize の返事のうち、引き継いだあとも要るもの（モデル・エフォートの確かめ、auto を使えるか、
  // / の候補、Remote Control を使えるか）。引き継いだ claude には initialize を送り直さないので、ここから戻す
  claudeInit?: SavedInit | null;
  // 最後につないだ Remote Control のセッションの ID（remote_control の返事・会話ログの bridge-session 行の bridgeSessionId）。
  // 止まっていたセッションを開き直してつなぐときも、reattach_session_id で同じ Remote Control のセッションに付け直す
  bridgeSessionId?: string | null;
  // claude を動かしたままアプリを終了したときに、送ったがまだ会話に出ていなかった発言（送信中・順番待ち）。次のアプリが claude を
  // 引き継いだら戻す（順番待ちの発言の文は stream-json の行に無く、そのターンが始まるまで戻ってこない。実測）。shown: チャットに出すもの
  unsent?: (UnsentPrompt & { shown: boolean })[] | null;
  // 起動を待って送る親の指示のうち、送る前にアプリを終えたもの（keep。子への最初の指示・起動の途中や止まっていた子への指示）。
  // 次にそのセッションを起動したら（引き継いだときも）、待ち始めた順に送り直す（timeoutMs: 待つ上限。送り直すときから数える）
  waiting?: { text: WaitingText; timeoutMs: number }[] | null;
  // worktree の準備（Claude Code が作るのを待つ・node_modules の用意）の途中。終わる前にアプリを終えたら、次に起動したとき
  // （引き継いだときも）に node_modules の用意をやり直す（install はアプリのターミナルで動くので、アプリを終えると止まる）
  worktreePreparing?: boolean;
  // アプリから Claude への知らせ（session-notices.ts）のうち、このセッションに送る前にアプリを終えたもの（列の名前 → [キー, 中身]）。
  // 次のアプリが戻し、手が空いたら送る
  notices?: Record<string, [string, unknown][]> | null;
  // claude を動かしたままアプリを終えた時刻。次のアプリが引き継いだら、それよりあとの会話ログの行（アプリを閉じている間の行）から、
  // 最後のターンが利用枠で止まって終わったかを見て、再開の予約を入れる（前のアプリの頃の行なので、ターンの終わりでは知らせない）。
  // 引き継いだら消す（アプリが落ちて、終えた時刻を書けなかったときは、前に終えた時刻を使い回さない）
  detachedAt?: number | null;
  // claude を動かしたままアプリを終えたときの、このセッションの状態（作業中・待機 など）。次のアプリが引き継いだら、閉じている間に
  // 作業を終えた子を親に知らせるのに使う（引き継いだあとの状態は、止まっている → 起動中 → 待機と変わり、作業中から手が空いたように見えないため。
  // SessionsControl の stateChanged）。引き継いだら消す
  detachedState?: SessionState | null;
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
