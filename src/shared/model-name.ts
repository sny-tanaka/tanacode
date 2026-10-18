// 応答のモデルの ID を表示名にする（例: claude-sonnet-5 → Sonnet 5、claude-fable-5-1 → Fable 5.1）。読めなければ null
export function modelName(id: string | null | undefined): string | null {
  // 新しい系統名のモデルにも対応できるよう、名前は決め打ちしない。
  // 小数点以下は 1 桁の数字だけ（claude-sonnet-5-20260101 の日付の先頭の 2 を、小数点以下と読まない）
  const m = id?.match(/^claude-([a-z]+)-(\d+)(?:-(\d)(?!\d))?(?:-\d{8})?/);
  if (!m) return null;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}
