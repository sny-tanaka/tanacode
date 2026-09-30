import type { ReactNode } from 'react';

// オン・オフを切り替えるスイッチ（ヘッダーのボタンと並べる大きさ）。label は文字かアイコン（アイコンなら name に名前を渡す）。
// busy のあいだは切り替えの途中なので、つまみの横にぐるぐるを出して押せなくする
export function Toggle({
  label,
  name,
  on,
  disabled = false,
  busy = false,
  title,
  onChange,
}: {
  label: ReactNode;
  // 読み上げる名前（label がアイコンのとき）
  name?: string;
  on: boolean;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      className={`toggle${on ? ' on' : ''}`}
      disabled={disabled || busy}
      data-tip={title}
      onClick={() => onChange(!on)}
    >
      <span className={`toggle-label${busy && typeof label === 'string' ? ' flow-text' : ''}`}>{label}</span>
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      {busy && <span className="spinner" aria-hidden />}
    </button>
  );
}
