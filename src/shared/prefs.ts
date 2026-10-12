// プロファイルをまたいで同じにする表示設定（カラムの幅など）。足したプロファイルの画面は localStorage が別なので、
// main が 1 つのファイル（userData の shared-prefs.json）に覚え、どの画面にも同じ値を配る。
// キーは画面の localStorage のキーと同じ。値は localStorage に入れる文字列のまま
export const SHARED_PREF_KEYS = [
  'tanacode.columns',
  'tanacode.terminalHeight',
  'tanacode.terminalMode',
  'tanacode.scmView',
  'tanacode.contextSort',
  'tanacode.checklist.notify',
  'tanacode.app-update.seen',
] as const;

export type SharedPrefKey = (typeof SHARED_PREF_KEYS)[number];
export type SharedPrefs = Partial<Record<SharedPrefKey, string>>;
export type SharedPrefChange = { key: SharedPrefKey; value: string };

// 値の長さの上限（どれも短い。画面から届いたものを、そのままファイルに書くため）
export const SHARED_PREF_MAX_LENGTH = 1000;

export function isSharedPrefKey(key: unknown): key is SharedPrefKey {
  return typeof key === 'string' && (SHARED_PREF_KEYS as readonly string[]).includes(key);
}

export function isSharedPrefValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SHARED_PREF_MAX_LENGTH;
}
