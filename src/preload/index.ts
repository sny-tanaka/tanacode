import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IpcChannel, type IpcEvent, type IpcInvoke, type IpcSend, type TanacodeApi } from '@shared/ipc';

// チャンネルごとの引数・戻り値・知らせの中身は、shared/ipc.ts の表（IpcInvoke・IpcSend・IpcEvent）で決まる。
// main の受け口・送り口も同じ表で型を付けるので、食い違うと型チェックで止まる
function invoke<C extends keyof IpcInvoke>(channel: C, ...args: Parameters<IpcInvoke[C]>): ReturnType<IpcInvoke[C]> {
  return ipcRenderer.invoke(channel, ...args) as ReturnType<IpcInvoke[C]>;
}

function send<C extends keyof IpcSend>(channel: C, ...args: Parameters<IpcSend[C]>): void {
  ipcRenderer.send(channel, ...args);
}

function subscribe<C extends keyof IpcEvent>(channel: C, listener: (payload: IpcEvent[C]) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: IpcEvent[C]) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const api: TanacodeApi = {
  sessions: {
    list: () => invoke(IpcChannel.SessionsList),
    create: (cwd, options) => invoke(IpcChannel.SessionsCreate, cwd, options),
    open: (id) => invoke(IpcChannel.SessionsOpen, id),
    archive: (id, options) => invoke(IpcChannel.SessionsArchive, id, options),
    unarchive: (id) => invoke(IpcChannel.SessionsUnarchive, id),
    focus: (id) => send(IpcChannel.SessionsFocus, id),
    snapshot: (id) => invoke(IpcChannel.SessionsSnapshot, id),
    submit: (id, text, attachments) => invoke(IpcChannel.SessionsSubmit, id, text, attachments),
    interrupt: (id) => send(IpcChannel.SessionsInterrupt, id),
    onChanged: (listener) => subscribe(IpcChannel.SessionsChanged, listener),
    onSelect: (listener) => subscribe(IpcChannel.SessionsSelect, listener),
    onNew: (listener) => subscribe(IpcChannel.SessionsNew, () => listener()),
    onChat: (listener) => subscribe(IpcChannel.ChatEvents, listener),
    configure: (id, options) => invoke(IpcChannel.SessionsConfigure, id, options),
    restart: (id) => invoke(IpcChannel.SessionsRestart, id),
    setRemoteControl: (id, on) => invoke(IpcChannel.SessionsSetRemoteControl, id, on),
    remoteControlAvailable: () => invoke(IpcChannel.RemoteControlAvailable),
    rename: (id, title) => invoke(IpcChannel.SessionsRename, id, title),
    remove: (id, options) => invoke(IpcChannel.SessionsRemove, id, options),
    worktreeLeftovers: (id) => invoke(IpcChannel.SessionsWorktreeLeftovers, id),
    history: (id) => invoke(IpcChannel.SessionsHistory, id),
    image: (key) => invoke(IpcChannel.ChatImage, key),
    exportSource: (id) => invoke(IpcChannel.SessionsExportSource, id),
    saveExport: (html, fileName) => invoke(IpcChannel.SessionsExportSave, html, fileName),
    revealExport: (path) => send(IpcChannel.SessionsExportReveal, path),
    discover: () => invoke(IpcChannel.SessionsDiscover),
    import: (session) => invoke(IpcChannel.SessionsImport, session),
  },
  screen: {
    get: (sessionId) => invoke(IpcChannel.ScreenGet, sessionId),
    choose: (sessionId, choice) => invoke(IpcChannel.ScreenChoose, sessionId, choice),
    setMode: (sessionId, mode) => invoke(IpcChannel.ScreenSetMode, sessionId, mode),
    rewind: (sessionId, text) => invoke(IpcChannel.ScreenRewind, sessionId, text),
    onChanged: (listener) => subscribe(IpcChannel.ScreenChanged, listener),
    activity: (sessionId) => invoke(IpcChannel.ScreenActivityGet, sessionId),
    onActivity: (listener) => subscribe(IpcChannel.ScreenActivity, listener),
  },
  workflows: {
    get: (sessionId) => invoke(IpcChannel.WorkflowsGet, sessionId),
    onChanged: (listener) => subscribe(IpcChannel.WorkflowsChanged, listener),
  },
  subagents: {
    get: (sessionId) => invoke(IpcChannel.SubagentsGet, sessionId),
    onChanged: (listener) => subscribe(IpcChannel.SubagentsChanged, listener),
  },
  usage: {
    get: () => invoke(IpcChannel.UsageGet),
    refresh: () => invoke(IpcChannel.UsageRefresh),
    onChanged: (listener) => subscribe(IpcChannel.UsageChanged, listener),
  },
  scheduled: {
    list: () => invoke(IpcChannel.ScheduledList),
    add: (sessionId, text, attachments, at) => invoke(IpcChannel.ScheduledAdd, sessionId, text, attachments, at),
    reschedule: (id, at) => invoke(IpcChannel.ScheduledReschedule, id, at),
    sendNow: (id) => invoke(IpcChannel.ScheduledSendNow, id),
    cancel: (id) => invoke(IpcChannel.ScheduledCancel, id),
    onChanged: (listener) => subscribe(IpcChannel.ScheduledChanged, listener),
  },
  notifications: {
    get: () => invoke(IpcChannel.NotificationsGet),
    set: (on) => invoke(IpcChannel.NotificationsSet, on),
  },
  system: {
    onStats: (listener) => subscribe(IpcChannel.SystemStats, listener),
  },
  claudeVersion: {
    get: () => invoke(IpcChannel.ClaudeVersionGet),
    onChanged: (listener) => subscribe(IpcChannel.ClaudeVersionChanged, listener),
  },
  appUpdate: {
    get: () => invoke(IpcChannel.AppUpdateGet),
    onChanged: (listener) => subscribe(IpcChannel.AppUpdateChanged, listener),
  },
  statusLine: {
    get: (sessionId) => invoke(IpcChannel.StatusLineGet, sessionId),
    onChanged: (listener) => subscribe(IpcChannel.StatusLineChanged, listener),
  },
  settingsFiles: {
    list: () => invoke(IpcChannel.SettingsFilesList),
    pick: () => invoke(IpcChannel.SettingsFilesPick),
    add: (path, name) => invoke(IpcChannel.SettingsFilesAdd, path, name),
    rename: (id, name) => invoke(IpcChannel.SettingsFilesRename, id, name),
    remove: (id) => invoke(IpcChannel.SettingsFilesRemove, id),
    onChanged: (listener) => subscribe(IpcChannel.SettingsFilesChanged, listener),
  },
  models: {
    get: () => invoke(IpcChannel.ModelsGet),
    refresh: () => invoke(IpcChannel.ModelsRefresh),
  },
  translate: {
    available: () => invoke(IpcChannel.TranslateAvailable),
    run: (texts) => invoke(IpcChannel.TranslateRun, texts),
    openSettings: () => invoke(IpcChannel.TranslateOpenSettings),
  },
  knowledge: {
    get: (sessionId) => invoke(IpcChannel.KnowledgeGet, sessionId),
    onChanged: (listener) => subscribe(IpcChannel.KnowledgeChanged, listener),
  },
  context: {
    get: (sessionId) => invoke(IpcChannel.ContextGet, sessionId),
  },
  tasks: {
    bash: (sessionId) => invoke(IpcChannel.TasksBash, sessionId),
    onBashChanged: (listener) => subscribe(IpcChannel.TasksBashChanged, listener),
    agentLog: (sessionId, ref) => invoke(IpcChannel.TasksAgentLog, sessionId, ref),
    stop: (sessionId, ref) => invoke(IpcChannel.TasksStop, sessionId, ref),
  },
  pty: {
    write: (sessionId, data) => send(IpcChannel.PtyWrite, sessionId, data),
    resize: (sessionId, cols, rows) => send(IpcChannel.PtyResize, sessionId, cols, rows),
    resetSize: (sessionId) => send(IpcChannel.PtyResetSize, sessionId),
    onData: (listener) => subscribe(IpcChannel.PtyData, listener),
  },
  shell: {
    create: (sessionId, cols, rows) => invoke(IpcChannel.ShellCreate, sessionId, cols, rows),
    write: (id, data) => send(IpcChannel.ShellWrite, id, data),
    resize: (id, cols, rows) => send(IpcChannel.ShellResize, id, cols, rows),
    kill: (id) => send(IpcChannel.ShellKill, id),
    onData: (listener) => subscribe(IpcChannel.ShellData, listener),
    onExit: (listener) => subscribe(IpcChannel.ShellExit, listener),
    onOpened: (listener) => subscribe(IpcChannel.ShellOpened, listener),
  },
  folders: {
    pick: () => invoke(IpcChannel.FolderPick),
    info: (cwd) => invoke(IpcChannel.FolderInfo, cwd),
    listFiles: (cwd) => invoke(IpcChannel.FolderFiles, cwd),
    commands: (cwd) => invoke(IpcChannel.FolderCommands, cwd),
    open: (cwd) => invoke(IpcChannel.FolderOpen, cwd),
    close: (id) => send(IpcChannel.FolderClose, id),
  },
  workspace: {
    info: (sessionId) => invoke(IpcChannel.WorkspaceInfo, sessionId),
    listDir: (sessionId, relPath) => invoke(IpcChannel.ListDir, sessionId, relPath),
    readFile: (sessionId, relPath) => invoke(IpcChannel.ReadFile, sessionId, relPath),
    readImage: (sessionId, relPath) => invoke(IpcChannel.ReadImage, sessionId, relPath),
    writeFile: (sessionId, relPath, text) => invoke(IpcChannel.WriteFile, sessionId, relPath, text),
    onFilesChanged: (listener) => subscribe(IpcChannel.FilesChanged, listener),
    listFiles: (sessionId) => invoke(IpcChannel.ListFiles, sessionId),
    search: (sessionId, query, options) => invoke(IpcChannel.Search, sessionId, query, options),
  },
  git: {
    state: (sessionId) => invoke(IpcChannel.GitState, sessionId),
    branches: (sessionId) => invoke(IpcChannel.GitBranches, sessionId),
    run: (sessionId, action) => invoke(IpcChannel.GitRun, sessionId, action),
    diffSides: (sessionId, relPath, staged) => invoke(IpcChannel.GitDiffSides, sessionId, relPath, staged),
    branchDiffSides: (sessionId, mergeBase, relPath) => invoke(IpcChannel.GitBranchDiffSides, sessionId, mergeBase, relPath),
    baseline: (sessionId, mergeBase, relPath) => invoke(IpcChannel.GitBaseline, sessionId, mergeBase, relPath),
    lastCommitMessage: (sessionId) => invoke(IpcChannel.GitLastMessage, sessionId),
  },
  commands: {
    list: (sessionId) => invoke(IpcChannel.CommandsList, sessionId),
  },
  attachments: {
    save: (name, data) => invoke(IpcChannel.AttachmentSave, name, data),
  },
  checklist: {
    get: (sessionId) => invoke(IpcChannel.ChecklistGet, sessionId),
    apply: (sessionId, op) => invoke(IpcChannel.ChecklistApply, sessionId, op),
    copy: (request) => invoke(IpcChannel.ChecklistCopy, request),
    onChanged: (listener) => subscribe(IpcChannel.ChecklistChanged, listener),
    unread: () => invoke(IpcChannel.ChecklistUnread),
  },
  walkthrough: {
    list: () => invoke(IpcChannel.WalkthroughGet),
    go: (sessionId, index) => invoke(IpcChannel.WalkthroughGo, sessionId, index),
    close: (sessionId) => invoke(IpcChannel.WalkthroughClose, sessionId),
    onChanged: (listener) => subscribe(IpcChannel.WalkthroughChanged, listener),
    draftComment: (sessionId) => invoke(IpcChannel.WalkthroughDraftComment, sessionId),
    postComment: (sessionId, body, attribution) => invoke(IpcChannel.WalkthroughPostComment, sessionId, body, attribution),
  },
  browser: {
    attach: (sessionId, tabId, webContentsId) => send(IpcChannel.BrowserAttach, sessionId, tabId, webContentsId),
    activate: (sessionId, tabId) => send(IpcChannel.BrowserActivate, sessionId, tabId),
    onOpen: (listener) => subscribe(IpcChannel.BrowserOpen, listener),
    onNewTab: (listener) => subscribe(IpcChannel.BrowserNewTab, listener),
    onSelectTab: (listener) => subscribe(IpcChannel.BrowserSelectTab, listener),
    onCloseTab: (listener) => subscribe(IpcChannel.BrowserCloseTab, listener),
    openExternal: (url) => invoke(IpcChannel.BrowserOpenExternal, url),
    onActivity: (listener) => subscribe(IpcChannel.BrowserActivity, listener),
    onViewport: (listener) => subscribe(IpcChannel.BrowserViewport, listener),
    hosts: () => invoke(IpcChannel.BrowserHostsGet),
    setHosts: (hosts) => invoke(IpcChannel.BrowserHostsSet, hosts),
    onHostsOpen: (listener) => subscribe(IpcChannel.BrowserHostsOpen, () => listener()),
    onAsk: (listener) => subscribe(IpcChannel.BrowserAsk, listener),
    asks: () => invoke(IpcChannel.BrowserAsksGet),
    answer: (sessionId, askId, answer) => send(IpcChannel.BrowserAnswer, sessionId, askId, answer),
    onShow: (listener) => subscribe(IpcChannel.BrowserShow, listener),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('tanacode', api);
