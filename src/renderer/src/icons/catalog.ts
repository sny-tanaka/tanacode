import * as all from './icons';
import type { IconComponent } from './icons';

// アイコンの一覧（意味ごと）。Storybook の「カタログ/アイコン」と、test/icons.test.ts が使う。
// 新しいアイコンは、ここに意味といっしょに足す（足し忘れは test/icons.test.ts が教える）
export type IconEntry = { name: string; meaning: string; Icon: IconComponent };
export type IconGroup = { title: string; items: IconEntry[] };

const item = (name: Extract<keyof typeof all, string>, meaning: string): IconEntry => ({ name, meaning, Icon: all[name] as IconComponent });

export const ICON_GROUPS: IconGroup[] = [
  {
    title: 'パネル（アクティビティバー）',
    items: [
      item('FilesIcon', 'エクスプローラー'),
      item('SearchIcon', '検索'),
      item('BranchIcon', 'ソース管理・今のブランチ'),
      item('TasksIcon', 'タスク'),
    ],
  },
  {
    title: 'Git',
    items: [
      item('WorktreeIcon', 'worktree'),
      item('DefaultBranchIcon', '最新のデフォルトブランチへ切り替える'),
      item('FetchIcon', 'フェッチ'),
      item('PullIcon', 'プル'),
      item('PushIcon', 'プッシュ'),
      item('CommitIcon', 'コミット'),
      item('UndoIcon', '変更を破棄'),
      item('DiffIcon', '差分'),
      item('ColumnsIcon', '左右に並べる'),
      item('RowsIcon', '差分を 1 列にする'),
      item('ListViewIcon', '一覧で表示'),
      item('TreeViewIcon', 'ツリーで表示'),
    ],
  },
  {
    title: '操作',
    items: [
      item('CloseIcon', '閉じる・外す・取り消す'),
      item('AddIcon', '追加・ステージする'),
      item('MinusIcon', 'ステージから外す'),
      item('TrashIcon', '削除'),
      item('ArchiveIcon', 'アーカイブ'),
      item('UnarchiveIcon', 'アーカイブから戻す'),
      item('ReloadIcon', '更新・再読み込み・もう一度・再起動'),
      item('StopIcon', '止める'),
      item('PlayIcon', '実行'),
      item('SendIcon', '送る'),
      item('CompressIcon', '会話を圧縮'),
      item('RewindIcon', 'ここまで戻す'),
      item('ExternalLinkIcon', '別の場所で開く'),
      item('CodeIcon', '開発者ツール・ソース'),
      item('EyeIcon', 'プレビュー'),
      item('PointerIcon', 'ページの要素を選ぶ'),
    ],
  },
  {
    title: '向き',
    items: [
      item('ArrowUpIcon', '上へ・前のファイル'),
      item('ArrowDownIcon', '下へ・次のファイル・最新へ'),
      item('ArrowLeftIcon', '戻る'),
      item('ArrowRightIcon', '進む'),
      item('ChevronRightIcon', '展開・開く（開いたら 90 度回す）'),
      item('ChevronDownIcon', 'プルダウン'),
      item('DownloadIcon', '新しいバージョンをダウンロード'),
    ],
  },
  {
    title: '状態',
    items: [
      item('CheckIcon', '成功'),
      item('CheckCircleIcon', '完了・最新'),
      item('ErrorCircleIcon', '失敗'),
      item('InfoCircleIcon', '情報'),
      item('AlertCircleIcon', '注意'),
      item('ArrowUpCircleIcon', '新しいバージョンがある'),
      item('ArrowDownCircleIcon', '古いバージョン'),
      item('WarningIcon', '警告・エラーの件数'),
    ],
  },
  {
    title: 'もの',
    items: [
      item('FolderIcon', 'フォルダ'),
      item('FileIcon', 'ファイル'),
      item('GlobeIcon', 'ブラウザ'),
      item('TerminalIcon', 'ターミナル（下のパネル）'),
      item('MonitorIcon', 'Claude の画面'),
      item('FlowIcon', 'ワークフローの概要'),
      item('RemoteIcon', 'Remote Control'),
      item('BellIcon', '通知'),
      item('LockIcon', 'ロック中'),
      item('UnlockIcon', 'ロックしていない'),
    ],
  },
];

export const ICON_ENTRIES: IconEntry[] = ICON_GROUPS.flatMap((g) => g.items);
