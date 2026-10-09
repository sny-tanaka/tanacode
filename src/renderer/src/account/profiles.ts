import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ProfilesState } from '@shared/profile';

// プロファイル（Claude Code のアカウントごとの環境）の様子。この画面のプロファイル（current）と、
// ほかのプロファイルに見てほしいものがあるか（othersAttention。どのプロファイルかは分からない）
export function useProfiles(): ProfilesState | null {
  const [state, setState] = useState<ProfilesState | null>(null);
  useEffect(() => {
    let alive = true;
    void window.tanacode.profiles.get().then((s) => alive && s && setState(s));
    const off = window.tanacode.profiles.onChanged(setState);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

// プロファイルの管理ダイアログ（App が 1 つだけ置く）。add: 足す欄を開いた状態で開く
export type ProfilesDialogMode = 'manage' | 'add';

let dialogMode: ProfilesDialogMode | null = null;
const dialogListeners = new Set<() => void>();

function setDialogMode(mode: ProfilesDialogMode | null) {
  if (dialogMode === mode) return;
  dialogMode = mode;
  dialogListeners.forEach((listener) => listener());
}

export function openProfilesDialog(mode: ProfilesDialogMode = 'manage') {
  setDialogMode(mode);
}

export function closeProfilesDialog() {
  setDialogMode(null);
}

export function useProfilesDialog(): ProfilesDialogMode | null {
  return useSyncExternalStore(
    (listener) => {
      dialogListeners.add(listener);
      return () => dialogListeners.delete(listener);
    },
    () => dialogMode,
  );
}

// 足すときの Claude Code の設定のフォルダの既定。名前が英数字なら ~/.claude-<名前>、そうでなければ ~/.claude-profile-<番号>
export function defaultClaudeDir(name: string, taken: readonly (string | null)[]): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const used = new Set(taken.filter((d): d is string => !!d).map((d) => d.replace(/^\/Users\/[^/]+/, '~')));
  if (slug && !used.has(`~/.claude-${slug}`)) return `~/.claude-${slug}`;
  for (let n = 2; ; n++) if (!used.has(`~/.claude-profile-${n}`)) return `~/.claude-profile-${n}`;
}
