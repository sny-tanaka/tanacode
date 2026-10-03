import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { SettingsFile } from '@shared/settings-file';
import type { AppSettings, StoredSettingsFile } from './app-settings';
import { ownSettings, userStatusLineCommand } from './statusline';

// 登録した設定ファイル（Claude Code の settings.json と同じ形）。選んだセッションだけ、アプリが付ける設定（statusLine・フック）とこのファイルを
// 合わせた設定で Claude Code を起動する。Claude Code は --settings を 2 回渡しても合わせてくれず、最後の 1 つしか使わないので、アプリが合わせる

type Settings = Record<string, unknown>;

export type PreparedSettings = {
  // アプリの設定と登録した設定ファイルを合わせたファイル（--settings に渡す）
  settingsFile: string;
  // 設定ファイルの model。--model が設定の model を上書きするので、モデルを選んでいないときはこれを渡す
  model: string | null;
};

type Store = Pick<AppSettings, 'settingsFiles' | 'setSettingsFiles'>;

function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const UNUSABLE = 'を使えません: ';

function readSettings(file: StoredSettingsFile): Settings {
  const fail = (reason: string) => new Error(`設定ファイル「${file.name}」（${tilde(file.path)}）${UNUSABLE}${reason}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file.path, 'utf8'));
  } catch (error) {
    throw fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ファイルが見つかりません' : 'JSON として読めません（書き方を確かめてください）');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fail('中身が JSON のオブジェクトではありません');
  return parsed as Settings;
}

// 一覧に出す、読めない理由（「…を使えません: 」のあとの部分）
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const at = text.indexOf(UNUSABLE);
  return at < 0 ? text : text.slice(at + UNUSABLE.length);
}

function modelOf(settings: Settings): string | null {
  return typeof settings.model === 'string' && settings.model ? settings.model : null;
}

function isRecord(value: unknown): value is Settings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 登録した設定（profile）に、アプリの設定（own）を足す。
// statusLine はアプリのもの（own の中で、登録した設定の statusLine を包んである）、フックは登録した設定のものとアプリのものを両方動かす。
// それ以外（env・model など）は登録した設定のまま
export function mergeSettings(profile: Settings, own: Settings): Settings {
  const merged: Settings = { ...profile, ...own };
  const profileHooks = isRecord(profile.hooks) ? profile.hooks : {};
  const ownHooks = isRecord(own.hooks) ? own.hooks : {};
  const hooks: Settings = { ...profileHooks };
  for (const [event, entries] of Object.entries(ownHooks)) {
    const before = profileHooks[event];
    hooks[event] = [...(Array.isArray(before) ? before : []), ...(Array.isArray(entries) ? entries : [])];
  }
  merged.hooks = hooks;
  return merged;
}

// 登録した設定の statusLine のコマンド。無ければ、ユーザー自身の設定（~/.claude/settings.json）のもの
function statusLineCommandOf(profile: Settings): string | null {
  const line = profile.statusLine;
  if (isRecord(line)) return line.type === 'command' && typeof line.command === 'string' && line.command ? line.command : null;
  return userStatusLineCommand();
}

// 名前の既定。settings-litellm.json → litellm、settings.json → settings、foo.json → foo
export function defaultName(path: string): string {
  const base = basename(path).replace(/\.json$/i, '');
  const trimmed = base.replace(/^settings-/, '');
  return trimmed || base || '設定ファイル';
}

export class SettingsFiles {
  // runDir: 起動中のセッションが使う、合わせた設定のファイルを置く場所。onChanged: 登録が変わったとき（画面に新しい一覧を知らせる）
  constructor(
    private readonly store: Store,
    private readonly runDir: string,
    private readonly onChanged: (files: SettingsFile[]) => void = () => {},
  ) {}

  list(): SettingsFile[] {
    return this.store.settingsFiles().map((file) => {
      try {
        return { ...file, error: null, model: modelOf(readSettings(file)) };
      } catch (error) {
        return { ...file, error: reasonOf(error), model: null };
      }
    });
  }

  // 登録する。読めないファイル（無い・JSON でない）は登録できない。name を省くとファイル名から付け、ほかと重なれば番号を足す
  add(path: string, name?: string): SettingsFile {
    const absolute = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    if (!isAbsolute(absolute)) throw new Error('設定ファイルのパスは、/ から始まる絶対パスで指定してください');
    const files = this.store.settingsFiles();
    const same = files.find((f) => f.path === absolute);
    if (same) throw new Error(`同じファイルは、すでに「${same.name}」として登録されています`);
    const wanted = (name ?? '').trim() || defaultName(absolute);
    const entry: StoredSettingsFile = { id: randomUUID(), name: this.uniqueName(wanted, files), path: absolute };
    readSettings(entry);
    this.store.setSettingsFiles([...files, entry]);
    this.changed();
    return this.list().find((f) => f.id === entry.id)!;
  }

  rename(id: string, name: string): void {
    const files = this.store.settingsFiles();
    if (!files.some((f) => f.id === id)) throw new Error('登録が見つかりません');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('名前を入力してください');
    if (files.some((f) => f.id !== id && f.name === trimmed)) throw new Error(`「${trimmed}」という名前の設定ファイルは、すでにあります`);
    this.store.setSettingsFiles(files.map((f) => (f.id === id ? { ...f, name: trimmed } : f)));
    this.changed();
  }

  // 登録から外す（ファイル自体は消さない）。使っているセッションは、次に起動するときに check で断られる
  remove(id: string): void {
    const files = this.store.settingsFiles();
    if (!files.some((f) => f.id === id)) return;
    this.store.setSettingsFiles(files.filter((f) => f.id !== id));
    this.changed();
  }

  // 使えるか確かめる。使えなければ、理由を添えて投げる（起動する前に確かめる）
  check(id: string): void {
    readSettings(this.find(id));
  }

  // セッションの起動前に、アプリの設定と登録した設定を合わせたファイルを書く。
  // API キーが入っていることがあるので、引数（ps で見える）には載せず、自分だけが読めるファイルにして、パスだけを渡す
  // browser: アプリ内ブラウザの MCP サーバーを足すか（JavaScript の実行の確認のフックを入れる）
  // sessions: セッションの MCP サーバーを足すか（子セッションの起動の確認のフックを入れる）
  prepare(sessionId: string, id: string, browser = false, sessions = false): PreparedSettings {
    const profile = readSettings(this.find(id));
    const merged = mergeSettings(profile, ownSettings(statusLineCommandOf(profile), browser, sessions));
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    chmodSync(this.runDir, 0o700);
    const settingsFile = join(this.runDir, `${sessionId}.json`);
    writeFileSync(settingsFile, JSON.stringify(merged), { mode: 0o600 });
    // 前に書いたファイルがあると mode は効かないので、あらためて絞る
    chmodSync(settingsFile, 0o600);
    return { settingsFile, model: modelOf(profile) };
  }

  // セッションが終わったら、合わせたファイルを消す
  release(sessionId: string): void {
    rmSync(join(this.runDir, `${sessionId}.json`), { force: true });
  }

  private find(id: string): StoredSettingsFile {
    const file = this.store.settingsFiles().find((f) => f.id === id);
    if (!file) {
      throw new Error('このセッションが使っていた設定ファイルは、登録から外されています。選択欄の「管理…」で登録し直すか、別の設定ファイルに切り替えてください');
    }
    return file;
  }

  private uniqueName(wanted: string, files: StoredSettingsFile[]): string {
    let name = wanted;
    for (let n = 2; files.some((f) => f.name === name); n++) name = `${wanted} ${n}`;
    return name;
  }

  private changed(): void {
    this.onChanged(this.list());
  }
}
