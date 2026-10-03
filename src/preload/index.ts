import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  IpcChannel,
  type BrowserActivity,
  type BrowserNewTabRequest,
  type BrowserOpenRequest,
  type BrowserTabRef,
  type BrowserViewportChange,
  type ChatBatch,
  type FilesChanged,
  type PtyData,
  type ShellData,
  type ShellExit,
  type ShellOpened,
  type SessionBashTasks,
  type SessionKnowledgeChanged,
  type SessionStatusLine,
  type SessionActivity,
  type SessionScreen,
  type SessionSubagents,
  type SessionWorkflows,
  type SessionSummary,
  type TanacodeApi,
} from '@shared/ipc';
import type { AppUpdate } from '@shared/app-update';
import type { SettingsFile } from '@shared/settings-file';
import type { SystemStats } from '@shared/system';
import type { UsageLimits } from '@shared/usage';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const api: TanacodeApi = {
  sessions: {
    list: () => ipcRenderer.invoke(IpcChannel.SessionsList),
    create: (cwd, options) => ipcRenderer.invoke(IpcChannel.SessionsCreate, cwd, options),
    open: (id) => ipcRenderer.invoke(IpcChannel.SessionsOpen, id),
    archive: (id, options) => ipcRenderer.invoke(IpcChannel.SessionsArchive, id, options),
    unarchive: (id) => ipcRenderer.invoke(IpcChannel.SessionsUnarchive, id),
    focus: (id) => ipcRenderer.send(IpcChannel.SessionsFocus, id),
    snapshot: (id) => ipcRenderer.invoke(IpcChannel.SessionsSnapshot, id),
    onChanged: (listener) => subscribe<SessionSummary[]>(IpcChannel.SessionsChanged, listener),
    onSelect: (listener) => subscribe<string>(IpcChannel.SessionsSelect, listener),
    onNew: (listener) => subscribe<undefined>(IpcChannel.SessionsNew, () => listener()),
    onChat: (listener) => subscribe<ChatBatch>(IpcChannel.ChatEvents, listener),
    configure: (id, options) => ipcRenderer.invoke(IpcChannel.SessionsConfigure, id, options),
    restart: (id) => ipcRenderer.invoke(IpcChannel.SessionsRestart, id),
    setRemoteControl: (id, on) => ipcRenderer.invoke(IpcChannel.SessionsSetRemoteControl, id, on),
    remoteControlAvailable: () => ipcRenderer.invoke(IpcChannel.RemoteControlAvailable),
    rename: (id, title) => ipcRenderer.invoke(IpcChannel.SessionsRename, id, title),
    remove: (id, options) => ipcRenderer.invoke(IpcChannel.SessionsRemove, id, options),
    worktreeLeftovers: (id) => ipcRenderer.invoke(IpcChannel.SessionsWorktreeLeftovers, id),
    history: (id) => ipcRenderer.invoke(IpcChannel.SessionsHistory, id),
    image: (key) => ipcRenderer.invoke(IpcChannel.ChatImage, key),
    discover: () => ipcRenderer.invoke(IpcChannel.SessionsDiscover),
    import: (session) => ipcRenderer.invoke(IpcChannel.SessionsImport, session),
  },
  screen: {
    get: (sessionId) => ipcRenderer.invoke(IpcChannel.ScreenGet, sessionId),
    choose: (sessionId, choice) => ipcRenderer.invoke(IpcChannel.ScreenChoose, sessionId, choice),
    setMode: (sessionId, mode) => ipcRenderer.invoke(IpcChannel.ScreenSetMode, sessionId, mode),
    rewind: (sessionId, text) => ipcRenderer.invoke(IpcChannel.ScreenRewind, sessionId, text),
    onChanged: (listener) => subscribe<SessionScreen>(IpcChannel.ScreenChanged, listener),
    activity: (sessionId) => ipcRenderer.invoke(IpcChannel.ScreenActivityGet, sessionId),
    onActivity: (listener) => subscribe<SessionActivity>(IpcChannel.ScreenActivity, listener),
  },
  workflows: {
    get: (sessionId) => ipcRenderer.invoke(IpcChannel.WorkflowsGet, sessionId),
    onChanged: (listener) => subscribe<SessionWorkflows>(IpcChannel.WorkflowsChanged, listener),
  },
  subagents: {
    get: (sessionId) => ipcRenderer.invoke(IpcChannel.SubagentsGet, sessionId),
    onChanged: (listener) => subscribe<SessionSubagents>(IpcChannel.SubagentsChanged, listener),
  },
  usage: {
    get: () => ipcRenderer.invoke(IpcChannel.UsageGet),
    refresh: () => ipcRenderer.invoke(IpcChannel.UsageRefresh),
    onChanged: (listener) => subscribe<UsageLimits>(IpcChannel.UsageChanged, listener),
  },
  notifications: {
    get: () => ipcRenderer.invoke(IpcChannel.NotificationsGet),
    set: (on) => ipcRenderer.invoke(IpcChannel.NotificationsSet, on),
  },
  system: {
    onStats: (listener) => subscribe<SystemStats>(IpcChannel.SystemStats, listener),
  },
  claudeVersion: {
    get: () => ipcRenderer.invoke(IpcChannel.ClaudeVersionGet),
    onChanged: (listener) => subscribe<string | null>(IpcChannel.ClaudeVersionChanged, listener),
  },
  appUpdate: {
    get: () => ipcRenderer.invoke(IpcChannel.AppUpdateGet),
    onChanged: (listener) => subscribe<AppUpdate | null>(IpcChannel.AppUpdateChanged, listener),
  },
  statusLine: {
    get: (sessionId) => ipcRenderer.invoke(IpcChannel.StatusLineGet, sessionId),
    onChanged: (listener) => subscribe<SessionStatusLine>(IpcChannel.StatusLineChanged, listener),
  },
  settingsFiles: {
    list: () => ipcRenderer.invoke(IpcChannel.SettingsFilesList),
    pick: () => ipcRenderer.invoke(IpcChannel.SettingsFilesPick),
    add: (path, name) => ipcRenderer.invoke(IpcChannel.SettingsFilesAdd, path, name),
    rename: (id, name) => ipcRenderer.invoke(IpcChannel.SettingsFilesRename, id, name),
    remove: (id) => ipcRenderer.invoke(IpcChannel.SettingsFilesRemove, id),
    onChanged: (listener) => subscribe<SettingsFile[]>(IpcChannel.SettingsFilesChanged, listener),
  },
  models: {
    get: () => ipcRenderer.invoke(IpcChannel.ModelsGet),
    refresh: () => ipcRenderer.invoke(IpcChannel.ModelsRefresh),
  },
  knowledge: {
    get: (sessionId) => ipcRenderer.invoke(IpcChannel.KnowledgeGet, sessionId),
    onChanged: (listener) => subscribe<SessionKnowledgeChanged>(IpcChannel.KnowledgeChanged, listener),
  },
  tasks: {
    bash: (sessionId) => ipcRenderer.invoke(IpcChannel.TasksBash, sessionId),
    onBashChanged: (listener) => subscribe<SessionBashTasks>(IpcChannel.TasksBashChanged, listener),
    agentLog: (sessionId, ref) => ipcRenderer.invoke(IpcChannel.TasksAgentLog, sessionId, ref),
  },
  pty: {
    write: (sessionId, data) => ipcRenderer.send(IpcChannel.PtyWrite, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(IpcChannel.PtyResize, sessionId, cols, rows),
    resetSize: (sessionId) => ipcRenderer.send(IpcChannel.PtyResetSize, sessionId),
    onData: (listener) => subscribe<PtyData>(IpcChannel.PtyData, listener),
  },
  shell: {
    create: (sessionId, cols, rows) => ipcRenderer.invoke(IpcChannel.ShellCreate, sessionId, cols, rows),
    write: (id, data) => ipcRenderer.send(IpcChannel.ShellWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IpcChannel.ShellResize, id, cols, rows),
    kill: (id) => ipcRenderer.send(IpcChannel.ShellKill, id),
    onData: (listener) => subscribe<ShellData>(IpcChannel.ShellData, listener),
    onExit: (listener) => subscribe<ShellExit>(IpcChannel.ShellExit, listener),
    onOpened: (listener) => subscribe<ShellOpened>(IpcChannel.ShellOpened, listener),
  },
  folders: {
    pick: () => ipcRenderer.invoke(IpcChannel.FolderPick),
    info: (cwd) => ipcRenderer.invoke(IpcChannel.FolderInfo, cwd),
    listFiles: (cwd) => ipcRenderer.invoke(IpcChannel.FolderFiles, cwd),
    commands: (cwd) => ipcRenderer.invoke(IpcChannel.FolderCommands, cwd),
    open: (cwd) => ipcRenderer.invoke(IpcChannel.FolderOpen, cwd),
    close: (id) => ipcRenderer.send(IpcChannel.FolderClose, id),
  },
  workspace: {
    info: (sessionId) => ipcRenderer.invoke(IpcChannel.WorkspaceInfo, sessionId),
    listDir: (sessionId, relPath) => ipcRenderer.invoke(IpcChannel.ListDir, sessionId, relPath),
    readFile: (sessionId, relPath) => ipcRenderer.invoke(IpcChannel.ReadFile, sessionId, relPath),
    readImage: (sessionId, relPath) => ipcRenderer.invoke(IpcChannel.ReadImage, sessionId, relPath),
    writeFile: (sessionId, relPath, text) => ipcRenderer.invoke(IpcChannel.WriteFile, sessionId, relPath, text),
    onFilesChanged: (listener) => subscribe<FilesChanged>(IpcChannel.FilesChanged, listener),
    listFiles: (sessionId) => ipcRenderer.invoke(IpcChannel.ListFiles, sessionId),
    search: (sessionId, query, options) => ipcRenderer.invoke(IpcChannel.Search, sessionId, query, options),
  },
  git: {
    state: (sessionId) => ipcRenderer.invoke(IpcChannel.GitState, sessionId),
    branches: (sessionId) => ipcRenderer.invoke(IpcChannel.GitBranches, sessionId),
    run: (sessionId, action) => ipcRenderer.invoke(IpcChannel.GitRun, sessionId, action),
    diffSides: (sessionId, relPath, staged) => ipcRenderer.invoke(IpcChannel.GitDiffSides, sessionId, relPath, staged),
    branchDiffSides: (sessionId, mergeBase, relPath) => ipcRenderer.invoke(IpcChannel.GitBranchDiffSides, sessionId, mergeBase, relPath),
    baseline: (sessionId, mergeBase, relPath) => ipcRenderer.invoke(IpcChannel.GitBaseline, sessionId, mergeBase, relPath),
    lastCommitMessage: (sessionId) => ipcRenderer.invoke(IpcChannel.GitLastMessage, sessionId),
  },
  commands: {
    list: (sessionId) => ipcRenderer.invoke(IpcChannel.CommandsList, sessionId),
  },
  attachments: {
    save: (name, data) => ipcRenderer.invoke(IpcChannel.AttachmentSave, name, data),
  },
  browser: {
    attach: (sessionId, tabId, webContentsId) => ipcRenderer.send(IpcChannel.BrowserAttach, sessionId, tabId, webContentsId),
    activate: (sessionId, tabId) => ipcRenderer.send(IpcChannel.BrowserActivate, sessionId, tabId),
    onOpen: (listener) => subscribe<BrowserOpenRequest>(IpcChannel.BrowserOpen, listener),
    onNewTab: (listener) => subscribe<BrowserNewTabRequest>(IpcChannel.BrowserNewTab, listener),
    onSelectTab: (listener) => subscribe<BrowserTabRef>(IpcChannel.BrowserSelectTab, listener),
    onCloseTab: (listener) => subscribe<BrowserTabRef>(IpcChannel.BrowserCloseTab, listener),
    openExternal: (url) => ipcRenderer.invoke(IpcChannel.BrowserOpenExternal, url),
    onActivity: (listener) => subscribe<BrowserActivity>(IpcChannel.BrowserActivity, listener),
    onViewport: (listener) => subscribe<BrowserViewportChange>(IpcChannel.BrowserViewport, listener),
    hosts: () => ipcRenderer.invoke(IpcChannel.BrowserHostsGet),
    setHosts: (hosts) => ipcRenderer.invoke(IpcChannel.BrowserHostsSet, hosts),
    onHostsOpen: (listener) => subscribe<undefined>(IpcChannel.BrowserHostsOpen, () => listener()),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('tanacode', api);
