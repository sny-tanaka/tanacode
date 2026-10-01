// サイドパネルの切り替えアイコン（線画。色は文字色を使う）
const common = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function FilesIcon() {
  return (
    <svg {...common}>
      <path d="M14 3H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
      <path d="M14 3v4h4" />
      <path d="M9 21h8a2 2 0 0 0 2-2V9" opacity="0.5" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg {...common}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </svg>
  );
}

// ワークフローの概要（フロー図）: 左の箱から右の 2 つの箱へ線が分かれる。size で大きさを変えられる
export function FlowIcon({ size = 22 }: { size?: number }) {
  return (
    <svg {...common} width={size} height={size} aria-hidden>
      <rect x="3" y="9.5" width="6" height="5" rx="1.2" />
      <rect x="15" y="4" width="6" height="5" rx="1.2" />
      <rect x="15" y="15" width="6" height="5" rx="1.2" />
      <path d="M9 12h2.5a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 1 1.5-1.5H15M13 12v3.5a1.5 1.5 0 0 0 1.5 1.5H15" />
    </svg>
  );
}

// タスク: 重なったカードと、動いていることを示す点
export function TasksIcon() {
  return (
    <svg {...common}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M7 5h10" />
      <path d="M8 12.5h5M8 16h8" />
      <circle cx="16.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ソース管理: ブランチ
export function BranchIcon() {
  return (
    <svg {...common}>
      <circle cx="7" cy="5.5" r="2" />
      <circle cx="7" cy="18.5" r="2" />
      <circle cx="17" cy="8.5" r="2" />
      <path d="M7 7.5v9" />
      <path d="M17 10.5c0 3-2.5 4-6 4.5-2 .3-4 1-4 1.5" />
    </svg>
  );
}

// フォルダ（新規セッションの作業フォルダ）
export function FolderIcon() {
  return (
    <svg {...common}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// Remote Control: スマホと、そこへ届く電波（ヘッダーのトグルに使う小さいアイコン）
export function RemoteIcon({ size = 22 }: { size?: number }) {
  return (
    <svg {...common} width={size} height={size} aria-hidden>
      <rect x="4" y="5" width="10" height="16" rx="2" />
      <path d="M8 18h2" />
      <path d="M17 8.5a3.5 3.5 0 0 1 0 5" />
      <path d="M19.6 6a7 7 0 0 1 0 10" />
    </svg>
  );
}

// 錠: セッション一覧の並びのロック。locked で閉じた錠、そうでなければ開いた錠
export function LockIcon({ locked, size = 22 }: { locked: boolean; size?: number }) {
  return (
    <svg {...common} width={size} height={size} aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d={locked ? 'M8 10.5V7.5a4 4 0 0 1 8 0v3' : 'M8 10.5V7.5a4 4 0 0 1 7.6-1.7'} />
    </svg>
  );
}

// 通知: ベル（タイトルバーの通知トグルに使う小さいアイコン）
export function BellIcon({ size = 22 }: { size?: number }) {
  return (
    <svg {...common} width={size} height={size} aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
