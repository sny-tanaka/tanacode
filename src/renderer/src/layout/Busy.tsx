import type { ReactNode } from 'react';

// 進行中・処理中の表示。グラデーションのぐるぐると、グラデーションが流れる文字の組（アプリの中でこの見せ方にそろえる）
export function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="busy">
      <span className="spinner" />
      <span className="flow-text">{children}</span>
    </span>
  );
}
