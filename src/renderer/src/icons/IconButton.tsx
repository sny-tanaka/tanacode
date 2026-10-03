import type { ButtonHTMLAttributes } from 'react';
import type { IconComponent } from './icons';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children' | 'aria-label'> & {
  icon: IconComponent;
  // ボタンの名前。読み上げ（aria-label）とツールチップ（data-tip）に同じ文字が付く。title は遅いので使わない
  label: string;
  // ツールチップに出す文字が名前と違うとき（ショートカットや補足を添える）
  tip?: string;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
  // sm: タブ・行の中（20px の枠に 12px の絵）。md: ツールバー（26px の枠に 14px の絵）
  size?: 'sm' | 'md';
  // 押すと元に戻せない・止める操作。hover で赤くする
  danger?: boolean;
  // トグルの入っている間（aria-pressed と色）
  pressed?: boolean;
  // 実行中。回る輪に替えて押せなくする
  busy?: boolean;
  // 行や見出しにホバーしたときだけ出す（キーボードのフォーカスでも出る）
  reveal?: boolean;
};

// アイコンだけのボタン。見た目・名前・ツールチップを 1 か所にそろえるので、アイコンのボタンはこれで作る
export function IconButton({ icon: Icon, label, tip, tipSide, size = 'md', danger, pressed, busy, reveal, className, disabled, type = 'button', ...rest }: Props) {
  const classes = ['icon-button', size, danger && 'danger', pressed && 'on', busy && 'busy', reveal && 'reveal', className].filter(Boolean).join(' ');
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      data-tip={tip ?? label}
      data-tip-side={tipSide}
    >
      {busy ? <span className="spinner" /> : <Icon size={size === 'sm' ? 12 : 14} />}
    </button>
  );
}
