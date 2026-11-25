import { IpcChannel, type IpcEvent } from './ipc';

// main → 画面の知らせ（IpcEvent）を、遠隔の接続（スマホ）にも送るか（Issue #464）。
// send: 送る（その接続に許したプロファイルの知らせだけ）
// subscribe: 多い・大きいもの。スマホがその画面を開いて頼んだ間だけ送る（通信量を増やさないため）
// mac: Mac の画面だけのもの（メニューバーから開くダイアログ・Mac のキーボードの操作・Mac の画面の webview の扱いなど）。送らない
// チャンネルを足したら、ここにも足す（足し忘れは型チェックで止まる）
export type RemoteEventUse = 'send' | 'subscribe' | 'mac';

export const REMOTE_EVENTS: { readonly [C in keyof IpcEvent]: RemoteEventUse } = {
  [IpcChannel.SessionsChanged]: 'send',
  [IpcChannel.SessionsCreateFailed]: 'send',
  // Mac の通知を押したときに、Mac の画面でそのセッションを選ぶ
  [IpcChannel.SessionsSelect]: 'mac',
  // Mac のメニューバー・キーボードの操作で、Mac の画面に新規セッションの画面を出す
  [IpcChannel.SessionsNew]: 'mac',
  [IpcChannel.ChatEvents]: 'send',
  [IpcChannel.SessionsProgress]: 'send',
  [IpcChannel.QuestionChanged]: 'send',
  [IpcChannel.PermissionChanged]: 'send',
  [IpcChannel.ElicitationChanged]: 'send',
  [IpcChannel.WorkflowsChanged]: 'send',
  [IpcChannel.SubagentsChanged]: 'send',
  [IpcChannel.UsageChanged]: 'send',
  [IpcChannel.ProfilesChanged]: 'send',
  [IpcChannel.PrefsChanged]: 'send',
  [IpcChannel.ScheduledChanged]: 'send',
  // 2 秒ごとに届く
  [IpcChannel.SystemStats]: 'subscribe',
  [IpcChannel.ClaudeVersionChanged]: 'send',
  [IpcChannel.ClaudeVerifiedChanged]: 'send',
  [IpcChannel.AppUpdateChanged]: 'send',
  // メニューバーの「更新を確認」の結果
  [IpcChannel.AppUpdateChecked]: 'mac',
  [IpcChannel.StatusLineChanged]: 'send',
  [IpcChannel.SettingsFilesChanged]: 'send',
  [IpcChannel.KnowledgeChanged]: 'send',
  [IpcChannel.TasksBashChanged]: 'send',
  // ターミナルの出力。スマホがそのターミナルを見ている間だけ
  [IpcChannel.PtyData]: 'subscribe',
  [IpcChannel.ShellData]: 'subscribe',
  [IpcChannel.ShellExit]: 'send',
  [IpcChannel.ShellOpened]: 'send',
  [IpcChannel.FilesChanged]: 'send',
  [IpcChannel.ChecklistChanged]: 'send',
  [IpcChannel.WalkthroughChanged]: 'send',
  [IpcChannel.CompactChanged]: 'send',
  // Mac の画面の webview（アプリ内ブラウザのタブ）を開く・選ぶ・閉じる・映す。スマホのアプリ内ブラウザは段階 3 で作る
  [IpcChannel.BrowserOpen]: 'mac',
  [IpcChannel.BrowserNewTab]: 'mac',
  [IpcChannel.BrowserSelectTab]: 'mac',
  [IpcChannel.BrowserCloseTab]: 'mac',
  [IpcChannel.BrowserPopups]: 'send',
  // ポップアップの絵（画素）。段階 3 で、スマホが映している間だけ送る
  [IpcChannel.BrowserPopupFrame]: 'subscribe',
  [IpcChannel.BrowserPopupCursor]: 'mac',
  [IpcChannel.BrowserActivity]: 'send',
  [IpcChannel.BrowserViewport]: 'mac',
  [IpcChannel.BrowserThrottle]: 'mac',
  // メニューバーから開くダイアログ・Mac のキーボードの操作
  [IpcChannel.PromptsOpen]: 'mac',
  [IpcChannel.McpSettingsOpen]: 'mac',
  [IpcChannel.RemoteSettingsOpen]: 'mac',
  [IpcChannel.ShortcutRun]: 'mac',
  [IpcChannel.BrowserAsk]: 'send',
  [IpcChannel.BrowserLogin]: 'send',
  [IpcChannel.BrowserRemember]: 'send',
  // Mac の通知を押したときに、Mac の画面でアプリ内ブラウザを開く
  [IpcChannel.BrowserShow]: 'mac',
};
