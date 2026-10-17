import { readFileSync, renameSync } from 'node:fs';

// アプリが保存している JSON のファイル（チェックリスト・予約したメッセージ）の読み方。
// - 無い（ENOENT。途中のフォルダがファイルで、たどれない ENOTDIR も、ファイルが無いのと同じに扱う）: 空から始め、保存してよい
// - 読めない（権限が無いなど）: 空から始めるが、保存しない（次の保存で、本物のファイルを消さないため。権限が戻れば、また読める）
// - 壊れている（JSON として読めない）: 中身を横（<名前>.broken-<時刻>）に移してから、空から始めて、保存も続ける
//   （元の中身は横に残るので、上書きで失うものは無い）。移せなければ保存しない
// 読めた中身の形が分からない（新しいバージョンのアプリが書いたものなど）ときも、使う側が保存しないようにする（unreadable）
export type SavedJson = { data: unknown; writable: boolean };

export function readSavedJson(file: string, label: string): SavedJson {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // 無い（途中のフォルダがファイルで、たどれないときも）
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { data: null, writable: true };
    return unreadable(file, label, error);
  }
  try {
    return { data: JSON.parse(text) as unknown, writable: true };
  } catch {
    const aside = `${file}.broken-${Date.now()}`;
    try {
      renameSync(file, aside);
    } catch (error) {
      return unreadable(file, label, error);
    }
    console.error(`${label}が壊れていたので、${aside} に移して、空から始めます`);
    return { data: null, writable: true };
  }
}

// 読めない・形の分からないファイル。空から始めるが、上書きしないよう保存しない
export function unreadable(file: string, label: string, error?: unknown): SavedJson {
  console.error(`${label}（${file}）を読めないので、上書きしないよう、このあとの変更は保存しません`, ...(error === undefined ? [] : [error]));
  return { data: null, writable: false };
}
