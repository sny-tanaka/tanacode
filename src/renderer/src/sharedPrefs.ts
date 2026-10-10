import { useEffect, useRef } from 'react';
import { isSharedPrefKey, SHARED_PREF_KEYS, type SharedPrefKey, type SharedPrefs } from '@shared/prefs';

// プロファイルをまたいで同じにする表示設定（カラムの幅など。キーは shared/prefs.ts）。
// 画面はプロファイルごとにあり、足したプロファイルの画面は localStorage が別。そのままだと、切り替えるたびに幅などが変わってしまう。
// 値は今までどおり localStorage から待たずに読み、書くときに main にも渡す。main は覚えて、ほかのプロファイルの画面に配る

const listeners = new Map<SharedPrefKey, Set<() => void>>();

export function readSharedPref(key: SharedPrefKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSharedPref(key: SharedPrefKey, value: string): void {
  try {
    localStorage.setItem(key, value);
    window.tanacode.prefs.set(key, value);
  } catch {
    // 保存できなくても今の表示には影響しない
  }
}

// ほかのプロファイルの画面で変わった値を、この画面の localStorage に入れて、使っている部品に知らせる
function receive(key: SharedPrefKey, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

// 起動したとき、描く前に main の値にそろえる。main がまだ覚えていないものは、この画面の値を渡す（今までの値を引き継ぐ）
export async function syncSharedPrefs(): Promise<void> {
  const local: SharedPrefs = {};
  for (const key of SHARED_PREF_KEYS) {
    const value = readSharedPref(key);
    if (value !== null) local[key] = value;
  }
  window.tanacode.prefs.onChanged(({ key, value }) => {
    if (isSharedPrefKey(key)) receive(key, value);
  });
  try {
    const shared = await window.tanacode.prefs.sync(local);
    for (const key of SHARED_PREF_KEYS) {
      const value = shared[key];
      if (value !== undefined && value !== local[key]) receive(key, value);
    }
  } catch {
    // そろえられなくても、この画面の値で描く
  }
}

// ほかのプロファイルの画面で値が変わったら、読み直す
export function useSharedPrefChange(key: SharedPrefKey, onChange: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const listener = () => latest.current();
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
    };
  }, [key]);
}
