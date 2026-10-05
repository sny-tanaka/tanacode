import type { ReactNode } from 'react';

// アプリのアイコンは、すべてここに自作の線画で置く（外部のアイコン集は使わない。写しもなぞりもしない）。
// 描き方の決まり（方眼・余白・部品・線・塗り・角・矢印・すきま）と手順は CONTRIBUTING.md の「アイコン」に書いてある。主な点:
// - 24×24 の方眼。絵は 2.5〜21.5 の内側。部品は path・circle・rect だけ。線は currentColor（色は文字色）で、端と角は丸める
// - 大きさは 12・14・16・22 の 4 段階だけ（IconSize）。線の太さは大きさごとに決めてあり、画面の上の太さがそろう
// - 1 つの意味に 1 つのアイコン。意味を表す名前を付ける（見た目の名前にはしない）。同じ意味のものを別に描かない
// - 新しく描いたら catalog.ts に足す（Storybook の「カタログ/アイコン」で、12px まで潰れていないか確かめる）
// - 決まりのうち機械で確かめられるものは test/icons.test.ts が見る
// - ボタンにするときは IconButton を使う（名前とツールチップが必ず付く）

export type IconSize = 12 | 14 | 16 | 22;
export type IconProps = { size?: IconSize };
export type IconComponent = (props: IconProps) => React.JSX.Element;

// 小さいほど太く（画面の上の線が 1.1〜1.6px になる）
export const STROKE: Record<IconSize, number> = { 12: 2.2, 14: 2, 16: 1.9, 22: 1.7 };

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE[size]}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

// 状態の印の小さい点（塗りつぶし）
const Dot = ({ cx, cy, r = 1 }: { cx: number; cy: number; r?: number }) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

// ---- パネル（アクティビティバー） ----

export const FilesIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
    <path d="M14 3v4h4" />
    <path d="M9 21h8a2 2 0 0 0 2-2V9" opacity="0.5" />
  </Svg>
);

export const SearchIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Svg>
);

// ソース管理・今のブランチ
export const BranchIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="7" cy="5.5" r="2" />
    <circle cx="7" cy="18.5" r="2" />
    <circle cx="17" cy="8.5" r="2" />
    <path d="M7 7.5v9" />
    <path d="M17 10.5c0 3-2.5 4-6 4.5-2 .3-4 1-4 1.5" />
  </Svg>
);

// タスク: 重なったカードと、動いていることを示す点
export const TasksIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M7 5h10" />
    <path d="M8 12.5h5M8 16h8" />
    <Dot cx={16.5} cy={12.5} />
  </Svg>
);

// コンテキスト: 枠（コンテキスト）の中に、大きさの違う中身が並ぶ
export const ContextIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
    <path d="M7.75 7.75h8.5M7.75 12h5.5M7.75 16.25h2.5" />
  </Svg>
);

// ---- Git ----

// worktree: 1 つの幹から 2 つに分かれる（ブランチの印とは別の形）
export const WorktreeIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="5" r="2" />
    <circle cx="12" cy="19" r="2" />
    <path d="M6 7v1.5A2.5 2.5 0 0 0 8.5 11h7A2.5 2.5 0 0 0 18 8.5V7" />
    <path d="M12 11v6" />
  </Svg>
);

// 最新のデフォルトブランチへ切り替える: 家（帰る場所）に下向きの矢印
export const DefaultBranchIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3 11 12 3l9 8" />
    <path d="M5 9.5V20h14V9.5" />
    <path d="M12 10.5v6" />
    <path d="M9.5 14 12 16.5 14.5 14" />
  </Svg>
);

// フェッチ: リモートの最新の情報を取ってくる（雲から下へ）
export const FetchIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M7 17.5a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 9.5a4 4 0 0 1-1 8" />
    <path d="M12 12v8.5" />
    <path d="M9 17.5l3 3 3-3" />
  </Svg>
);

// プル: 矢印が線（手元のブランチ）へ下りる
export const PullIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 3.5v11" />
    <path d="M7.5 10.5 12 15l4.5-4.5" />
    <path d="M5 20h14" />
  </Svg>
);

// プッシュ: 矢印が線（リモート）へ上がる
export const PushIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M5 4h14" />
    <path d="M12 20.5v-11" />
    <path d="M7.5 13.5 12 9l4.5 4.5" />
  </Svg>
);

// コミット: 履歴の線（左右）の上の、コミットの丸
export const CommitIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 12h6M15 12h6" />
  </Svg>
);

// 変更を破棄: 元に戻す矢印
export const UndoIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

// 差分: 枠の中の + と −
export const DiffIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
    <path d="M12 7.5v5M9.5 10h5" />
    <path d="M9.5 16h5" />
  </Svg>
);

// 差分の見せ方: 左右に並べる（枠を縦に割る）と、1 列にそろえる（枠を横に割る）
export const ColumnsIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M12 4v16" />
  </Svg>
);

export const RowsIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M3 12h18" />
  </Svg>
);

// ソース管理の見せ方: ファイルの一覧（同じ幅の行が並ぶ）と、フォルダごとのツリー（下の行ほど右に下がる）
export const ListViewIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);

export const TreeViewIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 6h16" />
    <path d="M8 6v12M8 12h12M8 18h12" />
  </Svg>
);

// ---- 操作 ----

export const CloseIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const AddIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const MinusIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);

export const TrashIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M9.5 7V4.5h5V7" />
    <path d="M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7" />
    <path d="M10 11v5M14 11v5" />
  </Svg>
);

export const ArchiveIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="4.5" rx="1.2" />
    <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5" />
    <path d="M10 12.5h4" />
  </Svg>
);

// アーカイブから戻す: 箱から上へ
export const UnarchiveIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="4.5" rx="1.2" />
    <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5" />
    <path d="M12 17v-6M9 13.5l3-3 3 3" />
  </Svg>
);

// 更新・再読み込み・もう一度・再起動: 時計回りの矢印
export const ReloadIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5" />
    <path d="M20 3.5v5h-5" />
  </Svg>
);

// 止める: 角の丸い四角（塗りつぶし）
export const StopIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />
  </Svg>
);

// 実行: 右向きの三角（塗りつぶし）
export const PlayIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
  </Svg>
);

// 送る: 紙飛行機
export const SendIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M21 3 10.5 13.5" />
    <path d="M21 3l-6.8 18-3.7-7.5L3 9.8z" />
  </Svg>
);

// 予約: 時計（時刻を指定して送る）
export const ScheduleIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Svg>
);

// 圧縮: 上下から中心へ
export const CompressIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 3v5M9.5 5.5 12 8l2.5-2.5" />
    <path d="M12 21v-5M9.5 18.5 12 16l2.5 2.5" />
    <path d="M4 12h16" />
  </Svg>
);

// ここまで戻す: 反時計回りの矢印と時計
export const RewindIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
    <path d="M3.5 3.5v5h5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

// 別の場所で開く: 枠から右上へ
export const ExternalLinkIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M13 4h7v7" />
    <path d="M20 4l-9 9" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Svg>
);

// 作業を書き出す: 紙から右へ出る矢印
export const ExportIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M15 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-3" />
    <path d="M9 12h12" />
    <path d="M18 9l3 3-3 3" />
  </Svg>
);

// プレビュー（見え方を確かめる）: 目
export const EyeIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

// 開発者ツール: < / >
export const CodeIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13" />
  </Svg>
);

// 翻訳: 左上に「文」、右下に「A」
export const TranslateIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3.5 6h9M8 3.5V6" />
    <path d="M10.5 6c-.6 3.2-2.6 5.6-6 7.5M5.5 6c.6 3.2 2.6 5.6 6 7.5" />
    <path d="M12.5 21l4-10 4 10M14 17.5h5" />
  </Svg>
);

// 要素を選ぶ: 点線の枠とカーソル
export const PointerIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="14" height="14" rx="2" strokeDasharray="2.6 2.6" />
    <path d="M11.5 11.5 21 15l-4 1.8L15 21z" />
  </Svg>
);

// ---- 向き ----

export const ArrowUpIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);

export const ArrowDownIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);

export const ArrowLeftIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const ArrowRightIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

// 展開・「開く」: 右向き。開いたら 90 度回す（DisclosureIcon が回す）
export const ChevronRightIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

// プルダウン（選ぶと一覧が開く）
export const ChevronDownIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

// 新しいバージョンをダウンロードする: 受け皿へ下向き
export const DownloadIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5" />
    <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
  </Svg>
);

// ---- 状態 ----

export const CheckIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M5 12.5l4.8 4.8L19 7.5" />
  </Svg>
);

export const CheckCircleIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.3 2.8 2.8L16 9.6" />
  </Svg>
);

export const ErrorCircleIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
  </Svg>
);

export const InfoCircleIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.2" />
    <Dot cx={12} cy={7.9} />
  </Svg>
);

export const AlertCircleIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.2" />
    <Dot cx={12} cy={16.3} />
  </Svg>
);

export const ArrowUpCircleIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16V8.5M8.5 11.8 12 8.3l3.5 3.5" />
  </Svg>
);

export const ArrowDownCircleIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v7.5M8.5 12.2l3.5 3.5 3.5-3.5" />
  </Svg>
);

// 警告
export const WarningIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M10.3 4.3 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4.5" />
    <Dot cx={12} cy={17} r={0.9} />
  </Svg>
);

// ---- もの ----

export const FolderIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const FileIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);

export const GlobeIcon: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z" />
  </Svg>
);

// ターミナル（下のパネル）
export const TerminalIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M7 10l3 2.5L7 15" />
    <path d="M12.5 15.5H17" />
  </Svg>
);

// Claude の画面（Claude Code が描いている画面そのもの）
export const MonitorIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2.5" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
);

// ワークフローの概要（フロー図）: 左の箱から右の 2 つの箱へ線が分かれる
export const FlowIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="9.5" width="6" height="5" rx="1.2" />
    <rect x="15" y="4" width="6" height="5" rx="1.2" />
    <rect x="15" y="15" width="6" height="5" rx="1.2" />
    <path d="M9 12h2.5a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 1 1.5-1.5H15M13 12v3.5a1.5 1.5 0 0 0 1.5 1.5H15" />
  </Svg>
);

// Remote Control: スマホと、そこへ届く電波
export const RemoteIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="4" y="5" width="10" height="16" rx="2" />
    <path d="M8 18h2" />
    <path d="M17 8.5a3.5 3.5 0 0 1 0 5" />
    <path d="M19.6 6a7 7 0 0 1 0 10" />
  </Svg>
);

// 通知: ベル
export const BellIcon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Svg>
);

// 錠: 閉じた錠（ロック中）と、開いた錠
export const LockIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Svg>
);

export const UnlockIcon: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7" />
  </Svg>
);
