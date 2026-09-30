// 終わったことを示す印。丸と中のチェックを、成功の色（--ok）の線で描く（グラデーションは進行中の印に使うので使わない）。
// animate: 丸 → チェックの順に線を描いて見せる（終わった瞬間だけ。あとから開いたときは描き終えた形で出す）。
// failed: 失敗・停止。赤い ✕ にする。
// slot: 置き換える印（状態の丸など）の大きさ。指定すると、その大きさの場所に重ねて描き、まわりの文字の位置を動かさない
export function CheckMark({ animate = false, failed = false, slot }: { animate?: boolean; failed?: boolean; slot?: number }) {
  const stroke = failed ? 'var(--danger)' : 'var(--ok)';
  const mark = (
    <svg className={`check-mark${animate ? ' animate' : ''}`} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.5" stroke={stroke} />
      <path d={failed ? 'M5.8 5.8 L10.2 10.2 M10.2 5.8 L5.8 10.2' : 'M5 8.3 L7.2 10.5 L11 6.2'} stroke={stroke} />
    </svg>
  );
  if (slot === undefined) return mark;
  return (
    <span className="check-slot" style={{ width: slot, height: slot }}>
      {mark}
    </span>
  );
}
