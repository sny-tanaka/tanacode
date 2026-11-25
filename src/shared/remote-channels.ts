import { IpcChannel, type IpcInvoke, type IpcSend } from './ipc';

// スマホ（遠隔の接続）から届いた頼みの扱いと、引数の形（Issue #464）。
// 本人確認を通った遠隔の相手は、Mac の画面と同じに扱う（決めたこと）。ここで決めるのは制限ではなく、次の 2 つ。
// - 引数の形: 壊れた頼み（型の違う引数・足りない・多すぎる）で main を落とさないための確かめ。
//   中身の確かめ（値の範囲・パスなど）は、Mac の画面からの頼みと同じく、それぞれの受け口が行う
// - 扱い:
//   same: そのまま受ける
//   replace: Mac にしか無いもの（Mac のダイアログ・Mac の画面の位置など）。スマホ向けに置き換えるまで、遠隔からは呼べない
//   mac: Mac の設定（メニューバーから開くもの）と、Mac の画面にしか意味が無いもの。スマホには出さない
// チャンネルを足したら、ここにも足す。足し忘れと、引数の形が ipc.ts の表の型と食い違うのは、型チェックで止まる

// string・number・boolean: その型 / strings: 文字列の配列 / object: ふつうのオブジェクト（配列・null でない）/
// array: 配列 / bytes: Uint8Array / nullable-*: null も受ける。末尾の ? は省略できる（無い・undefined・null）
type ArgBase = 'string' | 'number' | 'boolean' | 'strings' | 'object' | 'array' | 'bytes' | 'nullable-string' | 'nullable-object';
export type ArgShape = ArgBase | `${ArgBase}?`;

export type RemoteUse = 'same' | 'replace' | 'mac';
export type RemoteChannelSpec = { use: RemoteUse; args: readonly ArgShape[]; reason?: string };

// 遠隔から届きうる頼み（画面 → main の呼び出しと知らせ）
export type RemoteChannel = keyof IpcInvoke | keyof IpcSend;

// チャンネルの受け口の型（引数の形は、ここから決まる）
type ListenerOf<C extends RemoteChannel> = C extends keyof IpcInvoke ? IpcInvoke[C] : C extends keyof IpcSend ? IpcSend[C] : never;

// 1 つの引数の型から、その形（ArgShape）を決める。表の形が型と食い違うと、型チェックで止まる
type ShapeOf<T> = [T] extends [string]
  ? 'string'
  : [T] extends [number]
    ? 'number'
    : [T] extends [boolean]
      ? 'boolean'
      : [T] extends [string[]]
        ? 'strings'
        : [T] extends [Uint8Array]
          ? 'bytes'
          : [T] extends [readonly unknown[]]
            ? 'array'
            : null extends T
              ? [NonNullable<T>] extends [string]
                ? 'nullable-string'
                : 'nullable-object'
              : 'object';

// 引数の並びから、形の並びを決める（省略できる引数は、末尾に ? が付く）
type ShapesOf<P extends readonly unknown[]> = { readonly [K in keyof P]-?: undefined extends P[K] ? `${ShapeOf<Exclude<P[K], undefined>>}?` : ShapeOf<P[K]> };
type SpecOf<C extends RemoteChannel> = { use: RemoteUse; args: ShapesOf<Parameters<ListenerOf<C>>>; reason?: string };

const same = <const A extends readonly ArgShape[]>(args: A) => ({ use: 'same', args }) as const;
const replace = <const A extends readonly ArgShape[]>(args: A, reason: string) => ({ use: 'replace', args, reason }) as const;
const mac = <const A extends readonly ArgShape[]>(args: A, reason: string) => ({ use: 'mac', args, reason }) as const;

const TABLE: { readonly [C in RemoteChannel]: SpecOf<C> } = {
  [IpcChannel.SessionsList]: same([]),
  [IpcChannel.SessionsCreate]: same(['string', 'object']),
  [IpcChannel.SessionsOpen]: same(['string']),
  [IpcChannel.SessionsArchive]: same(['string', 'object?']),
  [IpcChannel.SessionsUnarchive]: same(['string']),
  [IpcChannel.SessionsSnapshot]: same(['string']),
  [IpcChannel.SessionsSubmit]: same(['string', 'string', 'strings', 'strings?', 'object?']),
  [IpcChannel.SessionsConfigure]: same(['string', 'object']),
  [IpcChannel.SessionsModels]: same(['string']),
  [IpcChannel.SessionsRestart]: same(['string']),
  [IpcChannel.SessionsParentInstructions]: same(['string']),
  [IpcChannel.SessionsBecomeParent]: same(['string']),
  [IpcChannel.SessionsSetRemoteControl]: same(['string', 'boolean']),
  [IpcChannel.SessionsSetTerminalMode]: same(['string', 'boolean', 'object?']),
  [IpcChannel.SessionsSetAutoCompact]: same(['string', 'boolean']),
  [IpcChannel.SessionsSetAway]: same(['string', 'boolean']),
  [IpcChannel.RemoteControlAvailable]: same([]),
  [IpcChannel.SessionsRename]: same(['string', 'string']),
  [IpcChannel.SessionsRemove]: same(['string', 'object?']),
  [IpcChannel.SessionsWorktreeLeftovers]: same(['string']),
  [IpcChannel.SessionsWorktreeCleanup]: same([]),
  [IpcChannel.SessionsDeleteBackup]: same(['string', 'string']),
  [IpcChannel.SessionsRemoveLeftWorktree]: same(['string']),
  [IpcChannel.SessionsHistory]: same(['string']),
  [IpcChannel.ChatImage]: same(['string']),
  [IpcChannel.SessionsExportSource]: same(['string']),
  [IpcChannel.SessionsExportSave]: replace(['string', 'string'], '保存先を選ぶ Mac のダイアログ'),
  [IpcChannel.SessionsDiscover]: same([]),
  [IpcChannel.SessionsImport]: same(['object']),
  [IpcChannel.ScreenSetMode]: same(['string', 'string']),
  [IpcChannel.ScreenRewind]: same(['string', 'string', 'object']),
  [IpcChannel.ScreenRewindPreview]: same(['string', 'string']),
  [IpcChannel.SessionsProgressGet]: same(['string']),
  [IpcChannel.QuestionGet]: same(['string']),
  [IpcChannel.QuestionReply]: same(['string', 'string', 'object']),
  [IpcChannel.PermissionGet]: same(['string']),
  [IpcChannel.PermissionReply]: same(['string', 'string', 'object']),
  [IpcChannel.ElicitationGet]: same(['string']),
  [IpcChannel.ElicitationReply]: same(['string', 'string', 'object']),
  [IpcChannel.WorkflowsGet]: same(['string']),
  [IpcChannel.SubagentsGet]: same(['string']),
  [IpcChannel.UsageGet]: same([]),
  [IpcChannel.UsageRefresh]: same([]),
  [IpcChannel.AccountGet]: same([]),
  [IpcChannel.ProfilesGet]: replace([], '開いている全プロファイルを返す（許したプロファイルだけに絞るまで）'),
  [IpcChannel.ProfilesSwitch]: replace(['string'], 'Mac のウインドウに出すプロファイルを切り替える（遠隔の接続のプロファイルは接続で決まる）'),
  [IpcChannel.ProfilesAdd]: replace(['object'], 'プロファイルを足す（許したプロファイルの扱いを決めるまで）'),
  [IpcChannel.ProfilesUpdate]: replace(['string', 'object'], '呼び出し元のプロファイルを見ずに、渡された id のプロファイルを変える（許したプロファイルだけに絞るまで）'),
  [IpcChannel.ProfilesRemove]: replace(['string'], '呼び出し元のプロファイルを見ずに、渡された id のプロファイルを変える（許したプロファイルだけに絞るまで）'),
  [IpcChannel.ProfilesPickDir]: replace([], 'フォルダを選ぶ Mac のダイアログ'),
  [IpcChannel.ScheduledList]: same([]),
  [IpcChannel.ScheduledAdd]: same(['string', 'string', 'strings', 'number', 'strings?']),
  [IpcChannel.ScheduledReschedule]: same(['string', 'number']),
  [IpcChannel.ScheduledEdit]: same(['string', 'string']),
  [IpcChannel.ScheduledSendNow]: same(['string']),
  [IpcChannel.ScheduledCancel]: same(['string']),
  [IpcChannel.PrefsSync]: replace(['object'], 'アプリ全体で 1 つの表示の設定（カラムの幅など）。スマホの値が Mac の全画面に配られる（スマホの画面の値を分けるまで）'),
  [IpcChannel.NotificationsGet]: same([]),
  [IpcChannel.NotificationsSet]: same(['boolean']),
  [IpcChannel.PromptsGet]: mac([], 'メニューバーから開く「Claude に送る文」のダイアログ'),
  [IpcChannel.PromptsUpdate]: mac(['object'], 'メニューバーから開く「Claude に送る文」のダイアログ'),
  [IpcChannel.McpSettingsGet]: mac([], 'メニューバーの「MCP の設定…」で開くダイアログ'),
  [IpcChannel.McpEnabledSet]: mac(['string', 'boolean'], 'メニューバーの「MCP の設定…」で開くダイアログ'),
  [IpcChannel.ToolPermissionsSet]: mac(['string', 'string'], 'メニューバーの「MCP の設定…」で開くダイアログ'),
  [IpcChannel.ParentAskRulesSet]: mac(['boolean'], 'メニューバーの「MCP の設定…」で開くダイアログ'),
  [IpcChannel.RemoteSettingsGet]: mac([], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemoteSettingsSet]: mac(['object'], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemoteDevicesGet]: mac([], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemotePairingStart]: mac([], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemotePairingCancel]: mac([], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemotePairingApprove]: mac(['string', 'string', 'strings'], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemotePairingReject]: mac(['string'], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemoteDeviceRemove]: mac(['string'], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemoteDevicesReset]: mac([], 'メニューバーの「遠隔操作の設定…」で開くダイアログ（遠隔操作の入口の設定は、外から変えさせない）'),
  [IpcChannel.RemoteConnectionsGet]: mac([], 'Mac の上の帯の「遠隔操作中」（スマホから自分を見張る口にしない）'),
  [IpcChannel.RemoteDisconnectAll]: mac([], 'Mac の上の帯の「切断」（Mac の前の人が止めるためのもの）'),
  [IpcChannel.ClaudeVersionGet]: same([]),
  [IpcChannel.ClaudeVerifiedGet]: same([]),
  [IpcChannel.AppUpdateGet]: same([]),
  [IpcChannel.AppUpdateInstall]: mac([], 'アプリを入れ替えて起動し直す（Mac の操作）'),
  [IpcChannel.AppUpdateCheck]: mac([], 'メニューバーの「更新を確認」'),
  [IpcChannel.StatusLineGet]: same(['string']),
  [IpcChannel.SettingsFilesList]: same([]),
  [IpcChannel.SettingsFilesPick]: replace([], 'ファイルを選ぶ Mac のダイアログ'),
  [IpcChannel.SettingsFilesAdd]: same(['string', 'string?']),
  [IpcChannel.SettingsFilesRename]: same(['string', 'string']),
  [IpcChannel.SettingsFilesRemove]: same(['string']),
  [IpcChannel.ModelsGet]: same([]),
  [IpcChannel.ModelsRefresh]: same([]),
  [IpcChannel.TranslateAvailable]: same([]),
  [IpcChannel.TranslateRun]: same(['strings']),
  [IpcChannel.TranslateOpenSettings]: mac([], 'Mac のシステム設定を開く'),
  [IpcChannel.KnowledgeGet]: same(['string']),
  [IpcChannel.ContextGet]: same(['string']),
  [IpcChannel.McpStatusGet]: same(['string']),
  [IpcChannel.CompactStart]: same(['string']),
  [IpcChannel.CompactGet]: same(['string']),
  [IpcChannel.TasksBash]: same(['string']),
  [IpcChannel.TasksAgentLog]: same(['string', 'object']),
  [IpcChannel.TasksStop]: same(['string', 'object']),
  [IpcChannel.ShellCreate]: same(['string', 'number', 'number']),
  [IpcChannel.ShellAttach]: replace([], '画面は 1 つという前提で、プロファイルに 1 つの状態を上書きする（遠隔の接続ごとに持つ形にするまで）'),
  [IpcChannel.FolderPick]: replace([], 'フォルダを選ぶ Mac のダイアログ（スマホ向けのフォルダの一覧に置き換える）'),
  [IpcChannel.FolderInfo]: same(['string']),
  [IpcChannel.FolderParentInstructions]: same(['string', 'boolean?']),
  [IpcChannel.FolderFiles]: same(['string']),
  [IpcChannel.FolderCommands]: same(['string']),
  [IpcChannel.FolderOpen]: same(['string']),
  [IpcChannel.WorkspaceInfo]: same(['string']),
  [IpcChannel.WorkspaceAddFolder]: replace(['string'], 'フォルダを選ぶ Mac のダイアログ'),
  [IpcChannel.WorkspaceRemoveFolder]: same(['string', 'string']),
  [IpcChannel.WorkspaceKeepReadFolder]: same(['string', 'string']),
  [IpcChannel.WorkspaceDismissRead]: same(['string', 'string']),
  [IpcChannel.WorkspaceClaudeSettings]: same(['string']),
  [IpcChannel.ListDir]: same(['string', 'string']),
  [IpcChannel.ReadFile]: same(['string', 'string']),
  [IpcChannel.ReadImage]: same(['string', 'string']),
  [IpcChannel.ResolveFiles]: same(['string', 'strings']),
  [IpcChannel.RevealFile]: mac(['string', 'string'], 'Finder で表示する'),
  [IpcChannel.CreateEntry]: same(['string', 'string', 'string', 'string']),
  [IpcChannel.RenameEntry]: same(['string', 'string', 'string']),
  [IpcChannel.TrashEntry]: same(['string', 'string']),
  [IpcChannel.WriteFile]: same(['string', 'string', 'string', 'nullable-string']),
  [IpcChannel.ListFiles]: same(['string']),
  [IpcChannel.Search]: same(['string', 'string', 'object']),
  [IpcChannel.GitState]: same(['string']),
  [IpcChannel.GitBranches]: same(['string']),
  [IpcChannel.GitRun]: same(['string', 'object']),
  [IpcChannel.GitDiffSides]: same(['string', 'string', 'boolean']),
  [IpcChannel.GitBranchDiffSides]: same(['string', 'string', 'string']),
  [IpcChannel.GitBaseline]: same(['string', 'string', 'string']),
  [IpcChannel.GitLastMessage]: same(['string']),
  [IpcChannel.CommandsList]: same(['string']),
  [IpcChannel.AttachmentSave]: same(['string', 'bytes']),
  [IpcChannel.ChecklistGet]: same(['string']),
  [IpcChannel.ChecklistApply]: same(['string', 'object']),
  [IpcChannel.ChecklistCopy]: same(['object']),
  [IpcChannel.ChecklistUnread]: same([]),
  [IpcChannel.WalkthroughGet]: same([]),
  [IpcChannel.WalkthroughGo]: same(['string', 'number']),
  [IpcChannel.WalkthroughClose]: same(['string']),
  [IpcChannel.WalkthroughDraftComment]: same(['string']),
  [IpcChannel.WalkthroughPostComment]: same(['string', 'string', 'boolean']),
  [IpcChannel.BrowserOpenExternal]: replace(['string'], 'Mac のふつうのブラウザで開く（スマホのブラウザで開くに置き換える）'),
  [IpcChannel.BrowserHostsGet]: mac([], 'メニューバーの「MCP の設定…」で開くダイアログ'),
  [IpcChannel.BrowserHostsSet]: mac(['strings'], 'メニューバーの「MCP の設定…」で開くダイアログ'),
  [IpcChannel.BrowserCredentialLinksGet]: mac([], 'メニューバーの「MCP の設定…」で開くダイアログ'),
  [IpcChannel.BrowserCredentialLinksSet]: mac(['array'], 'メニューバーの「MCP の設定…」で開くダイアログ'),
  [IpcChannel.BrowserAsksGet]: same([]),
  [IpcChannel.BrowserLoginsGet]: same([]),
  [IpcChannel.BrowserRemembersGet]: same([]),
  [IpcChannel.BrowserPopupsGet]: same([]),
  [IpcChannel.SessionsFocus]: replace(['nullable-string'], '画面は 1 つという前提で、プロファイルに 1 つの状態を上書きする（遠隔の接続ごとに持つ形にするまで）'),
  [IpcChannel.SessionsInterrupt]: same(['string']),
  [IpcChannel.SessionsDismissSuggestion]: same(['string']),
  [IpcChannel.SessionsExportReveal]: mac(['string'], 'Finder で表示する'),
  [IpcChannel.PrefsSet]: replace(['string', 'string'], 'アプリ全体で 1 つの表示の設定（カラムの幅など）。スマホの値が Mac の全画面に配られる（スマホの画面の値を分けるまで）'),
  [IpcChannel.FocusLost]: mac(['object'], 'Mac の画面の入力欄のフォーカスの記録'),
  [IpcChannel.PtyWrite]: same(['string', 'string']),
  [IpcChannel.PtyResize]: same(['string', 'number', 'number']),
  [IpcChannel.PtyResetSize]: same(['string']),
  [IpcChannel.ShellWrite]: same(['string', 'string']),
  [IpcChannel.ShellResize]: same(['string', 'number', 'number']),
  [IpcChannel.ShellKill]: same(['string']),
  [IpcChannel.ShellReveal]: same(['string']),
  [IpcChannel.FolderClose]: same(['string']),
  [IpcChannel.WatchOpenFiles]: replace(['object'], '画面は 1 つという前提で、プロファイルに 1 つの状態を上書きする（遠隔の接続ごとに持つ形にするまで）'),
  [IpcChannel.BrowserAttach]: mac(['string', 'string', 'number'], 'Mac の画面が作った webview を main に知らせる（スマホには webview が無い）'),
  [IpcChannel.BrowserActivate]: mac(['string', 'nullable-string'], 'Mac の画面の今のタブを main に知らせる（スマホには webview が無い）'),
  [IpcChannel.BrowserPopupView]: replace(['string', 'string', 'nullable-object'], 'ポップアップの絵を Mac の画面の位置に映す（段階 3 で置き換える）'),
  [IpcChannel.BrowserPopupFrameDone]: replace(['string', 'string'], 'ポップアップの絵を Mac の画面の位置に映す（段階 3 で置き換える）'),
  [IpcChannel.BrowserPopupInput]: replace(['string', 'string', 'object'], 'ポップアップの絵を Mac の画面の位置に映す（段階 3 で置き換える）'),
  [IpcChannel.BrowserPopupReveal]: mac(['string', 'string'], 'Mac に実物のポップアップの窓を出す'),
  [IpcChannel.BrowserPopupClose]: same(['string', 'string']),
  [IpcChannel.BrowserAnswer]: same(['string', 'string', 'object']),
  [IpcChannel.BrowserLoginAnswer]: same(['string', 'string', 'nullable-object']),
  [IpcChannel.BrowserRememberAnswer]: same(['string', 'string', 'boolean']),
  [IpcChannel.BrowserViewportReset]: same(['string']),
  [IpcChannel.BrowserThrottleClear]: same(['string', 'string']),
  [IpcChannel.WalkthroughShown]: same(['string', 'string', 'number', 'string']),
  [IpcChannel.WalkthroughViewing]: replace(['nullable-string', 'boolean'], '画面は 1 つという前提で、プロファイルに 1 つの状態を上書きする（遠隔の接続ごとに持つ形にするまで）'),
};

export const REMOTE_CHANNELS: { readonly [C in RemoteChannel]: RemoteChannelSpec } = TABLE;
