import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isSharedPrefKey, isSharedPrefValue, SHARED_PREF_KEYS, type SharedPrefChange, type SharedPrefs } from '@shared/prefs';

// プロファイルをまたいで同じにする表示設定（カラムの幅など）。どのプロファイルの画面も、ここの値を使う
export class SharedPrefStore {
  private values: SharedPrefs;

  constructor(private readonly file: string) {
    this.values = load(file);
  }

  all(): SharedPrefs {
    return { ...this.values };
  }

  // 画面が持っている値（local）のうち、まだ覚えていないものを採る。採ったものを返す（先に聞いてきた画面の値が残る）
  adopt(local: unknown): SharedPrefChange[] {
    const adopted: SharedPrefChange[] = [];
    if (!local || typeof local !== 'object') return adopted;
    for (const key of SHARED_PREF_KEYS) {
      const value = (local as Record<string, unknown>)[key];
      if (this.values[key] === undefined && isSharedPrefValue(value)) adopted.push({ key, value });
    }
    if (adopted.length > 0) this.put(adopted);
    return adopted;
  }

  // 変わったときだけ true。知らないキー・形の違う値は覚えない
  set(key: unknown, value: unknown): boolean {
    if (!isSharedPrefKey(key) || !isSharedPrefValue(value) || this.values[key] === value) return false;
    this.put([{ key, value }]);
    return true;
  }

  private put(changes: SharedPrefChange[]): void {
    for (const { key, value } of changes) this.values[key] = value;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, values: this.values }, null, 2));
      renameSync(tmp, this.file);
    } catch {
      // 保存できなくても、アプリが動いている間はどの画面も同じ値になる
    }
  }
}

// 無い・読めないときは空（画面が持っている値を採るところから始める）
function load(file: string): SharedPrefs {
  const values: SharedPrefs = {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { values?: Record<string, unknown> };
    for (const key of SHARED_PREF_KEYS) {
      const value = data.values?.[key];
      if (isSharedPrefValue(value)) values[key] = value;
    }
  } catch {
    // 空で始める
  }
  return values;
}
