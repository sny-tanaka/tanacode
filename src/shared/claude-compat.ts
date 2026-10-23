import { compareVersions } from './claude-code';

// tanacode のバージョンと、動作確認済の Claude Code のバージョンの対応表（リポジトリの compat.json）。
// アプリを配信しなくても、動作確認済のバージョンを上げられるように、develop の compat.json を読む（src/main/claude-compat.ts）。
// 形: { "rows": [{ "app": ">=2.2.3 <2.2.4", "claudeCode": "2.1.305" }, { "app": ">=2.2.4", "claudeCode": "2.1.306" }] }
// - app は、そのバージョン以上（と、書いてあればそのバージョン未満）。行は古い順に並べ、範囲は重ねない
// - 書き換えるのは毎日の互換性の確認（scripts/update-verified-version.mjs）
export type CompatRow = { from: string; below: string | null; claudeCode: string };

const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const RANGE = /^>=(\d{1,9}\.\d{1,9}\.\d{1,9})(?: <(\d{1,9}\.\d{1,9}\.\d{1,9}))?$/;
// 外から読むものなので、行の数に上限を付ける（表が変えるのはステータスバーの印だけだが、大きすぎるものは読まない）
const MAX_ROWS = 1000;

// 表を読む。形が少しでも違えば null（そのときは、前に読めた表か、アプリに組み込んだバージョンを使う）
export function parseCompatTable(body: unknown): CompatRow[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) return null;
  const parsed: CompatRow[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
    const { app, claudeCode } = row as { app?: unknown; claudeCode?: unknown };
    if (typeof app !== 'string' || typeof claudeCode !== 'string' || !VERSION.test(claudeCode)) return null;
    const range = RANGE.exec(app);
    if (!range) return null;
    const [, from, below = null] = range;
    if (below !== null && compareVersions(from, below) >= 0) return null;
    // 古い順に並び、前の行と重ならない（前の行に上限が無いのに、後ろに行があるのも重なり）
    const prev = parsed.at(-1);
    if (prev && (prev.below === null || compareVersions(prev.below, from) > 0)) return null;
    parsed.push({ from, below, claudeCode });
  }
  return parsed;
}

// そのバージョンのアプリの、動作確認済の Claude Code のバージョン。表に行が無ければ null
export function verifiedFor(rows: readonly CompatRow[], app: string): string | null {
  const row = rows.find((r) => compareVersions(app, r.from) >= 0 && (r.below === null || compareVersions(app, r.below) < 0));
  return row?.claudeCode ?? null;
}
