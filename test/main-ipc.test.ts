import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { defaultPrompt } from '@shared/prompts';
import { LANGUAGE_SETTINGS_URL } from '../src/main/translate';
import { DEFAULT_PTY_SIZE } from '../src/main/session-manager';
import { invokes, sends } from './helpers/ipc-tables';
import {
  argsOf,
  boot,
  cleanup,
  fakeEvent,
  FakeWebContents,
  githubModule,
  invoke,
  invokeWith,
  mainWindow,
  manager,
  sendFromRenderer,
  sendWith,
  sentToRenderer,
  setSystemVersion,
  state,
  the,
} from './helpers/main-app';

// アプリの入り口（src/main/index.ts）の、画面からの呼び出し・知らせの受け口（registerIpc）。
// Electron と重い部品を作り物にして index.ts を読み込み（test/helpers/main-app.ts）、受け口を画面の代わりに呼んで、
// 正しい相手に、引数を取り違えずに渡すか・画面から届いた値を確かめるか・分岐ごとの返事を確かめる。
// 作り物の部品のメソッドは、既定では「呼ばれたメソッドと引数」をそのまま返す（{ call, args }。作業フォルダごとのものは cwd も）

afterEach(() => cleanup());

// 作り物の返事（呼ばれたメソッドと引数）
const call = (name: string, ...args: unknown[]) => ({ call: name, args });
const callIn = (cwd: string, name: string, ...args: unknown[]) => ({ call: name, cwd, args });
// セッションのフォルダ（作り物の manager.cwdOf）
const cwdOf = (id: string) => `/sessions/${id}`;

describe('受け口の登録', () => {
  it('画面が呼ぶチャンネル（IpcInvoke）には handle、画面が送るチャンネル（IpcSend）には listen が、ちょうど 1 つずつある', async () => {
    await boot();
    expect([...state.handlers.keys()].sort()).toEqual(invokes.map((e) => e.channel).sort());
    expect([...state.listeners.keys()].sort()).toEqual(sends.map((e) => e.channel).sort());
  });
});

describe('Markdown のプレビューの画像', () => {
  it('セッションのフォルダで読み、追加したフォルダも渡す（その中の画像だけを読む）。読めなければ null', async () => {
    await boot();
    manager().addedFoldersOf.mockReturnValue(['/Users/me/lib']);
    await expect(invoke(IpcChannel.ReadImage, 's1', '/Users/me/lib/logo.png')).resolves.toEqual(
      callIn(cwdOf('s1'), 'workspace.readImage', '/Users/me/lib/logo.png', ['/Users/me/lib']),
    );
    expect(manager().addedFoldersOf.mock.calls).toEqual([['s1']]);
  });
});

describe('送り元', () => {
  const NOT_FROM_APP = 'アプリの画面からの呼び出しではありません';

  it('アプリの画面のメインフレームからの呼び出しと知らせだけを受ける。中のフレーム・アプリの画面でないもの・アプリの外の URL・フレームの分からないものは受けない', async () => {
    await boot();
    const contents = mainWindow().webContents;
    const open = (sender: unknown, senderFrame: { url: string; parent: unknown } | null) =>
      invokeWith({ sender, senderFrame: senderFrame as never }, IpcChannel.SessionsOpen, 's1');
    await expect(open(contents, contents.mainFrame)).resolves.toEqual(call('manager.open', 's1'));
    // 画面の中のフレーム（iframe）
    await expect(open(contents, { url: contents.url, parent: contents.mainFrame })).rejects.toThrow(NOT_FROM_APP);
    // フレームが分からない（呼び出しの途中で、フレームが消えた・移った）
    await expect(open(contents, null)).rejects.toThrow(NOT_FROM_APP);
    // アプリの画面のメインフレームが、アプリの外のページになっている
    await expect(open(contents, { url: 'https://example.com/', parent: null })).rejects.toThrow(NOT_FROM_APP);
    await expect(open(contents, { url: 'file:///tmp/index.html', parent: null })).rejects.toThrow(NOT_FROM_APP);
    // アプリの画面でないもの（アプリ内ブラウザのページなど）
    const guest = new FakeWebContents();
    guest.type = 'webview';
    guest.url = contents.url;
    await expect(open(guest, guest.mainFrame)).rejects.toThrow(NOT_FROM_APP);
    expect(manager().open.mock.calls).toEqual([['s1']]);
    // プロファイルを見ない受け口も同じ
    await expect(invokeWith({ sender: contents, senderFrame: { url: contents.url, parent: contents.mainFrame } }, IpcChannel.ProfilesAdd, { name: 'x', claudeDir: '/tmp/x' })).rejects.toThrow(NOT_FROM_APP);
    // 知らせ: 中のフレームからのものは何もしない
    sendWith({ sender: contents, senderFrame: { url: contents.url, parent: contents.mainFrame } }, IpcChannel.SessionsInterrupt, 's1');
    sendWith({ sender: guest, senderFrame: guest.mainFrame }, IpcChannel.SessionsInterrupt, 's1');
    expect(manager().interrupt).not.toHaveBeenCalled();
    sendWith({ sender: contents, senderFrame: contents.mainFrame }, IpcChannel.SessionsInterrupt, 's1');
    expect(manager().interrupt.mock.calls).toEqual([['s1']]);
  });

  it('どの受け口も、送り元を確かめてから中を動かす', async () => {
    await boot();
    const contents = mainWindow().webContents;
    const sub = { url: contents.url, parent: contents.mainFrame };
    for (const channel of state.handlers.keys()) await expect(invokeWith({ sender: contents, senderFrame: sub }, channel), channel).rejects.toThrow(NOT_FROM_APP);
    for (const channel of state.listeners.keys()) expect(sendWith({ sender: contents, senderFrame: sub }, channel), channel).toBeUndefined();
    expect(manager().interrupt).not.toHaveBeenCalled();
    expect(the('ShellTerminals').write).not.toHaveBeenCalled();
  });

  it('開発中は、開発サーバーの画面（同じオリジン）から受ける', async () => {
    await boot({ before: () => (process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173') });
    const contents = mainWindow().webContents;
    await expect(invokeWith({ sender: contents, senderFrame: { url: 'http://localhost:5173/#x', parent: null } }, IpcChannel.SessionsOpen, 's1')).resolves.toEqual(call('manager.open', 's1'));
    await expect(invokeWith({ sender: contents, senderFrame: { url: 'http://localhost:5174/', parent: null } }, IpcChannel.SessionsOpen, 's1')).rejects.toThrow(NOT_FROM_APP);
  });
});

describe('そのまま渡す受け口', () => {
  beforeEach(async () => {
    await boot();
  });

  // [チャンネル, 画面から渡す引数, 返事]。引数はどれも見分けのつく値にして、取り違え・渡し忘れが分かるようにする
  const cases: [string, unknown[], unknown][] = [
    [IpcChannel.SessionsList, [], []],
    [IpcChannel.SessionsOpen, ['s1'], call('manager.open', 's1')],
    [IpcChannel.SessionsWorktreeLeftovers, ['s1'], call('manager.worktreeLeftovers', 's1')],
    [IpcChannel.SessionsUnarchive, ['s1'], call('manager.unarchive', 's1')],
    [IpcChannel.SessionsSnapshot, ['s1'], call('manager.snapshot', 's1')],
    [IpcChannel.SessionsRename, ['s1', '新しい名前'], call('manager.rename', 's1', '新しい名前')],
    [IpcChannel.SessionsHistory, ['s1'], call('manager.history', 's1')],
    [IpcChannel.SessionsExportSource, ['s1'], call('manager.exportSource', 's1')],
    [IpcChannel.SessionsConfigure, ['s1', { model: 'opus', effort: null, settingsFile: null }], call('manager.configure', 's1', { model: 'opus', effort: null, settingsFile: null })],
    [IpcChannel.SessionsModels, ['s1'], call('manager.modelsOf', 's1')],
    [IpcChannel.SessionsRestart, ['s1'], call('manager.restart', 's1')],
    [IpcChannel.SessionsBecomeParent, ['s1'], call('manager.becomeParent', 's1')],
    [IpcChannel.SessionsSetRemoteControl, ['s1', true], call('manager.setRemoteControl', 's1', true)],
    [IpcChannel.SessionsSetTerminalMode, ['s1', true, { stopTasks: true }], call('manager.setTerminalMode', 's1', true, { stopTasks: true })],
    [IpcChannel.SessionsSetTerminalMode, ['s1', false], call('manager.setTerminalMode', 's1', false, { stopTasks: false })],
    [IpcChannel.RemoteControlAvailable, [], call('manager.remoteAvailable')],
    [IpcChannel.SessionsProgressGet, ['s1'], call('manager.progress', 's1')],
    [IpcChannel.QuestionGet, ['s1'], call('manager.pendingQuestion', 's1')],
    [IpcChannel.QuestionReply, ['s1', 'q1', { kind: 'chat' }], call('manager.replyQuestion', 's1', 'q1', { kind: 'chat' })],
    [IpcChannel.PermissionGet, ['s1'], call('manager.pendingPermission', 's1')],
    [IpcChannel.PermissionReply, ['s1', 'r1', { kind: 'allow', always: true }], call('manager.replyPermission', 's1', 'r1', { kind: 'allow', always: true })],
    [IpcChannel.WorkflowsGet, ['s1'], call('manager.workflows', 's1')],
    [IpcChannel.ScreenSetMode, ['s1', 'plan'], call('manager.setMode', 's1', 'plan')],
    [IpcChannel.ScreenRewindPreview, ['s1', 'u1'], call('manager.rewindPreview', 's1', 'u1')],
    [IpcChannel.ScreenRewind, ['s1', 'u1', { conversation: true, code: 1 }], call('manager.rewind', 's1', 'u1', { conversation: true, code: false })],
    [IpcChannel.SubagentsGet, ['s1'], call('manager.subagents', 's1')],
    [IpcChannel.TasksBash, ['s1'], call('manager.bashTasks', 's1')],
    [IpcChannel.TasksAgentLog, ['s1', { agentId: 'a1' }], call('manager.agentLog', 's1', { agentId: 'a1' })],
    [IpcChannel.TasksStop, ['s1', { kind: 'bash', id: 'b1' }], call('manager.stopTask', 's1', { kind: 'bash', id: 'b1' })],
    [IpcChannel.KnowledgeGet, ['s1'], call('manager.knowledge', 's1')],
    [IpcChannel.ContextGet, ['s1'], call('manager.context', 's1')],
    [IpcChannel.StatusLineGet, ['s1'], call('manager.statusLine', 's1')],
    [IpcChannel.ChatImage, ['img-key'], call('imageOf', 'img-key')],
    [IpcChannel.ScheduledList, [], call('scheduled.list')],
    [IpcChannel.SettingsFilesList, [], call('settingsFiles.list')],
    [IpcChannel.SettingsFilesAdd, ['/p/settings.json', '仕事用'], call('settingsFiles.add', '/p/settings.json', '仕事用')],
    [IpcChannel.SettingsFilesRename, ['f1', '新しい名前'], call('settingsFiles.rename', 'f1', '新しい名前')],
    [IpcChannel.SettingsFilesRemove, ['f1'], call('settingsFiles.remove', 'f1')],
    [IpcChannel.UsageGet, [], call('usage.get')],
    [IpcChannel.UsageRefresh, [], call('usage.refresh')],
    // 既定のプロファイルは、アプリの環境変数のままの .claude.json を読む
    [IpcChannel.AccountGet, [], call('readClaudeAccount', join(homedir(), '.claude.json'))],
    [IpcChannel.ClaudeVersionGet, [], call('claudeVersions.get')],
    [IpcChannel.AppUpdateGet, [], call('appUpdates.get')],
    [IpcChannel.AppUpdateCheck, [], call('appUpdates.refresh')],
    [IpcChannel.BrowserAsksGet, [], call('browser.pendingAsks')],
    [IpcChannel.WalkthroughGet, [], call('walkthrough.list')],
    [IpcChannel.WorkspaceInfo, ['s1'], callIn(cwdOf('s1'), 'workspace.info')],
    [IpcChannel.ListDir, ['s1', 'src/lib'], callIn(cwdOf('s1'), 'workspace.listDir', 'src/lib')],
    [IpcChannel.ReadFile, ['s1', 'README.md'], callIn(cwdOf('s1'), 'workspace.readFile', 'README.md')],
    // 追加したフォルダの中の画像も読めるよう、セッションの追加したフォルダも渡す（下の「Markdown のプレビューの画像」）
    [IpcChannel.ReadImage, ['s1', 'logo.png'], callIn(cwdOf('s1'), 'workspace.readImage', 'logo.png', [])],
    // 読んだときの中身（今のディスクと同じときだけ書く）。文字でなければ確かめずに書く（「このまま保存」の null）
    [IpcChannel.WriteFile, ['s1', 'a.txt', '中身', '前の中身'], callIn(cwdOf('s1'), 'workspace.writeFile', 'a.txt', '中身', '前の中身')],
    [IpcChannel.WriteFile, ['s1', 'a.txt', '中身', null], callIn(cwdOf('s1'), 'workspace.writeFile', 'a.txt', '中身', null)],
    [IpcChannel.ListFiles, ['s1'], callIn(cwdOf('s1'), 'workspace.listFiles')],
    [IpcChannel.Search, ['s1', 'TODO', { regex: true }], callIn(cwdOf('s1'), 'workspace.search', 'TODO', { regex: true })],
    [IpcChannel.GitState, ['s1'], callIn(cwdOf('s1'), 'scm.state')],
    [IpcChannel.GitBranches, ['s1'], callIn(cwdOf('s1'), 'scm.branches')],
    [IpcChannel.GitDiffSides, ['s1', 'src/a.ts', true], callIn(cwdOf('s1'), 'scm.diffSides', 'src/a.ts', true)],
    [IpcChannel.GitBranchDiffSides, ['s1', 'base-sha', 'src/a.ts'], callIn(cwdOf('s1'), 'scm.branchDiffSides', 'base-sha', 'src/a.ts')],
    [IpcChannel.GitBaseline, ['s1', 'base-sha', 'src/a.ts'], callIn(cwdOf('s1'), 'scm.baseline', 'base-sha', 'src/a.ts')],
    [IpcChannel.GitLastMessage, ['s1'], callIn(cwdOf('s1'), 'scm.lastCommitMessage')],
    // 最後の引数は、プロファイルの Claude Code の設定のフォルダ（既定のプロファイルは null）
    [IpcChannel.CommandsList, ['s1'], call('listCommands', cwdOf('s1'), '/transcripts/s1.jsonl', null)],
    [IpcChannel.CommandsList, ['live'], [{ name: 'compact', description: '圧縮', source: 'builtin' }]],
    [IpcChannel.FolderCommands, ['/work/cafe'], call('listCommands', '/work/cafe', null, null)],
    [IpcChannel.SessionsDiscover, [], call('discoverSessions', new Set(['known-1']), null)],
    [
      IpcChannel.SessionsImport,
      [{ claudeSessionId: 'c1', cwd: '/work/cafe', title: '外の会話', updatedAt: 1 }],
      call('manager.importSession', 'c1', '/work/cafe', '外の会話'),
    ],
    [IpcChannel.ShellCreate, ['s1', 120, 40], call('shells.create', 's1', cwdOf('s1'), 120, 40)],
    [IpcChannel.ShellAttach, [], call('shells.attach')],
    [IpcChannel.TranslateRun, [['こんにちは', 'Hello']], call('translator.translate', ['こんにちは', 'Hello'])],
  ];

  it.each(cases)('%s は、受け取った引数を正しい相手に渡し、返事をそのまま返す', async (channel, args, expected) => {
    await expect(invoke(channel, ...args)).resolves.toEqual(expected);
  });

  it('質問のカードの返事は、形を確かめてから渡す（形の違う返事は渡さずに false）', async () => {
    await expect(invoke(IpcChannel.QuestionReply, 's1', 'q1', { kind: 'answer', answers: { 'どちら?': 'A 案', ほか: 1 } })).resolves.toEqual(
      call('manager.replyQuestion', 's1', 'q1', { kind: 'answer', answers: { 'どちら?': 'A 案' } }),
    );
    await expect(invoke(IpcChannel.QuestionReply, 's1', 'q1', { kind: 'press-enter' })).resolves.toBe(false);
    // プレビュー付きの質問のメモ（annotations）は、文字の値だけを渡す
    await expect(
      invoke(IpcChannel.QuestionReply, 's1', 'q1', { kind: 'answer', answers: { 'どちら?': 'A 案' }, annotations: { 'どちら?': { notes: '余白を広く', preview: 1 }, 空: { notes: ' ' } } }),
    ).resolves.toEqual(call('manager.replyQuestion', 's1', 'q1', { kind: 'answer', answers: { 'どちら?': 'A 案' }, annotations: { 'どちら?': { notes: '余白を広く' } } }));
  });

  it('許可の確認のカードの返事も、形を確かめてから渡す（形の違う返事・理由の無い断りは渡さずに false）', async () => {
    await expect(invoke(IpcChannel.PermissionReply, 's1', 'r1', { kind: 'deny', message: '別の方法で' })).resolves.toEqual(
      call('manager.replyPermission', 's1', 'r1', { kind: 'deny', message: '別の方法で' }),
    );
    await expect(invoke(IpcChannel.PermissionReply, 's1', 'r1', { kind: 'allow', always: 'yes' })).resolves.toEqual(call('manager.replyPermission', 's1', 'r1', { kind: 'allow' }));
    await expect(invoke(IpcChannel.PermissionReply, 's1', 'r1', { kind: 'deny', message: '  ' })).resolves.toBe(false);
    await expect(invoke(IpcChannel.PermissionReply, 's1', 'r1', { kind: 'press-enter' })).resolves.toBe(false);
  });

  // [チャンネル, 画面から送る引数, 呼ばれる作り物, そのメソッド, 渡る引数]
  const listens: [string, unknown[], string, string, unknown[]][] = [
    [IpcChannel.SessionsInterrupt, ['s1'], 'SessionManager', 'interrupt', ['s1']],
    [IpcChannel.SessionsFocus, ['s1'], 'SessionManager', 'focus', ['s1']],
    [IpcChannel.SessionsFocus, [null], 'SessionManager', 'focus', [null]],
    [IpcChannel.PtyWrite, ['s1', '\x1b[A'], 'SessionManager', 'write', ['s1', '\x1b[A']],
    [IpcChannel.PtyResize, ['s1', 132, 43], 'SessionManager', 'resize', ['s1', 132, 43]],
    [IpcChannel.PtyResetSize, ['s1'], 'SessionManager', 'resize', ['s1', DEFAULT_PTY_SIZE.cols, DEFAULT_PTY_SIZE.rows]],
    [IpcChannel.ShellWrite, ['sh1', 'ls\r'], 'ShellTerminals', 'write', ['sh1', 'ls\r']],
    [IpcChannel.ShellResize, ['sh1', 90, 20], 'ShellTerminals', 'resize', ['sh1', 90, 20]],
    [IpcChannel.ShellKill, ['sh1'], 'ShellTerminals', 'kill', ['sh1']],
    [IpcChannel.BrowserAttach, ['s1', 'tab-1', 42], 'BrowserControl', 'attach', ['s1', 'tab-1', 42]],
    [IpcChannel.WatchOpenFiles, [{ '/work': ['a.ts', '/outside/memo.md'] }], 'OpenFileWatchers', 'set', [{ '/work': ['a.ts', '/outside/memo.md'] }]],
    [IpcChannel.BrowserActivate, ['s1', null], 'BrowserControl', 'activate', ['s1', null]],
    [IpcChannel.BrowserAnswer, ['s1', 'ask-1', { done: false, reason: 'ログインできない' }], 'BrowserControl', 'answerAsk', ['s1', 'ask-1', { done: false, reason: 'ログインできない' }]],
  ];

  it.each(listens)('知らせ %s（%j）は、%s の %s に引数をそのまま渡す', (channel, args, name, method, expected) => {
    sendFromRenderer(channel, ...args);
    expect(the(name)[method].mock.calls).toEqual([expected]);
  });
});

describe('セッションを始める', () => {
  it('フォルダが無ければ断る。あれば、worktree を使うかで始め方を変える', async () => {
    await boot();
    const missing = join(state.root, 'missing');
    await expect(invoke(IpcChannel.SessionsCreate, missing, { worktree: false })).rejects.toThrow(`フォルダが見つかりません: ${missing}`);
    // ファイルはフォルダではない
    writeFileSync(join(state.root, 'file'), '');
    await expect(invoke(IpcChannel.SessionsCreate, join(state.root, 'file'), {})).rejects.toThrow('フォルダが見つかりません');
    expect(manager().create).not.toHaveBeenCalled();
    expect(manager().startInWorktree).not.toHaveBeenCalled();

    // 追加したフォルダが無ければ、空の一覧にして渡す
    const options = { worktree: false, model: 'opus' };
    await expect(invoke(IpcChannel.SessionsCreate, state.root, options)).resolves.toEqual(call('manager.create', state.root, { ...options, addedFolders: [] }));
    const inWorktree = { worktree: true, model: null };
    await expect(invoke(IpcChannel.SessionsCreate, state.root, inWorktree)).resolves.toBe('in-worktree');
    expect(manager().startInWorktree.mock.calls).toEqual([[state.root, { ...inWorktree, addedFolders: [] }]]);
    // worktree を作り終えたら、画面には何も知らせない
    await new Promise((r) => setTimeout(r, 0));
    expect(sentToRenderer(IpcChannel.SessionsCreateFailed)).toEqual([]);
  });

  it('新規セッションの画面で追加したフォルダは、始める時点で確かめ直して渡す（無くなった・セッションのフォルダの中のもの・重なりは外す）', async () => {
    await boot();
    const project = join(state.root, 'project');
    const other = join(state.root, 'other');
    const link = join(state.root, 'link');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(other);
    symlinkSync(other, link);
    const addedFolders = [other, join(project, 'src'), join(state.root, 'gone'), link];
    await invoke(IpcChannel.SessionsCreate, project, { worktree: false, addedFolders });
    // リンクは解いてから比べるので、other と重なる
    expect(manager().create.mock.calls).toEqual([[project, { worktree: false, addedFolders: [other] }]]);
    await invoke(IpcChannel.SessionsCreate, project, { worktree: true, addedFolders });
    expect(manager().startInWorktree.mock.calls).toEqual([[project, { worktree: true, addedFolders: [other] }]]);
  });

  it('worktree で始めるときは、Claude Code が worktree を作るのを待たずに id を返す。作れなかったら、理由を画面に知らせる', async () => {
    await boot();
    let fail!: (error: unknown) => void;
    const created = new Promise<boolean>((_resolve, reject) => (fail = reject));
    manager().startInWorktree.mockResolvedValueOnce({ id: 'w1', created });
    // 作っている途中でも返る
    await expect(invoke(IpcChannel.SessionsCreate, state.root, { worktree: true })).resolves.toBe('w1');
    expect(sentToRenderer(IpcChannel.SessionsCreateFailed)).toEqual([]);
    fail(new Error('Claude Code が worktree を作れませんでした'));
    await new Promise((r) => setTimeout(r, 0));
    expect(sentToRenderer(IpcChannel.SessionsCreateFailed)).toEqual([{ id: 'w1', cwd: state.root, error: 'Claude Code が worktree を作れませんでした' }]);
  });

  it('worktree を作っている途中で人がアーカイブした・一覧から消したとき（created が false）は、知らせない', async () => {
    await boot();
    manager().startInWorktree.mockResolvedValueOnce({ id: 'w2', created: Promise.resolve(false) });
    await expect(invoke(IpcChannel.SessionsCreate, state.root, { worktree: true })).resolves.toBe('w2');
    await new Promise((r) => setTimeout(r, 0));
    expect(sentToRenderer(IpcChannel.SessionsCreateFailed)).toEqual([]);
  });

  it('worktree で始める前に断られたら（git のリポジトリでないなど）、呼び出しがそのまま失敗する', async () => {
    await boot();
    manager().startInWorktree.mockRejectedValueOnce(new Error('git のリポジトリのフォルダを選んでください'));
    await expect(invoke(IpcChannel.SessionsCreate, state.root, { worktree: true })).rejects.toThrow('git のリポジトリのフォルダを選んでください');
    expect(sentToRenderer(IpcChannel.SessionsCreateFailed)).toEqual([]);
  });
});

describe('フォルダ（新規セッションの画面）', () => {
  it('フォルダを選ぶダイアログ。キャンセルなら null。主ウインドウがあれば、その上に出す', async () => {
    await boot();
    await expect(invoke(IpcChannel.FolderPick)).resolves.toBeNull();
    const [win, options] = state.dialog.showOpenDialog.mock.calls[0];
    expect(win).toBe(mainWindow());
    expect(options).toEqual({ title: '作業するフォルダを選択', properties: ['openDirectory', 'createDirectory'] });

    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [state.root] });
    await expect(invoke(IpcChannel.FolderPick)).resolves.toBe(state.root);
    // 選んだのに、パスが無い
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(invoke(IpcChannel.FolderPick)).resolves.toBeNull();
    // キャンセルしたら、パスが返ってきても使わない（開けるフォルダにも足さない）
    const other = join(state.root, 'other');
    mkdirSync(other);
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [other] });
    await expect(invoke(IpcChannel.FolderPick)).resolves.toBeNull();
    await expect(invoke(IpcChannel.FolderOpen, other)).rejects.toThrow('フォルダを開けません');
  });

  it('主ウインドウを閉じたあとに、閉じた画面から届いた呼び出しは受けない（ダイアログを出さない）', async () => {
    await boot();
    mainWindow().emit('closed');
    await expect(invoke(IpcChannel.FolderPick)).rejects.toThrow('アプリの画面からの呼び出しではありません');
    expect(state.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('「親にする」で読ませる TANACODE_PARENT.md は、パスだけを返す（中身は画面に渡さない）。フォルダは、その直下を探す', async () => {
    // プロファイルのフォルダ（Claude Code の設定のフォルダ）も見るので、手元の ~/.claude に左右されないよう、空のフォルダにする
    const saved = process.env.CLAUDE_CONFIG_DIR;
    onTestFinished(() => {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    });
    await boot();
    process.env.CLAUDE_CONFIG_DIR = join(state.root, 'empty-profile');
    await expect(invoke(IpcChannel.SessionsParentInstructions, 'parent')).resolves.toBe('/work/parent/TANACODE_PARENT.md');
    await expect(invoke(IpcChannel.SessionsParentInstructions, 's1')).resolves.toBeNull();
    await expect(invoke(IpcChannel.FolderParentInstructions, state.root)).resolves.toBeNull();
    writeFileSync(join(state.root, 'TANACODE_PARENT.md'), '# 親の決まり');
    await expect(invoke(IpcChannel.FolderParentInstructions, state.root)).resolves.toBe(join(state.root, 'TANACODE_PARENT.md'));
    // .claude/worktrees/<名前> を選んだら、元のリポジトリの直下も見る（始めたあとに main が探す場所と同じ）
    const worktree = join(state.root, '.claude', 'worktrees', 'w1');
    mkdirSync(worktree, { recursive: true });
    await expect(invoke(IpcChannel.FolderParentInstructions, worktree)).resolves.toBe(join(state.root, 'TANACODE_PARENT.md'));
    // worktree で始めるなら、リポジトリのいちばん上を見る（サブフォルダを選んでいても。worktree はいちばん上から作られる）
    const repo = join(state.root, 'repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'TANACODE_PARENT.md'), '# 親の決まり');
    await expect(invoke(IpcChannel.FolderParentInstructions, join(repo, 'sub'))).resolves.toBeNull();
    await expect(invoke(IpcChannel.FolderParentInstructions, join(repo, 'sub'), true)).resolves.toBe(join(realpathSync(repo), 'TANACODE_PARENT.md'));
    // リポジトリでなければ、選んだフォルダ
    await expect(invoke(IpcChannel.FolderParentInstructions, state.root, true)).resolves.toBe(join(state.root, 'TANACODE_PARENT.md'));
  });

  it('新規セッションの画面の「親として始める」は、プロファイルのフォルダ（Claude Code の設定のフォルダ）の TANACODE_PARENT.md だけでも選べる', async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    await boot();
    // 設定のフォルダは、呼んだときの環境変数で決まる（claude-config.ts）
    const profile = join(state.root, 'profile');
    mkdirSync(profile, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = profile;
    try {
      const work = join(state.root, 'work');
      mkdirSync(work, { recursive: true });
      await expect(invoke(IpcChannel.FolderParentInstructions, work)).resolves.toBeNull();
      writeFileSync(join(profile, 'TANACODE_PARENT.md'), '# プロファイルの親の決まり');
      await expect(invoke(IpcChannel.FolderParentInstructions, work)).resolves.toBe(join(profile, 'TANACODE_PARENT.md'));
      // 両方あれば、プロファイルのもの（読ませる順のはじめ）
      writeFileSync(join(work, 'TANACODE_PARENT.md'), '# フォルダの親の決まり');
      await expect(invoke(IpcChannel.FolderParentInstructions, work)).resolves.toBe(join(profile, 'TANACODE_PARENT.md'));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it('フォルダの情報は、フォルダがあるときだけ読む', async () => {
    await boot();
    await expect(invoke(IpcChannel.FolderInfo, join(state.root, 'missing'))).resolves.toBeNull();
    await expect(invoke(IpcChannel.FolderInfo, state.root)).resolves.toEqual(callIn(state.root, 'workspace.info'));
  });

  it('フォルダのファイルの一覧は、読めなければ空。画像も読めなければ null。ほかの読み取りの失敗は、画面に返す', async () => {
    await boot();
    await expect(invoke(IpcChannel.FolderFiles, '/work/cafe')).resolves.toEqual(callIn('/work/cafe', 'workspace.listFiles'));
    state.failingCwds.set('/work/locked', undefined);
    state.failingCwds.set(cwdOf('locked'), undefined);
    await expect(invoke(IpcChannel.FolderFiles, '/work/locked')).resolves.toEqual([]);
    await expect(invoke(IpcChannel.ReadImage, 'locked', 'logo.png')).resolves.toBeNull();
    await expect(invoke(IpcChannel.ReadFile, 'locked', 'README.md')).rejects.toThrow('EACCES: workspace.readFile');
    await expect(invoke(IpcChannel.ListFiles, 'locked')).rejects.toThrow('EACCES: workspace.listFiles');
  });

  it('開けるフォルダは、選んだフォルダとセッションのフォルダ（worktree の元のフォルダも）だけ。開くと、監視を始めて ID を返す', async () => {
    await boot();
    const picked = join(state.root, 'picked');
    const session = join(state.root, 'session');
    const worktreeRoot = join(state.root, 'repo');
    for (const dir of [picked, session, worktreeRoot]) mkdirSync(dir);
    manager().list.mockReturnValue([
      { id: 's1', cwd: session, worktree: null },
      { id: 's2', cwd: join(worktreeRoot, '.claude/worktrees/w'), worktree: { root: worktreeRoot } },
    ]);
    // 知らないフォルダは開かない（画面から任意のフォルダを読ませない）
    await expect(invoke(IpcChannel.FolderOpen, picked)).rejects.toThrow(`フォルダを開けません: ${picked}`);
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [picked] });
    await invoke(IpcChannel.FolderPick);

    const ids: unknown[] = [];
    for (const dir of [picked, session, worktreeRoot]) ids.push(await invoke(IpcChannel.FolderOpen, dir));
    for (const id of ids) expect(id).toMatch(/^folder:[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(3);
    expect(the('WorkspaceWatchers').retain.mock.calls).toEqual([[picked], [session], [worktreeRoot]]);

    // 開いたフォルダの ID で、エクスプローラー・ソース管理・ターミナルが、そのフォルダを使う
    await expect(invoke(IpcChannel.WorkspaceInfo, ids[0])).resolves.toEqual(callIn(picked, 'workspace.info'));
    await expect(invoke(IpcChannel.GitState, ids[1])).resolves.toEqual(callIn(session, 'scm.state'));
    await expect(invoke(IpcChannel.ShellCreate, ids[2], 80, 24)).resolves.toEqual(call('shells.create', ids[2], worktreeRoot, 80, 24));
  });

  it('知っているフォルダでも、フォルダでなくなっていたら開かない', async () => {
    await boot();
    const gone = join(state.root, 'gone');
    manager().list.mockReturnValue([{ id: 's1', cwd: gone, worktree: null }]);
    await expect(invoke(IpcChannel.FolderOpen, gone)).rejects.toThrow(`フォルダを開けません: ${gone}`);
    expect(the('WorkspaceWatchers').retain).not.toHaveBeenCalled();
  });

  it('閉じると、監視をやめ、そのフォルダで開いたターミナルとブラウザも閉じる。知らない ID は何もしない', async () => {
    await boot();
    manager().list.mockReturnValue([{ id: 's1', cwd: state.root, worktree: null }]);
    const id = (await invoke(IpcChannel.FolderOpen, state.root)) as string;
    sendFromRenderer(IpcChannel.FolderClose, 'folder:unknown');
    expect(the('WorkspaceWatchers').release).not.toHaveBeenCalled();
    expect(the('ShellTerminals').killOwner).not.toHaveBeenCalled();
    expect(the('BrowserControl').forget).not.toHaveBeenCalled();

    sendFromRenderer(IpcChannel.FolderClose, id);
    expect(the('WorkspaceWatchers').release.mock.calls).toEqual([[state.root]]);
    expect(the('ShellTerminals').killOwner.mock.calls).toEqual([[id]]);
    expect(the('BrowserControl').forget.mock.calls).toEqual([[id]]);
    // 閉じた ID は、もうそのフォルダを指さない
    await expect(invoke(IpcChannel.WorkspaceInfo, id)).resolves.toEqual(callIn(cwdOf(id), 'workspace.info'));
    // 2 回閉じても、監視を 2 回やめない
    sendFromRenderer(IpcChannel.FolderClose, id);
    expect(the('WorkspaceWatchers').release).toHaveBeenCalledTimes(1);
  });
});

describe('画面の読み込み直し（⌘R）', () => {
  it('アプリの画面を読み込み直すと、前の画面が開いた新規セッションの画面のフォルダを閉じ、シェルは止めずに、新しい画面が引き継ぐまで知らせを止める', async () => {
    await boot();
    manager().list.mockReturnValue([{ id: 's1', cwd: state.root, worktree: null }]);
    const id = (await invoke(IpcChannel.FolderOpen, state.root)) as string;
    const contents = mainWindow().webContents;
    // 同じ文書の中の移動（# の付け替えなど）と、中のフレームの移動では、何もしない
    contents.emit('did-start-navigation', fakeEvent({ isMainFrame: true, isSameDocument: true, url: `${contents.url}#top` }));
    contents.emit('did-start-navigation', fakeEvent({ isMainFrame: false, isSameDocument: false, url: 'about:blank' }));
    expect(the('ShellTerminals').detach).not.toHaveBeenCalled();
    expect(the('WorkspaceWatchers').release).not.toHaveBeenCalled();

    contents.emit('did-start-navigation', fakeEvent({ isMainFrame: true, isSameDocument: false, url: contents.url }));
    expect(the('ShellTerminals').detach).toHaveBeenCalledTimes(1);
    expect(the('WorkspaceWatchers').release.mock.calls).toEqual([[state.root]]);
    expect(the('ShellTerminals').killOwner.mock.calls).toEqual([[id]]);
    expect(the('ShellTerminals').killAll).not.toHaveBeenCalled();
    expect(the('BrowserControl').forget.mock.calls).toEqual([[id]]);
    // 前の画面のフォルダの ID は、もうそのフォルダを指さない
    await expect(invoke(IpcChannel.WorkspaceInfo, id)).resolves.toEqual(callIn(cwdOf(id), 'workspace.info'));
    // 新しい画面が、動いているシェルを引き継ぐ
    await expect(invoke(IpcChannel.ShellAttach)).resolves.toEqual(call('shells.attach'));
  });

  it('URL の違う移動（Finder のファイルを落とした・リンク）は、止めるので読み込み直しにならない。フォルダは閉じず、シェルの知らせも止めない', async () => {
    await boot();
    manager().list.mockReturnValue([{ id: 's1', cwd: state.root, worktree: null }]);
    await invoke(IpcChannel.FolderOpen, state.root);
    const contents = mainWindow().webContents;
    // Electron は、移り始めた知らせ（did-start-navigation）を、止められる知らせ（will-navigate）より先に出す
    for (const url of ['file:///Users/me/Desktop/shot.png', 'https://example.com/']) {
      contents.emit('did-start-navigation', fakeEvent({ isMainFrame: true, isSameDocument: false, url }));
      const navigate = fakeEvent();
      contents.emit('will-navigate', navigate, url);
      expect(navigate.preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(the('ShellTerminals').detach).not.toHaveBeenCalled();
    expect(the('WorkspaceWatchers').release).not.toHaveBeenCalled();
    expect(the('ShellTerminals').killOwner).not.toHaveBeenCalled();
  });
});

describe('ワークスペースに追加するフォルダ', () => {
  it('追加するフォルダは、セッションのフォルダから始まるダイアログで選ぶ。取りやめたら null で、何も変えない', async () => {
    await boot();
    await expect(invoke(IpcChannel.WorkspaceAddFolder, 's1')).resolves.toBeNull();
    expect(state.dialog.showOpenDialog.mock.calls).toEqual([
      [mainWindow(), { title: 'ワークスペースに追加するフォルダを選択', defaultPath: cwdOf('s1'), properties: ['openDirectory', 'createDirectory'] }],
    ]);
    expect(manager().setAddedFolders).not.toHaveBeenCalled();
  });

  it('セッションでは、選んだフォルダ（リンクは解く）を今の一覧の最後に足して manager に渡し、足したあとの一覧を返す。もう足してあれば何もしない', async () => {
    await boot();
    const other = join(state.root, 'other');
    const link = join(state.root, 'link');
    mkdirSync(other);
    symlinkSync(other, link);
    manager().addedFoldersOf.mockReturnValue(['/elsewhere']);
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [link] });
    await expect(invoke(IpcChannel.WorkspaceAddFolder, 's1')).resolves.toEqual(['/elsewhere', other]);
    expect(manager().addedFoldersOf.mock.calls).toEqual([['s1']]);
    expect(manager().setAddedFolders.mock.calls).toEqual([['s1', ['/elsewhere', other]]]);

    manager().addedFoldersOf.mockReturnValue(['/elsewhere', other]);
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [other] });
    await expect(invoke(IpcChannel.WorkspaceAddFolder, 's1')).resolves.toEqual(['/elsewhere', other]);
    expect(manager().setAddedFolders).toHaveBeenCalledTimes(1);
  });

  it('セッションのフォルダとその中・ファイル・無いフォルダ・ディスクのいちばん上は、理由を添えて断る', async () => {
    await boot();
    const file = join(state.root, 'file');
    writeFileSync(file, '');
    manager().cwdOf.mockReturnValue(state.root);
    mkdirSync(join(state.root, 'src'));
    const cases: [string, string][] = [
      [state.root, `セッションのフォルダの中のフォルダは、もうエクスプローラーに出ているので追加しません: ${state.root}`],
      [join(state.root, 'src'), 'もうエクスプローラーに出ているので追加しません'],
      [file, `フォルダが見つかりません: ${file}`],
      [join(state.root, 'gone'), 'フォルダが見つかりません'],
      ['/', 'ディスクのいちばん上のフォルダは追加できません: /'],
    ];
    for (const [folder, message] of cases) {
      state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [folder] });
      await expect(invoke(IpcChannel.WorkspaceAddFolder, 's1')).rejects.toThrow(message);
    }
    expect(manager().setAddedFolders).not.toHaveBeenCalled();
  });

  it('セッションから外すときは、そのフォルダだけを除いた一覧を manager に渡して返す', async () => {
    await boot();
    manager().addedFoldersOf.mockReturnValue(['/a', '/b', '/c']);
    await expect(invoke(IpcChannel.WorkspaceRemoveFolder, 's1', '/b')).resolves.toEqual(['/a', '/c']);
    expect(manager().setAddedFolders.mock.calls).toEqual([['s1', ['/a', '/c']]]);
    // 追加していないフォルダなら、何も変えない（動いている Claude Code を起動し直させない）
    await expect(invoke(IpcChannel.WorkspaceRemoveFolder, 's1', '/x')).resolves.toEqual(['/a', '/b', '/c']);
    expect(manager().setAddedFolders).toHaveBeenCalledTimes(1);
  });

  it('新規セッションの画面のフォルダでは、アプリが一覧を覚えて見張る。外す・画面を閉じると見張りをやめる', async () => {
    await boot();
    const project = join(state.root, 'project');
    const a = join(state.root, 'a');
    const b = join(state.root, 'b');
    for (const dir of [project, a, b]) mkdirSync(dir);
    manager().list.mockReturnValue([{ id: 's1', cwd: project, worktree: null }]);
    const id = (await invoke(IpcChannel.FolderOpen, project)) as string;
    const watchers = the('WorkspaceWatchers');
    expect(watchers.retain.mock.calls).toEqual([[project]]);

    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [a] });
    await expect(invoke(IpcChannel.WorkspaceAddFolder, id)).resolves.toEqual([a]);
    // ダイアログは、新規セッションの画面で選んでいるフォルダから始める
    expect(state.dialog.showOpenDialog.mock.calls[0][1]).toMatchObject({ defaultPath: project });
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [b] });
    await expect(invoke(IpcChannel.WorkspaceAddFolder, id)).resolves.toEqual([a, b]);
    // もう足してあるフォルダは、2 回見張らない
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [a] });
    await expect(invoke(IpcChannel.WorkspaceAddFolder, id)).resolves.toEqual([a, b]);
    expect(watchers.retain.mock.calls).toEqual([[project], [a], [b]]);
    // セッションの記録には触らない
    expect(manager().setAddedFolders).not.toHaveBeenCalled();

    await expect(invoke(IpcChannel.WorkspaceRemoveFolder, id, a)).resolves.toEqual([b]);
    expect(watchers.release.mock.calls).toEqual([[a]]);
    sendFromRenderer(IpcChannel.FolderClose, id);
    expect(watchers.release.mock.calls).toEqual([[a], [b], [project]]);
    // 閉じた ID は、もう新規セッションの画面のフォルダではない（セッションとして manager に聞く）
    expect(manager().addedFoldersOf).not.toHaveBeenCalled();
    await invoke(IpcChannel.WorkspaceRemoveFolder, id, b);
    expect(manager().addedFoldersOf.mock.calls).toEqual([[id]]);
    expect(watchers.release).toHaveBeenCalledTimes(3);
  });
});

describe('アーカイブ・一覧から消す', () => {
  it('アーカイブは、子セッションも含めてブラウザを閉じる。シェルを閉じるのは worktree を消すときだけ。返事は manager の結果', async () => {
    await boot();
    manager().childrenOf.mockReturnValue(['c1', 'c2']);
    await expect(invoke(IpcChannel.SessionsArchive, 's1', { removeWorktree: false })).resolves.toEqual(call('manager.archive', 's1', { removeWorktree: false }));
    expect(manager().childrenOf.mock.calls).toEqual([['s1']]);
    expect(the('BrowserControl').forget.mock.calls).toEqual([['s1'], ['c1'], ['c2']]);
    await expect(invoke(IpcChannel.SessionsArchive, 's1')).resolves.toEqual(call('manager.archive', 's1', undefined));
    expect(the('ShellTerminals').killOwner).not.toHaveBeenCalled();
    await invoke(IpcChannel.SessionsArchive, 's1', { removeWorktree: true });
    expect(the('ShellTerminals').killOwner.mock.calls).toEqual([['s1']]);
  });

  it('一覧から消すと、シェルとブラウザを閉じ、消えたセッション（子も）のチェックリストとウォークスルーを捨てる。残ったものは残す', async () => {
    await boot();
    const sessions = new Map<string, { id: string; archived: boolean }>(['s1', 'c1', 'c2', 'c3'].map((id) => [id, { id, archived: false }]));
    manager().childrenOf.mockReturnValue(['c1', 'c2', 'c3']);
    manager().summary.mockImplementation((id: string) => sessions.get(id));
    // c1 は消え、c3 はアーカイブに残り、c2 は戻しておいた子として動き続ける（どれも manager が決めたもの）
    manager().remove.mockImplementation(async (id: string, options: unknown) => {
      sessions.delete('s1');
      sessions.delete('c1');
      sessions.set('c3', { id: 'c3', archived: true });
      return { removed: id, options };
    });
    await expect(invoke(IpcChannel.SessionsRemove, 's1', { removeWorktree: true })).resolves.toEqual({ removed: 's1', options: { removeWorktree: true } });
    expect(the('ShellTerminals').killOwner.mock.calls).toEqual([['s1']]);
    // ブラウザを閉じるのは、消したセッションと、消えた・アーカイブ済みの子だけ（動き続ける子のブラウザは残す）
    expect(the('BrowserControl').forget.mock.calls).toEqual([['s1'], ['c1'], ['c3']]);
    // 消したあとに、消えたかを確かめる
    expect(the('ChecklistStore').remove.mock.calls).toEqual([['s1'], ['c1']]);
    expect(the('WalkthroughControl').forget.mock.calls).toEqual([['s1'], ['c1']]);
  });

  it('消せなかったら、チェックリストとウォークスルーは残す。ブラウザは、消そうとしたセッションと、アーカイブ済みの子のものだけを閉じる', async () => {
    await boot();
    manager().childrenOf.mockReturnValue(['c1', 'c2']);
    manager().summary.mockImplementation((id: string) => ({ id, archived: id !== 'c2' }));
    manager().remove.mockRejectedValue(new Error('worktree を消せません'));
    await expect(invoke(IpcChannel.SessionsRemove, 's1')).rejects.toThrow('worktree を消せません');
    expect(the('ChecklistStore').remove).not.toHaveBeenCalled();
    expect(the('WalkthroughControl').forget).not.toHaveBeenCalled();
    expect(the('BrowserControl').forget.mock.calls).toEqual([['s1'], ['c1']]);
  });
});

describe('送信と予約', () => {
  it('送信: 本文が無ければ空の文字、添付と札（貼り付けた長い文）は文字のものだけを渡す', async () => {
    await boot();
    await invoke(IpcChannel.SessionsSubmit, 's1', 'こんにちは', ['/a.png', 3, null, '/b.png'], ['ログ\n2 行目', 7, null]);
    await invoke(IpcChannel.SessionsSubmit, 's2', null, 'not-array', 'not-array');
    await invoke(IpcChannel.SessionsSubmit, 's3', undefined, undefined);
    expect(manager().submit.mock.calls).toEqual([
      ['s1', 'こんにちは', ['/a.png', '/b.png'], ['ログ\n2 行目']],
      ['s2', '', [], []],
      ['s3', '', [], []],
    ]);
  });

  it('送信: 「親として始める」（asParent が true のときだけ）は、TANACODE_PARENT.md を付けた本文にして渡す', async () => {
    await boot();
    await invoke(IpcChannel.SessionsSubmit, 's1', '画面を作って', [], [], { asParent: true });
    await invoke(IpcChannel.SessionsSubmit, 's2', '画面を作って', [], [], { asParent: 'yes' });
    await invoke(IpcChannel.SessionsSubmit, 's3', '画面を作って', [], [], { asParent: false });
    expect(manager().withParentRole.mock.calls).toEqual([['s1', '画面を作って']]);
    expect(manager().submit.mock.calls).toEqual([
      ['s1', '<role of s1>画面を作って', [], []],
      ['s2', '画面を作って', [], []],
      ['s3', '画面を作って', [], []],
    ]);
  });

  it('予約: 画面から届いた値を、文字・数に直して渡す', async () => {
    await boot();
    await expect(invoke(IpcChannel.ScheduledAdd, 's1', '明日の朝に', ['/a.png', 1], 1_700_000_000_000, ['ログ', 2])).resolves.toBeUndefined();
    await invoke(IpcChannel.ScheduledAdd, 7, null, null, '1700000000000');
    expect(the('ScheduledMessages').add.mock.calls).toEqual([
      ['s1', '明日の朝に', ['/a.png'], 1_700_000_000_000, ['ログ']],
      ['7', '', [], 1_700_000_000_000, []],
    ]);
    await expect(invoke(IpcChannel.ScheduledReschedule, 3, '42')).resolves.toEqual(call('scheduled.reschedule', '3', 42));
    await expect(invoke(IpcChannel.ScheduledSendNow, 3)).resolves.toEqual(call('scheduled.sendNow', '3'));
    await expect(invoke(IpcChannel.ScheduledCancel, 3)).resolves.toEqual(call('scheduled.cancel', '3'));
  });
});

describe('作業の書き出し', () => {
  it('中身か名前が文字でなければ、ダイアログを出さずに断る', async () => {
    await boot();
    await expect(invoke(IpcChannel.SessionsExportSave, 42, '作業')).rejects.toThrow('書き出す中身がありません');
    await expect(invoke(IpcChannel.SessionsExportSave, '<html></html>', null)).rejects.toThrow('書き出す中身がありません');
    expect(state.dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it.each([
    ['作業 2026-10-07', '作業 2026-10-07.html'],
    ['a/b\\c:d\x07e', 'a b c d e.html'],
    ['..hidden', 'hidden.html'],
    ['report.html', 'report.html'],
    ['   ', '作業.html'],
    ['...', '作業.html'],
    ['あ'.repeat(130), `${'あ'.repeat(120)}.html`],
  ])('保存のダイアログの既定の場所は、ダウンロードの「%s」→「%s」（パスの区切り・制御文字・先頭の . を除き、120 文字まで）', async (name, expected) => {
    await boot();
    await expect(invoke(IpcChannel.SessionsExportSave, '<html></html>', name)).resolves.toBeNull();
    expect(state.dialog.showSaveDialog.mock.calls).toEqual([
      [
        mainWindow(),
        {
          title: '作業を書き出す',
          defaultPath: join(state.downloads, expected),
          filters: [{ name: 'HTML', extensions: ['html'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        },
      ],
    ]);
  });

  it('保存すると、本人だけが読めるファイルにし（上書きでも）、保存したファイルだけを Finder で見せる', async () => {
    await boot();
    const target = join(state.root, 'out.html');
    writeFileSync(target, '前のもの', { mode: 0o644 });
    state.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
    await expect(invoke(IpcChannel.SessionsExportSave, '<html>会話</html>', '作業')).resolves.toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('<html>会話</html>');
    expect(statSync(target).mode & 0o777).toBe(0o600);

    sendFromRenderer(IpcChannel.SessionsExportReveal, join(state.root, 'other.html'));
    expect(state.shell.showItemInFolder).not.toHaveBeenCalled();
    sendFromRenderer(IpcChannel.SessionsExportReveal, target);
    expect(state.shell.showItemInFolder.mock.calls).toEqual([[target]]);
  });

  it('保存先が無ければ保存しない。主ウインドウを閉じたあとに、閉じた画面から届いた呼び出しは受けない', async () => {
    await boot();
    state.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: undefined });
    await expect(invoke(IpcChannel.SessionsExportSave, '<html></html>', '作業')).resolves.toBeNull();
    expect(state.dialog.showSaveDialog.mock.calls[0][1]).toMatchObject({ defaultPath: join(state.downloads, '作業.html') });
    mainWindow().emit('closed');
    await expect(invoke(IpcChannel.SessionsExportSave, '<html></html>', '作業')).rejects.toThrow('アプリの画面からの呼び出しではありません');
    expect(state.dialog.showSaveDialog).toHaveBeenCalledTimes(1);
  });
});

describe('チェックリスト', () => {
  const card = (thread: { kind: string; author: string; at: number }[], extra: Record<string, unknown> = {}) => ({ id: 'c', thread, readByHuman: 10, readByClaude: 0, ...extra });
  const reply = (author: string, at: number) => ({ kind: 'reply', author, at });

  it('読むのは、一覧にあるセッションのものだけ', async () => {
    await boot();
    state.checklists.set('s1', [{ id: 'l1' }]);
    await expect(invoke(IpcChannel.ChecklistGet, 's1')).resolves.toEqual([]);
    expect(the('ChecklistStore').lists).not.toHaveBeenCalled();
    manager().summary.mockImplementation((id: string) => (id === 's1' ? { id } : undefined));
    await expect(invoke(IpcChannel.ChecklistGet, 's1')).resolves.toEqual([{ id: 'l1' }]);
  });

  it('書き換えは、一覧に無いセッション・形の違うものを断る。正しければ、確かめた形で渡す', async () => {
    await boot();
    const op = { type: 'card-add', listId: 'l1', title: '確かめる' };
    await expect(invoke(IpcChannel.ChecklistApply, 'gone', op)).rejects.toThrow('セッションが見つかりません');
    manager().summary.mockImplementation((id: string) => (id === 's1' ? { id } : undefined));
    await expect(invoke(IpcChannel.ChecklistApply, 's1', { type: 'card-add', listId: 3, title: 'x' })).rejects.toThrow('listId が文字ではありません');
    await expect(invoke(IpcChannel.ChecklistApply, 's1', null)).rejects.toThrow('書き換えの形が違います');
    expect(the('ChecklistControl').apply).not.toHaveBeenCalled();
    await expect(invoke(IpcChannel.ChecklistApply, 's1', op)).resolves.toBeUndefined();
    expect(the('ChecklistControl').apply.mock.calls).toEqual([['s1', op]]);
  });

  it('別のセッションへのコピーは、形を確かめてから渡す', async () => {
    await boot();
    await expect(invoke(IpcChannel.ChecklistCopy, { fromSession: 's1' })).rejects.toThrow('コピーの指定の形が違います');
    expect(the('ChecklistControl').copy).not.toHaveBeenCalled();
    const request = { fromSession: 's1', listId: 'l1', toSession: 's2', cardIds: ['c1'], notify: true };
    await expect(invoke(IpcChannel.ChecklistCopy, request)).resolves.toEqual(call('checklistControl.copy', request));
  });

  it('未読の数は、Claude の返信を人がまだ読んでいないセッションだけ（ゴミ箱のものは数えない）', async () => {
    await boot();
    manager().list.mockReturnValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }]);
    state.checklists.set('s1', [{ id: 'l1', cards: [card([reply('claude', 11), reply('claude', 12), reply('human', 13), reply('claude', 9)])] }]);
    state.checklists.set('s2', [{ id: 'l1', cards: [card([reply('claude', 5)])] }]);
    state.checklists.set('s3', [{ id: 'l1', deletedAt: 1, cards: [card([reply('claude', 11)])] }]);
    state.checklists.set('s4', [{ id: 'l1', cards: [card([reply('claude', 11)], { deletedAt: 1 }), card([reply('claude', 20)])] }]);
    await expect(invoke(IpcChannel.ChecklistUnread)).resolves.toEqual({ s1: 2, s4: 1 });
  });
});

describe('ウォークスルー', () => {
  it('見るステップを変える・閉じるときは、画面から届いた値を文字・数に直して渡す', async () => {
    await boot();
    await expect(invoke(IpcChannel.WalkthroughGo, 5, '2')).resolves.toEqual(call('walkthrough.go', '5', 2));
    await expect(invoke(IpcChannel.WalkthroughClose, 5)).resolves.toEqual(call('walkthrough.close', '5'));
  });

  it('一覧が無ければ空', async () => {
    await boot();
    the('WalkthroughControl').list.mockReturnValue(undefined);
    await expect(invoke(IpcChannel.WalkthroughGet)).resolves.toEqual([]);
  });

  it('PR に載せる下見: 一覧に無いセッション・ウォークスルーの無いセッションは、理由を返す', async () => {
    await boot();
    const reason = { ok: false, reason: 'ウォークスルーがありません。' };
    the('WalkthroughControl').get.mockReturnValue({ id: 'w1' });
    await expect(invoke(IpcChannel.WalkthroughDraftComment, 's1')).resolves.toEqual(reason);
    the('WalkthroughControl').get.mockReturnValue(null);
    expect(the('WalkthroughControl').get).not.toHaveBeenCalled();
    manager().summary.mockReturnValue({ id: 's1' });
    await expect(invoke(IpcChannel.WalkthroughDraftComment, 's1')).resolves.toEqual(reason);
    expect(state.fn.draftWalkthroughComment).not.toHaveBeenCalled();
  });

  it('PR に載せる下見: セッションのフォルダで、前に載せた先と、gh で PR を調べる・書く関数を渡して作る', async () => {
    await boot();
    const walkthrough = { id: 'w1', title: '支払いの流れ' };
    manager().summary.mockReturnValue({ id: '5' });
    the('WalkthroughControl').get.mockReturnValue(walkthrough);
    const deps = { pullRequests: githubModule.pullRequestsOf, comment: githubModule.commentOnPullRequest };
    const result = await invoke(IpcChannel.WalkthroughDraftComment, 5);
    expect(state.fn.draftWalkthroughComment.mock.calls).toEqual([[cwdOf('5'), walkthrough, 'posted:w1', deps]]);
    expect(result).toEqual({ ok: true, call: 'draftWalkthroughComment', args: [cwdOf('5'), walkthrough, 'posted:w1', deps] });
    expect(manager().summary.mock.calls).toEqual([['5']]);
    expect(the('WalkthroughControl').get.mock.calls).toEqual([['5']]);
  });

  it('PR に載せる: ウォークスルーが無い・本文が文字でなければ断る。載せたら、載せた先を覚えて URL を返す', async () => {
    await boot();
    await expect(invoke(IpcChannel.WalkthroughPostComment, 's1', '本文', true)).rejects.toThrow('ウォークスルーがありません。');
    const walkthrough = { id: 'w1' };
    // 一覧から消えたセッションのものは、残っていても載せない
    the('WalkthroughControl').get.mockReturnValue(walkthrough);
    await expect(invoke(IpcChannel.WalkthroughPostComment, 's1', '本文', true)).rejects.toThrow('ウォークスルーがありません。');
    the('WalkthroughControl').get.mockReturnValue(null);
    manager().summary.mockReturnValue({ id: 's1' });
    await expect(invoke(IpcChannel.WalkthroughPostComment, 's1', '本文', true)).rejects.toThrow('ウォークスルーがありません。');
    the('WalkthroughControl').get.mockReturnValue(walkthrough);
    await expect(invoke(IpcChannel.WalkthroughPostComment, 's1', 42, true)).rejects.toThrow('本文がありません。');
    expect(state.fn.postWalkthroughComment).not.toHaveBeenCalled();

    const url = 'https://github.com/me/cafe/pull/12#issuecomment-1';
    await expect(invoke(IpcChannel.WalkthroughPostComment, 's1', '本文', undefined)).resolves.toBe(url);
    const deps = { pullRequests: githubModule.pullRequestsOf, comment: githubModule.commentOnPullRequest };
    // 添え書き（attribution）は、false のときだけ付けない
    await invoke(IpcChannel.WalkthroughPostComment, 's1', '本文 2', false);
    await invoke(IpcChannel.WalkthroughPostComment, 's1', '本文 3', 'no');
    expect(state.fn.postWalkthroughComment.mock.calls).toEqual([
      [cwdOf('s1'), walkthrough, '本文', true, deps],
      [cwdOf('s1'), walkthrough, '本文 2', false, deps],
      [cwdOf('s1'), walkthrough, '本文 3', true, deps],
    ]);
    expect(the('WalkthroughControl').markPosted.mock.calls[0]).toEqual(['w1', url]);
  });

  it('PR に載せられなかったら、載せた先は覚えない', async () => {
    await boot();
    manager().summary.mockReturnValue({ id: 's1' });
    the('WalkthroughControl').get.mockReturnValue({ id: 'w1' });
    state.fn.postWalkthroughComment.mockRejectedValueOnce(new Error('gh: 権限がありません'));
    await expect(invoke(IpcChannel.WalkthroughPostComment, 's1', '本文', true)).rejects.toThrow('gh: 権限がありません');
    expect(the('WalkthroughControl').markPosted).not.toHaveBeenCalled();
  });
});

describe('通知・モデル・翻訳', () => {
  const savedSettings = () => JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8')) as Record<string, unknown>;

  it('通知の設定は、true のときだけオンにして保存する', async () => {
    await boot();
    await expect(invoke(IpcChannel.NotificationsGet)).resolves.toBe(true);
    await invoke(IpcChannel.NotificationsSet, false);
    await expect(invoke(IpcChannel.NotificationsGet)).resolves.toBe(false);
    expect(savedSettings().notifications).toBe(false);
    await invoke(IpcChannel.NotificationsSet, 'yes');
    await expect(invoke(IpcChannel.NotificationsGet)).resolves.toBe(false);
    await invoke(IpcChannel.NotificationsSet, true);
    await expect(invoke(IpcChannel.NotificationsGet)).resolves.toBe(true);
    expect(savedSettings().notifications).toBe(true);
  });

  it('Claude に送る文は、アプリ全体の設定に、画面が送った欄だけを今の保存の値に重ねて保存する（null・空は既定に戻す。既定の文と同じ欄・知らない欄は持たない）。予約と最適化圧縮は、送るたびにそれを読む', async () => {
    await boot();
    await expect(invoke(IpcChannel.PromptsGet)).resolves.toEqual({});
    const usageResume = '枠が戻りました。報告して待ってください。';
    await expect(invoke(IpcChannel.PromptsUpdate, { usageResume, handoff: defaultPrompt('handoff'), resume: '  ', other: '知らない欄' })).resolves.toEqual({ usageResume });
    await expect(invoke(IpcChannel.PromptsGet)).resolves.toEqual({ usageResume });
    expect(savedSettings().prompts).toEqual({ usageResume });
    const prompts = (argsOf('UsageLimitResume')[0] as { prompts: () => unknown }).prompts;
    expect(prompts()).toEqual({ usageResume });
    // 別の窓で、別の欄だけを変えた。先に変えた欄は残る
    await expect(invoke(IpcChannel.PromptsUpdate, { resume: '報告して待って' })).resolves.toEqual({ usageResume, resume: '報告して待って' });
    // 既定に戻す（null）。送っていない欄は残る
    await expect(invoke(IpcChannel.PromptsUpdate, { usageResume: null })).resolves.toEqual({ resume: '報告して待って' });
    expect(prompts()).toEqual({ resume: '報告して待って' });
    // 形の違う値は、何も変えない
    await expect(invoke(IpcChannel.PromptsUpdate, '壊れた値')).resolves.toEqual({ resume: '報告して待って' });
    await expect(invoke(IpcChannel.PromptsUpdate, { resume: 3 })).resolves.toEqual({ resume: '報告して待って' });
  });

  it('モデルの一覧。読めなければ null', async () => {
    await boot();
    await expect(invoke(IpcChannel.ModelsGet)).resolves.toEqual({ models: ['opus'] });
    state.fn.readModelCatalog.mockRejectedValueOnce(new Error('壊れています'));
    await expect(invoke(IpcChannel.ModelsGet)).resolves.toBeNull();
  });

  it('モデルの一覧を読み直す。控えが無い・読めないときは、理由を返す', async () => {
    await boot();
    await expect(invoke(IpcChannel.ModelsRefresh)).resolves.toEqual({ catalog: { models: ['opus'] } });
    state.fn.readModelCatalog.mockResolvedValueOnce(null);
    await expect(invoke(IpcChannel.ModelsRefresh)).resolves.toEqual({ error: 'Claude Code のモデル一覧の控え（~/.claude/cache/model-catalog）がありません' });
    state.fn.readModelCatalog.mockRejectedValueOnce(new Error('壊れています'));
    await expect(invoke(IpcChannel.ModelsRefresh)).resolves.toEqual({ error: '壊れています' });
    state.fn.readModelCatalog.mockRejectedValueOnce('EIO');
    await expect(invoke(IpcChannel.ModelsRefresh)).resolves.toEqual({ error: 'EIO' });
  });

  it('翻訳が使えるのは、補助プログラムがあり、macOS 15 以降のとき（開発中は build/native のもの）', async () => {
    await boot();
    const helper = join(state.appPath, 'build/native/tanacode-translate');
    expect(argsOf('Translator')).toEqual([helper]);
    await expect(invoke(IpcChannel.TranslateAvailable)).resolves.toBe(false);
    await boot({
      before: (s) => {
        mkdirSync(join(s.appPath, 'build/native'), { recursive: true });
        writeFileSync(join(s.appPath, 'build/native/tanacode-translate'), '');
      },
    });
    await expect(invoke(IpcChannel.TranslateAvailable)).resolves.toBe(true);
    setSystemVersion('14.7.2');
    await expect(invoke(IpcChannel.TranslateAvailable)).resolves.toBe(false);
  });

  it('パッケージしたアプリでは、Resources の補助プログラムを使う', async () => {
    await boot({ packaged: true, before: (s) => writeFileSync(join(s.resources, 'tanacode-translate'), '') });
    expect(argsOf('Translator')).toEqual([join(state.resources, 'tanacode-translate')]);
    await expect(invoke(IpcChannel.TranslateAvailable)).resolves.toBe(true);
  });

  it('訳す文字の形が違えば、補助プログラムを呼ばずに断る', async () => {
    await boot();
    await expect(invoke(IpcChannel.TranslateRun, 'こんにちは')).rejects.toThrow('訳す文字の形が違います');
    await expect(invoke(IpcChannel.TranslateRun, ['a', 1])).rejects.toThrow('訳す文字の形が違います');
    expect(the('Translator').translate).not.toHaveBeenCalled();
  });

  it('翻訳のデータを入れる「言語と地域」の設定を開く', async () => {
    await boot();
    await invoke(IpcChannel.TranslateOpenSettings);
    expect(state.shell.openExternal.mock.calls).toEqual([[LANGUAGE_SETTINGS_URL]]);
  });

  it('設定ファイルを選ぶダイアログは、~/.claude から始めて、隠しファイルも見せる。キャンセルなら null', async () => {
    await boot();
    const options = {
      title: '設定ファイルを選択',
      defaultPath: join(homedir(), '.claude'),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    await expect(invoke(IpcChannel.SettingsFilesPick)).resolves.toBeNull();
    expect(state.dialog.showOpenDialog.mock.calls).toEqual([[mainWindow(), options]]);
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/me/.claude/work.json'] });
    await expect(invoke(IpcChannel.SettingsFilesPick)).resolves.toBe('/Users/me/.claude/work.json');
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(invoke(IpcChannel.SettingsFilesPick)).resolves.toBeNull();
    // キャンセルしたら、パスが返ってきても使わない
    state.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/Users/me/.claude/work.json'] });
    await expect(invoke(IpcChannel.SettingsFilesPick)).resolves.toBeNull();
  });
});

describe('アプリ内ブラウザ', () => {
  it('ふだんのブラウザで開くのは、http(s) のページだけ', async () => {
    await boot();
    for (const url of ['https://example.test/a', 'HTTP://LOCALHOST:3000/', 'file:///etc/passwd', 'javascript:alert(1)', ' https://example.test', 42]) {
      await invoke(IpcChannel.BrowserOpenExternal, url);
    }
    expect(state.shell.openExternal.mock.calls).toEqual([['https://example.test/a'], ['HTTP://LOCALHOST:3000/']]);
  });

  it('Claude に許す先は、書き方をそろえ、重なりを除いて保存する。空・文字でないものは除く', async () => {
    await boot();
    await expect(invoke(IpcChannel.BrowserHostsGet)).resolves.toEqual([]);
    const saved = ['example.test', '*.dev.test', '192.168.0.10'];
    await expect(invoke(IpcChannel.BrowserHostsSet, [' Example.TEST ', '*.dev.test', 'example.test', '', '  ', 3, '192.168.0.10'])).resolves.toEqual(saved);
    await expect(invoke(IpcChannel.BrowserHostsGet)).resolves.toEqual(saved);
    expect(JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8')).browserHosts).toEqual(saved);
    await expect(invoke(IpcChannel.BrowserHostsSet, 'example.test')).resolves.toEqual([]);
    await expect(invoke(IpcChannel.BrowserHostsGet)).resolves.toEqual([]);
  });

  it('書き方の違うものがあれば、保存せずに断る', async () => {
    await boot();
    await invoke(IpcChannel.BrowserHostsSet, ['ok.test']);
    await expect(invoke(IpcChannel.BrowserHostsSet, ['good.test', '*', 'a b'])).rejects.toThrow(
      '書き方が違います: *、a b（例: example.test・*.example.test・192.168.0.10）',
    );
    await expect(invoke(IpcChannel.BrowserHostsGet)).resolves.toEqual(['ok.test']);
  });
});

describe('Git の操作', () => {
  it.each([
    [{ kind: 'stage', paths: ['a.ts', 'b.ts'] }, 'stage', [['a.ts', 'b.ts']]],
    [{ kind: 'unstage', paths: ['a.ts'] }, 'unstage', [['a.ts']]],
    [{ kind: 'discard', paths: ['c.ts'] }, 'discard', [['c.ts']]],
    [{ kind: 'commit', message: '直す', amend: true }, 'commit', ['直す', true]],
    [{ kind: 'push' }, 'push', []],
    [{ kind: 'pull' }, 'pull', []],
    [{ kind: 'fetch' }, 'fetch', []],
    [{ kind: 'checkout', branch: 'feature/x', mode: 'remote' }, 'checkout', ['feature/x', 'remote']],
    [{ kind: 'switch-default' }, 'switchToLatestDefault', []],
  ])('%j は、セッションのフォルダのソース管理の %s を呼ぶ。終わったら null', async (action, method, args) => {
    await boot();
    await expect(invoke(IpcChannel.GitRun, 's1', action)).resolves.toBeNull();
    expect(argsOf('SourceControl')).toEqual([cwdOf('s1')]);
    const scm = the('SourceControl');
    expect(scm[method].mock.calls).toEqual([args]);
    // ほかの操作は呼ばない
    const others = Object.entries(scm).filter(([name, fn]) => name !== method && fn.mock.calls.length > 0);
    expect(others).toEqual([]);
  });

  it('失敗したら、エラーの文を返す（Error でないものは文字にして）。知らない操作は何もしない', async () => {
    await boot();
    state.failingCwds.set(cwdOf('bad'), undefined);
    await expect(invoke(IpcChannel.GitRun, 'bad', { kind: 'push' })).resolves.toBe('EACCES: scm.push');
    state.failingCwds.set(cwdOf('odd'), 'rejected');
    await expect(invoke(IpcChannel.GitRun, 'odd', { kind: 'fetch' })).resolves.toBe('rejected');
    await expect(invoke(IpcChannel.GitRun, 's1', { kind: 'rebase' })).resolves.toBeNull();
    const scm = the('SourceControl');
    expect(Object.values(scm).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});

describe('貼り付け・ドロップした画像', () => {
  it('userData の attachments に、重ならない名前で保存してパスを返す。名前のフォルダと記号は除く', async () => {
    await boot();
    const dir = join(state.userData, 'attachments');
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const first = (await invoke(IpcChannel.AttachmentSave, '../../etc/スクリーンショット 1.png', data)) as string;
    expect(first.startsWith(`${dir}/`)).toBe(true);
    expect(first.slice(dir.length + 1)).toMatch(/^[0-9a-f]{8}-_{10}1\.png$/);
    expect([...readFileSync(first)]).toEqual([...data]);
    const second = (await invoke(IpcChannel.AttachmentSave, '../../etc/スクリーンショット 1.png', data)) as string;
    expect(second).not.toBe(first);
    const unnamed = (await invoke(IpcChannel.AttachmentSave, '', data)) as string;
    expect(unnamed.slice(dir.length + 1)).toMatch(/^[0-9a-f]{8}-image\.png$/);
    expect(readdirSync(dir)).toHaveLength(3);
    expect(existsSync(join(state.root, 'etc'))).toBe(false);
  });
});

describe('不具合（いまのコードで落ちる）', () => {
  // 書き出しのファイル名は、先頭の . を除いて隠しファイルにしない（saveExport）。ところが、. を除いてから前後の空白を除くので、
  // 先頭が空白・制御文字（空白に置き換える）のあとに . が来ると、. が先頭に残って隠しファイルの名前になる。
  // ふだんは画面（exportFileName）が先に空白を詰めて trim するので起きない。main の守りの穴（実害は小さい）
  it.each([' .zshrc', '\x01.env'])('名前（%j）の先頭が空白・制御文字でも、隠しファイル（. で始まる名前）にしない', async (name) => {
    await boot();
    await invoke(IpcChannel.SessionsExportSave, '<html></html>', name);
    const { defaultPath } = state.dialog.showSaveDialog.mock.calls[0][1] as { defaultPath: string };
    expect(defaultPath.slice(state.downloads.length + 1).startsWith('.')).toBe(false);
  });
});
