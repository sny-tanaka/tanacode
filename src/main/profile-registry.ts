import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { DEFAULT_PROFILE_ID, PROFILE_COLORS, type NewProfile, type ProfileInfo } from '@shared/profile';
import { claudeConfigDir } from './claude-config';

type Stored = {
  // 既定のプロファイルの名前と色（設定のフォルダは持たない）
  default: { name: string; color: string };
  profiles: ProfileInfo[];
};

const DEFAULT_NAME = '標準';
const MAX_NAME = 40;

// 登録したプロファイル（userData の profiles.json）。覚えるのは名前・色・Claude Code の設定のフォルダだけ。
// 既定のプロファイルはいつもある（消せない）
export class ProfileRegistry {
  private stored: Stored;

  constructor(private readonly file: string) {
    this.stored = load(file);
  }

  list(): ProfileInfo[] {
    return [{ id: DEFAULT_PROFILE_ID, ...this.stored.default, claudeDir: null }, ...this.stored.profiles];
  }

  get(id: string): ProfileInfo | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  // 足す。設定のフォルダが無ければ作る（自分だけが読み書きできる権限）。ほかのプロファイルと同じフォルダは断る
  add(input: NewProfile): ProfileInfo {
    const name = checkName(input.name);
    const claudeDir = resolveDir(input.claudeDir);
    const taken = [claudeConfigDir(), ...this.stored.profiles.map((p) => p.claudeDir!)].map((d) => normalize(d));
    if (taken.includes(claudeDir)) throw new Error(`ほかのプロファイルと同じフォルダです: ${claudeDir}`);
    let info: ReturnType<typeof statSync> | null = null;
    try {
      info = statSync(claudeDir);
    } catch {
      mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    }
    if (info && !info.isDirectory()) throw new Error(`フォルダではありません: ${claudeDir}`);
    const profile: ProfileInfo = { id: randomUUID(), name, color: checkColor(input.color), claudeDir };
    this.save({ ...this.stored, profiles: [...this.stored.profiles, profile] });
    return profile;
  }

  // 名前と色を変える（設定のフォルダは変えない）
  update(id: string, patch: { name?: string; color?: string }): ProfileInfo {
    const current = this.get(id);
    if (!current) throw new Error('プロファイルが見つかりません');
    const next = {
      name: patch.name === undefined ? current.name : checkName(patch.name),
      color: patch.color === undefined ? current.color : checkColor(patch.color),
    };
    if (id === DEFAULT_PROFILE_ID) this.save({ ...this.stored, default: next });
    else this.save({ ...this.stored, profiles: this.stored.profiles.map((p) => (p.id === id ? { ...p, ...next } : p)) });
    return this.get(id)!;
  }

  // 登録から外す。設定のフォルダとアプリのデータは消さない（もう一度足せば、同じフォルダのログインのまま使える）
  remove(id: string): void {
    if (id === DEFAULT_PROFILE_ID) throw new Error('標準のプロファイルは外せません');
    this.save({ ...this.stored, profiles: this.stored.profiles.filter((p) => p.id !== id) });
  }

  private save(next: Stored): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
    this.stored = next;
  }
}

// 足したプロファイルのデータ（セッションの一覧・ソケットなど）を置くフォルダ。既定のプロファイルは userData そのもの
export function profileDataDir(userData: string, id: string): string {
  return id === DEFAULT_PROFILE_ID ? userData : join(userData, 'profiles', id);
}

function checkName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new Error('名前を入れてください');
  return trimmed.slice(0, MAX_NAME);
}

function checkColor(color: unknown): string {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : PROFILE_COLORS[0];
}

// ~/ で始まるパスはホームから。それ以外は絶対パスだけ
function resolveDir(path: unknown): string {
  const raw = typeof path === 'string' ? path.trim() : '';
  const absolute = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  if (!absolute || !isAbsolute(absolute)) throw new Error('フォルダは絶対パスか ~/ で始まるパスで指定してください');
  return normalize(absolute).replace(/\/+$/, '');
}

function load(file: string): Stored {
  const fallback: Stored = { default: { name: DEFAULT_NAME, color: PROFILE_COLORS[0] }, profiles: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>;
    const def = raw.default;
    const profiles = Array.isArray(raw.profiles)
      ? raw.profiles.filter(
          (p): p is ProfileInfo =>
            !!p && typeof p.id === 'string' && p.id !== DEFAULT_PROFILE_ID && typeof p.name === 'string' && typeof p.claudeDir === 'string' && isAbsolute(p.claudeDir),
        )
      : [];
    return {
      default: { name: typeof def?.name === 'string' && def.name.trim() ? def.name : DEFAULT_NAME, color: checkColor(def?.color) },
      profiles: profiles.map((p) => ({ id: p.id, name: p.name, color: checkColor(p.color), claudeDir: p.claudeDir })),
    };
  } catch {
    return fallback;
  }
}
