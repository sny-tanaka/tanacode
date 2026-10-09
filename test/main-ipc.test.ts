import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { LANGUAGE_SETTINGS_URL } from '../src/main/translate';
import { DEFAULT_PTY_SIZE } from '../src/main/session-manager';
import { invokes, sends } from './helpers/ipc-tables';
import { argsOf, boot, cleanup, githubModule, invoke, mainWindow, manager, sendFromRenderer, setSystemVersion, state, the } from './helpers/main-app';

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
    [IpcChannel.SessionsRestart, ['s1'], call('manager.restart', 's1')],
    [IpcChannel.SessionsSetRemoteControl, ['s1', true], call('manager.setRemoteControl', 's1', true)],
    [IpcChannel.RemoteControlAvailable, [], call('manager.remoteAvailable')],
    [IpcChannel.ScreenGet, ['s1'], call('manager.screenForView', 's1')],
    [IpcChannel.ScreenActivityGet, ['s1'], call('manager.activity', 's1')],
    [IpcChannel.WorkflowsGet, ['s1'], call('manager.workflows', 's1')],
    [IpcChannel.ScreenSetMode, ['s1', 'plan'], call('manager.setMode', 's1', 'plan')],
    [IpcChannel.ScreenRewind, ['s1', '戻す先の発言'], call('manager.rewind', 's1', '戻す先の発言')],
    [IpcChannel.ScreenChoose, ['s1', { kind: 'option', index: 2 }], call('manager.choose', 's1', { kind: 'option', index: 2 })],
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
    [IpcChannel.AccountGet, [], call('readClaudeAccount')],
    [IpcChannel.ClaudeVersionGet, [], call('claudeVersions.get')],
    [IpcChannel.AppUpdateGet, [], call('appUpdates.get')],
    [IpcChannel.BrowserAsksGet, [], call('browser.pendingAsks')],
    [IpcChannel.WalkthroughGet, [], call('walkthrough.list')],
    [IpcChannel.WorkspaceInfo, ['s1'], callIn(cwdOf('s1'), 'workspace.info')],
    [IpcChannel.ListDir, ['s1', 'src/lib'], callIn(cwdOf('s1'), 'workspace.listDir', 'src/lib')],
    [IpcChannel.ReadFile, ['s1', 'README.md'], callIn(cwdOf('s1'), 'workspace.readFile', 'README.md')],
    [IpcChannel.ReadImage, ['s1', 'logo.png'], callIn(cwdOf('s1'), 'workspace.readImage', 'logo.png')],
    [IpcChannel.WriteFile, ['s1', 'a.txt', '中身'], callIn(cwdOf('s1'), 'workspace.writeFile', 'a.txt', '中身')],
    [IpcChannel.ListFiles, ['s1'], callIn(cwdOf('s1'), 'workspace.listFiles')],
    [IpcChannel.Search, ['s1', 'TODO', { regex: true }], callIn(cwdOf('s1'), 'workspace.search', 'TODO', { regex: true })],
    [IpcChannel.GitState, ['s1'], callIn(cwdOf('s1'), 'scm.state')],
    [IpcChannel.GitBranches, ['s1'], callIn(cwdOf('s1'), 'scm.branches')],
    [IpcChannel.GitDiffSides, ['s1', 'src/a.ts', true], callIn(cwdOf('s1'), 'scm.diffSides', 'src/a.ts', true)],
    [IpcChannel.GitBranchDiffSides, ['s1', 'base-sha', 'src/a.ts'], callIn(cwdOf('s1'), 'scm.branchDiffSides', 'base-sha', 'src/a.ts')],
    [IpcChannel.GitBaseline, ['s1', 'base-sha', 'src/a.ts'], callIn(cwdOf('s1'), 'scm.baseline', 'base-sha', 'src/a.ts')],
    [IpcChannel.GitLastMessage, ['s1'], callIn(cwdOf('s1'), 'scm.lastCommitMessage')],
    [IpcChannel.CommandsList, ['s1'], call('listCommands', cwdOf('s1'), '/transcripts/s1.jsonl')],
    [IpcChannel.FolderCommands, ['/work/cafe'], call('listCommands', '/work/cafe', null)],
    [IpcChannel.SessionsDiscover, [], call('discoverSessions', new Set(['known-1']))],
    [
      IpcChannel.SessionsImport,
      [{ claudeSessionId: 'c1', cwd: '/work/cafe', title: '外の会話', updatedAt: 1 }],
      call('manager.importSession', 'c1', '/work/cafe', '外の会話'),
    ],
    [IpcChannel.ShellCreate, ['s1', 120, 40], call('shells.create', 's1', cwdOf('s1'), 120, 40)],
    [IpcChannel.TranslateRun, [['こんにちは', 'Hello']], call('translator.translate', ['こんにちは', 'Hello'])],
  ];

  it.each(cases)('%s は、受け取った引数を正しい相手に渡し、返事をそのまま返す', async (channel, args, expected) => {
    await expect(invoke(channel, ...args)).resolves.toEqual(expected);
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
    expect(manager().createInWorktree).not.toHaveBeenCalled();

    const options = { worktree: false, model: 'opus' };
    await expect(invoke(IpcChannel.SessionsCreate, state.root, options)).resolves.toEqual(call('manager.create', state.root, options));
    const inWorktree = { worktree: true, model: null };
    await expect(invoke(IpcChannel.SessionsCreate, state.root, inWorktree)).resolves.toEqual(call('manager.createInWorktree', state.root, inWorktree));
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

  it('主ウインドウが無いときは、ダイアログを単独で出す', async () => {
    await boot();
    mainWindow().emit('closed');
    await invoke(IpcChannel.FolderPick);
    expect(state.dialog.showOpenDialog.mock.calls[0]).toEqual([{ title: '作業するフォルダを選択', properties: ['openDirectory', 'createDirectory'] }]);
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
    const alive = new Set(['s1', 'c1', 'c2']);
    manager().childrenOf.mockReturnValue(['c1', 'c2']);
    manager().summary.mockImplementation((id: string) => (alive.has(id) ? { id } : undefined));
    // c2 は消えずに残る（manager が残したもの）
    manager().remove.mockImplementation(async (id: string, options: unknown) => {
      alive.delete('s1');
      alive.delete('c1');
      return { removed: id, options };
    });
    await expect(invoke(IpcChannel.SessionsRemove, 's1', { removeWorktree: true })).resolves.toEqual({ removed: 's1', options: { removeWorktree: true } });
    expect(the('ShellTerminals').killOwner.mock.calls).toEqual([['s1']]);
    expect(the('BrowserControl').forget.mock.calls).toEqual([['s1'], ['c1'], ['c2']]);
    // 消したあとに、消えたかを確かめる
    expect(the('ChecklistStore').remove.mock.calls).toEqual([['s1'], ['c1']]);
    expect(the('WalkthroughControl').forget.mock.calls).toEqual([['s1'], ['c1']]);
  });

  it('消せなかったら、チェックリストとウォークスルーは残す', async () => {
    await boot();
    manager().remove.mockRejectedValue(new Error('worktree を消せません'));
    await expect(invoke(IpcChannel.SessionsRemove, 's1')).rejects.toThrow('worktree を消せません');
    expect(the('ChecklistStore').remove).not.toHaveBeenCalled();
    expect(the('WalkthroughControl').forget).not.toHaveBeenCalled();
  });
});

describe('送信と予約', () => {
  it('送信: 本文が無ければ空の文字、添付は文字のものだけを渡す', async () => {
    await boot();
    await invoke(IpcChannel.SessionsSubmit, 's1', 'こんにちは', ['/a.png', 3, null, '/b.png']);
    await invoke(IpcChannel.SessionsSubmit, 's2', null, 'not-array');
    await invoke(IpcChannel.SessionsSubmit, 's3', undefined, undefined);
    expect(manager().submit.mock.calls).toEqual([
      ['s1', 'こんにちは', ['/a.png', '/b.png']],
      ['s2', '', []],
      ['s3', '', []],
    ]);
  });

  it('予約: 画面から届いた値を、文字・数に直して渡す', async () => {
    await boot();
    await expect(invoke(IpcChannel.ScheduledAdd, 's1', '明日の朝に', ['/a.png', 1], 1_700_000_000_000)).resolves.toBeUndefined();
    await invoke(IpcChannel.ScheduledAdd, 7, null, null, '1700000000000');
    expect(the('ScheduledMessages').add.mock.calls).toEqual([
      ['s1', '明日の朝に', ['/a.png'], 1_700_000_000_000],
      ['7', '', [], 1_700_000_000_000],
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

  it('主ウインドウが無いときは、ダイアログを単独で出す。保存先が無ければ保存しない', async () => {
    await boot();
    mainWindow().emit('closed');
    state.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: undefined });
    await expect(invoke(IpcChannel.SessionsExportSave, '<html></html>', '作業')).resolves.toBeNull();
    expect(state.dialog.showSaveDialog.mock.calls[0]).toHaveLength(1);
    expect(state.dialog.showSaveDialog.mock.calls[0][0]).toMatchObject({ defaultPath: join(state.downloads, '作業.html') });
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
    mainWindow().emit('closed');
    await invoke(IpcChannel.SettingsFilesPick);
    expect(state.dialog.showOpenDialog.mock.calls.at(-1)).toEqual([options]);
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
