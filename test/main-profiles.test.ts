import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { allOf, boot, cleanup, fakeEvent, invoke, invokeFrom, mainWindow, menuItem, sendWith, state, type Fake, type FakeView, type FakeWebContents } from './helpers/main-app';

// プロファイル（Claude Code のアカウントごとの環境）を複数開いたとき（src/main/index.ts）。
// 足したプロファイルは、それぞれの pty ホスト・データ・Claude Code の設定のフォルダを持ち、画面はウインドウに重ねて出し分ける

afterEach(() => cleanup());

const PERSONAL = { id: 'p2', name: '個人', color: '#d4835c', claudeDir: '/Users/me/.claude-me' };
const PROFILES = { default: { name: '会社', color: '#6d9ccf' }, profiles: [PERSONAL] };

// プロファイルごとの作り物（作った順。既定のプロファイルが先）
const managers = () => allOf('SessionManager');
const managerOf = (index: number) => managers()[index]!.instance as Fake;
type Listeners = { onSessionsChanged: (sessions: unknown[]) => void; onTurnCompleted: (session: { id: string; title: string | null }) => void };
const listenersOf = (index: number) => managers()[index]!.args[4] as Listeners;
// SessionManager に渡す、プロファイルの Claude Code の設定のフォルダ（index.ts の new SessionManager(...) の 13 番目の引数）
const claudeDirOf = (index: number) => managers()[index]!.args[12];
// SessionManager に渡す、セッションの MCP サーバーの材料（10 番目の引数）
const sessionsLaunchOf = (index: number) => (managers()[index]!.args[9] as () => { permissionsDir?: string } | null)();
const view = () => state.views[0] as FakeView;
const sentTo = (contents: { sent: [string, unknown][] }, channel: string) => contents.sent.filter(([c]) => c === channel).map(([, payload]) => payload);

describe('足したプロファイルを開く', () => {
  it('それぞれの pty ホストとデータのフォルダ・Claude Code の設定のフォルダで開き、画面をウインドウに重ねる（見ていなければ隠す）', async () => {
    await boot({ profiles: PROFILES });
    expect(state.ptyHostStart.mock.calls.map((c) => c[0])).toEqual([state.userData, join(state.userData, 'profiles', 'p2')]);
    expect(managers()).toHaveLength(2);
    // 既定のプロファイルは、アプリの環境変数のまま（null）
    expect(claudeDirOf(0)).toBeNull();
    expect(claudeDirOf(1)).toBe('/Users/me/.claude-me');
    expect(state.views).toHaveLength(1);
    expect(view().options).toMatchObject({ webPreferences: { partition: 'persist:tanacode-profile-p2', webviewTag: true } });
    expect(mainWindow().contentView.children).toEqual([view()]);
    expect(view().visible).toBe(false);
    expect(view().webContents.loadFile).toHaveBeenCalledTimes(1);
    expect(view().bounds).toEqual({ x: 0, y: 0, ...(({ width, height }) => ({ width, height }))(mainWindow().getContentBounds()) });
    // ウインドウの大きさが変わったら合わせる
    mainWindow().bounds = { ...mainWindow().bounds, width: 1000, height: 700 };
    mainWindow().emit('resize');
    expect(view().bounds).toEqual({ x: 0, y: 0, width: 1000, height: 672 });
  });

  it('画面からの呼び出しは、送り元の画面のプロファイルに渡す。知らない画面からの呼び出しは断る', async () => {
    await boot({ profiles: PROFILES });
    await invokeFrom(view().webContents, IpcChannel.SessionsList);
    expect(managerOf(1).list).toHaveBeenCalledTimes(1);
    expect(managerOf(0).list).not.toHaveBeenCalled();
    await invoke(IpcChannel.SessionsList);
    expect(managerOf(0).list).toHaveBeenCalledTimes(1);
    // アプリの画面でないもの（プロファイルの無い画面）からは受けない
    await expect(invokeFrom({}, IpcChannel.SessionsList)).rejects.toThrow('アプリの画面からの呼び出しではありません');
    // プロファイルの様子は、その画面から見たもの
    const profiles = [{ id: 'default', name: '会社', color: '#6d9ccf', claudeDir: null }, PERSONAL];
    await expect(invokeFrom(view().webContents, IpcChannel.ProfilesGet)).resolves.toEqual({ profiles, current: 'p2', othersAttention: false });
    await expect(invoke(IpcChannel.ProfilesGet)).resolves.toEqual({ profiles, current: 'default', othersAttention: false });
  });

  it('切り替えると、そのプロファイルの画面だけを出して入力を向ける（メニューはアプリ全体の設定なので、そのまま）', async () => {
    await boot({ profiles: PROFILES });
    const menu = state.menu;
    await invoke(IpcChannel.ProfilesSwitch, 'p2');
    expect(view().visible).toBe(true);
    expect(view().webContents.focus).toHaveBeenCalledTimes(1);
    expect(state.menu).toBe(menu);
    await invokeFrom(view().webContents, IpcChannel.ProfilesSwitch, 'default');
    expect(view().visible).toBe(false);
    // 開いていないプロファイルには変えない
    await invoke(IpcChannel.ProfilesSwitch, 'nope');
    expect(view().visible).toBe(false);
  });

  it('Claude のツールの許可はアプリ全体で 1 つ: どのプロファイルのセッションも同じ印のフォルダを見て、見ているプロファイルによらず同じ設定を変える', async () => {
    await boot({ profiles: PROFILES });
    const permissionsDir = join(state.userData, 'tool-permissions');
    expect(sessionsLaunchOf(0)).toMatchObject({ permissionsDir });
    expect(sessionsLaunchOf(1)).toMatchObject({ permissionsDir });
    await invoke(IpcChannel.ProfilesSwitch, 'p2');
    await invokeFrom(view().webContents, IpcChannel.ToolPermissionsSet, 'mcp__tanacode-sessions__start_session', 'allow');
    expect(existsSync(join(permissionsDir, 'mcp__tanacode-sessions__start_session.allow'))).toBe(true);
    // アプリ全体の設定（既定のプロファイルと同じファイル）に保存し、足したプロファイルの設定には書かない
    expect(JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8'))).toMatchObject({ toolPermissions: { 'mcp__tanacode-sessions__start_session': 'allow' } });
    expect(existsSync(join(state.userData, 'profiles', 'p2', 'settings.json'))).toBe(false);
    await expect(invoke(IpcChannel.McpSettingsGet)).resolves.toMatchObject({ permissions: { 'mcp__tanacode-sessions__start_session': 'allow' } });
  });

  // 足したプロファイルの、前のバージョンの設定のファイル
  const writeP2Settings = (s: typeof state, values: Record<string, unknown>) => {
    mkdirSync(join(s.userData, 'profiles', 'p2'), { recursive: true });
    writeFileSync(join(s.userData, 'profiles', 'p2', 'settings.json'), JSON.stringify({ version: 1, ...values }));
  };
  const p2SettingsFile = () => join(state.userData, 'profiles', 'p2', 'settings.json');
  const globalSettings = () => JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8')) as Record<string, unknown>;
  // SessionManager に渡す、チェックリストの MCP サーバーの材料（11 番目の引数）
  const checklistLaunchOf = (index: number) => (managers()[index]!.args[10] as () => unknown)();

  it('MCP の切り替えと Claude の自動の動きはアプリ全体で 1 つ: どのプロファイルを見ていても、同じ値を出し、切り替えはどのプロファイルのセッションにも効く', async () => {
    await boot({ profiles: PROFILES, settings: { checklistControl: false, browserHosts: ['a.test'] }, before: (s) => writeP2Settings(s, { checklistControl: true, autoCompactPercent: 40 }) });
    // 足したプロファイルのファイルにある前の値は使わない
    expect(checklistLaunchOf(0)).toBeNull();
    expect(checklistLaunchOf(1)).toBeNull();
    await invoke(IpcChannel.ProfilesSwitch, 'p2');
    const enabled = async () => ((await invokeFrom(view().webContents, IpcChannel.McpSettingsGet)) as { enabled: Record<string, boolean> }).enabled;
    expect((await enabled()).checklist).toBe(false);
    expect(menuItem('autoCompactPercent-80').checked).toBe(true);
    await invokeFrom(view().webContents, IpcChannel.McpEnabledSet, 'checklist', true);
    expect(checklistLaunchOf(0)).not.toBeNull();
    expect(checklistLaunchOf(1)).not.toBeNull();
    menuItem('autoCompactPercent-60').click?.({});
    expect(globalSettings()).toMatchObject({ checklistControl: true, autoCompactPercent: 60 });
    // 足したプロファイルのファイルは書き換えない
    expect(JSON.parse(readFileSync(p2SettingsFile(), 'utf8'))).toEqual({ version: 1, checklistControl: true, autoCompactPercent: 40 });
    await invoke(IpcChannel.ProfilesSwitch, 'default');
    expect(((await invoke(IpcChannel.McpSettingsGet)) as { enabled: Record<string, boolean> }).enabled.checklist).toBe(true);
    expect(menuItem('autoCompactPercent-60').checked).toBe(true);
    // ブラウザの操作をオフにしたら、どのプロファイルでも頼んでいる操作を取り下げる
    await invoke(IpcChannel.McpEnabledSet, 'browser', false);
    expect(allOf('BrowserControl').map((c) => (c.instance as Fake).turnOff.mock.calls.length)).toEqual([1, 1]);
    // 許す先も、どのプロファイルの画面から読んでも同じ
    await expect(invokeFrom(view().webContents, IpcChannel.BrowserHostsGet)).resolves.toEqual(['a.test']);
  });

  it('前のバージョンで足したプロファイルが持っていた設定は、安全なほうに倒して 1 つにまとめる（一度だけ）: 許す機能・利用枠の再開はどれかでオフならオフ、許す先は和、大きさと待つ時間は既定のプロファイルの値', async () => {
    await boot({
      profiles: PROFILES,
      settings: { browserHosts: ['shared.test', 'a.test'], terminalControl: false, autoCompactPercent: 60, prompts: { usageResume: '続けて' } },
      before: (s) =>
        writeP2Settings(s, { browserHosts: ['p2.test', 'shared.test'], terminalControl: true, checklistControl: false, browserControl: false, usageLimitResume: false, autoCompactPercent: 40, awayWaitMinutes: 30 }),
    });
    expect(globalSettings()).toMatchObject({
      browserHosts: ['shared.test', 'a.test', 'p2.test'],
      browserControl: false,
      sessionsControl: true,
      checklistControl: false,
      walkthroughControl: true,
      terminalControl: false,
      usageLimitResume: false,
      autoCompactPercent: 60,
      awayWaitMinutes: 5,
      prompts: { usageResume: '続けて' },
      profilesMerged: true,
    });
    // 足したプロファイルのファイルは消さない
    expect(existsSync(p2SettingsFile())).toBe(true);
    // 移し替えたあとは、外した先を、また足さない（オンに戻したものも、またオフにしない）
    await boot({ profiles: PROFILES, settings: { browserHosts: ['a.test'], profilesMerged: true }, before: (s) => writeP2Settings(s, { browserHosts: ['p2.test'], browserControl: false }) });
    expect(globalSettings()).toEqual({ version: 1, browserHosts: ['a.test'], profilesMerged: true });
    expect(((await invoke(IpcChannel.McpSettingsGet)) as { enabled: Record<string, boolean> }).enabled.browser).toBe(true);
  });

  it('アプリ全体の設定のファイルが壊れていたら、移し替えて書き換える前に、元の中身を横に控える', async () => {
    await boot({
      profiles: PROFILES,
      before: (s) => {
        writeFileSync(join(s.userData, 'settings.json'), '{ "prompts": { "usageResume": "続け');
        writeP2Settings(s, { browserHosts: ['p2.test'] });
      },
    });
    const aside = readdirSync(state.userData).filter((name) => name.startsWith('settings.json.broken-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(state.userData, aside[0]!), 'utf8')).toBe('{ "prompts": { "usageResume": "続け');
    expect(globalSettings()).toMatchObject({ browserHosts: ['p2.test'], profilesMerged: true });
  });

  it('移し替えを保存できなくても、起動は続ける。印は付けないので、次の起動でまた移し替える', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await boot({
      profiles: PROFILES,
      settings: { browserHosts: ['a.test'] },
      before: (s) => {
        writeP2Settings(s, { browserHosts: ['p2.test'] });
        // 設定は、一時ファイルに書いてから置き換える。一時ファイルの場所にフォルダがあると、書けない
        mkdirSync(join(s.userData, 'settings.json.tmp'));
      },
    });
    expect(state.views).toHaveLength(1);
    expect(globalSettings()).toEqual({ version: 1, browserHosts: ['a.test'] });
    expect(error).toHaveBeenCalledWith('プロファイルごとの設定を、アプリ全体の設定に移せませんでした', expect.any(Error));
    error.mockRestore();
  });

  it('足したプロファイルの画面から許す先を変えても、アプリ全体の設定に保存する', async () => {
    await boot({ profiles: PROFILES });
    await expect(invokeFrom(view().webContents, IpcChannel.BrowserHostsSet, ['p2.test'])).resolves.toEqual(['p2.test']);
    expect(globalSettings().browserHosts).toEqual(['p2.test']);
    expect(existsSync(p2SettingsFile())).toBe(false);
    await expect(invoke(IpcChannel.BrowserHostsGet)).resolves.toEqual(['p2.test']);
  });

  it('利用枠の再開を切ったら、すべてのプロファイルで待っている予約を取り消す。1 つのプロファイルで投げても、残りでは取り消す', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await boot({ profiles: PROFILES });
    const [first, second] = allOf('UsageLimitResume').map((c) => c.instance as Fake);
    first!.cancelAll.mockImplementationOnce(() => {
      throw new Error('取り消せません');
    });
    const item = menuItem('usageLimitResume');
    item.checked = false;
    item.click?.(item);
    expect(first!.cancelAll).toHaveBeenCalledTimes(1);
    expect(second!.cancelAll).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('利用枠からの再開の予約を取り消せませんでした', 'default', expect.any(Error));
    error.mockRestore();
  });

  it('ブラウザの操作を切ったとき、1 つのプロファイルで投げても、残りでは頼んでいる操作を取り下げる', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await boot({ profiles: PROFILES });
    const [first, second] = allOf('BrowserControl').map((c) => c.instance as Fake);
    first!.turnOff.mockImplementationOnce(() => {
      throw new Error('取り下げられません');
    });
    await invoke(IpcChannel.McpEnabledSet, 'browser', false);
    expect(second!.turnOff).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('アプリ内ブラウザの操作を取り下げられませんでした', 'default', expect.any(Error));
    error.mockRestore();
  });

  it('チェックリストを切り替えた・自動で最適化圧縮する大きさを変えたら、すべてのプロファイルのセッションに、最適化圧縮の状態を知らせ直す', async () => {
    await boot({ profiles: PROFILES });
    managerOf(0).list.mockReturnValue([{ id: 's1' }]);
    managerOf(1).list.mockReturnValue([{ id: 's2' }]);
    const compactSent = () => [sentTo(mainWindow().webContents, IpcChannel.CompactChanged), sentTo(view().webContents, IpcChannel.CompactChanged)];
    await invoke(IpcChannel.McpEnabledSet, 'checklist', false);
    expect(compactSent().map((sent) => sent.map((p) => (p as { sessionId: string }).sessionId))).toEqual([['s1'], ['s2']]);
    menuItem('autoCompactPercent-40').click?.({});
    expect(compactSent().map((sent) => sent.length)).toEqual([2, 2]);
  });

  it('足したプロファイルが無ければ、移し替えずに、設定のファイルも書かない', async () => {
    await boot();
    expect(existsSync(join(state.userData, 'settings.json'))).toBe(false);
  });

  it('アプリ内ブラウザの webview は、プロファイルごとのセッション（Cookie）を使わせる', async () => {
    await boot({ profiles: PROFILES });
    const attach = (contents: { emit: (event: string, ...args: unknown[]) => unknown }) => {
      const prefs: Record<string, unknown> = { preload: '/x.js', partition: 'persist:tanacode-preview' };
      contents.emit('will-attach-webview', fakeEvent(), prefs, { src: 'about:blank' });
      return prefs;
    };
    expect(attach(view().webContents)).toMatchObject({ partition: 'persist:tanacode-preview-p2', sandbox: true });
    expect(attach(view().webContents).preload).toBeUndefined();
    expect(attach(mainWindow().webContents).partition).toBe('persist:tanacode-preview');
    // 足したプロファイルの webview にも、権限を何も許さない
    expect(state.partitions.get('persist:tanacode-preview-p2')?.checkHandler?.({}, 'clipboard-read', '', { isMainFrame: true })).toBe(false);
  });
});

describe('通知とほかのプロファイルの知らせ', () => {
  it('プロファイルが 2 つ以上なら、サブタイトルにプロファイルの名前を付け、クリックでそのプロファイルに切り替えてセッションを選ばせる', async () => {
    await boot({ profiles: PROFILES });
    listenersOf(1).onTurnCompleted({ id: 's9', title: '調査' });
    const notification = state.notifications.at(-1)!;
    expect(notification.options.subtitle).toBe('個人 · 調査');
    notification.emit('click');
    expect(view().visible).toBe(true);
    expect(sentTo(view().webContents, IpcChannel.SessionsSelect)).toEqual(['s9']);
    expect(sentTo(mainWindow().webContents, IpcChannel.SessionsSelect)).toEqual([]);
  });

  it('ほかのプロファイルに確認待ち・新しい応答があれば、どのプロファイルかは言わずに「通知あり」を知らせる。変わったときだけ', async () => {
    await boot({ profiles: PROFILES });
    managerOf(0).list.mockReturnValue([{ id: 's1', archived: false, attention: null, unread: true }]);
    listenersOf(0).onSessionsChanged([]);
    listenersOf(0).onSessionsChanged([]);
    expect(sentTo(view().webContents, IpcChannel.ProfilesChanged)).toEqual([expect.objectContaining({ current: 'p2', othersAttention: true })]);
    // 自分のセッションは数えない
    expect(sentTo(mainWindow().webContents, IpcChannel.ProfilesChanged)).toEqual([]);
    // アーカイブしたものは数えない
    managerOf(0).list.mockReturnValue([{ id: 's1', archived: true, attention: 'question', unread: true }]);
    listenersOf(0).onSessionsChanged([]);
    expect(sentTo(view().webContents, IpcChannel.ProfilesChanged).at(-1)).toMatchObject({ othersAttention: false });
  });
});

describe('プロファイルの追加と削除', () => {
  it('足すと、Claude Code の設定のフォルダを作って開き、画面を重ねる。外すと、止めて画面を片付け、登録から外す（フォルダは残す）', async () => {
    await boot();
    const claudeDir = join(state.root, '.claude-test');
    const added = (await invoke(IpcChannel.ProfilesAdd, { name: '検証', color: '#5fb98a', claudeDir })) as { id: string };
    expect(existsSync(claudeDir)).toBe(true);
    expect(managers()).toHaveLength(2);
    expect(claudeDirOf(1)).toBe(claudeDir);
    expect(state.views).toHaveLength(1);
    expect(sentTo(mainWindow().webContents, IpcChannel.ProfilesChanged).at(-1)).toMatchObject({ profiles: [{ id: 'default' }, { id: added.id, name: '検証' }] });
    // 同じフォルダは足せない
    await expect(invoke(IpcChannel.ProfilesAdd, { name: '二つ目', color: '#5fb98a', claudeDir })).rejects.toThrow('ほかのプロファイルと同じフォルダです');

    // Claude Code が動いているセッションがあれば外さない
    managerOf(1).liveSessions.mockReturnValue([{ id: 's1', title: '作業', state: '作業中' }]);
    await expect(invoke(IpcChannel.ProfilesRemove, added.id)).rejects.toThrow('Claude Code が動いているセッションがあります');
    managerOf(1).liveSessions.mockReturnValue([]);
    await invoke(IpcChannel.ProfilesSwitch, added.id);
    await invoke(IpcChannel.ProfilesRemove, added.id);
    expect(mainWindow().contentView.children).toEqual([]);
    expect(view().webContents.close).toHaveBeenCalledTimes(1);
    expect(state.ptyHost.shutdown).toHaveBeenCalledTimes(1);
    expect(existsSync(claudeDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(state.userData, 'profiles.json'), 'utf8')).profiles).toEqual([]);
    // 見ていたプロファイルを外したら、既定のプロファイルに戻る
    await expect(invoke(IpcChannel.ProfilesGet)).resolves.toMatchObject({ current: 'default', profiles: [{ id: 'default' }] });
    await expect(invoke(IpcChannel.ProfilesRemove, 'default')).rejects.toThrow('標準のプロファイルは外せません');
  });

  it('開けなかったプロファイルは、登録を戻して理由を返す。起動のときは理由を出して、ほかのプロファイルで続ける', async () => {
    await boot();
    state.ptyHostStart.mockRejectedValueOnce(new Error('pty ホストを起動できません'));
    await expect(invoke(IpcChannel.ProfilesAdd, { name: '検証', color: '#5fb98a', claudeDir: join(state.root, '.claude-x') })).rejects.toThrow('pty ホストを起動できません');
    await expect(invoke(IpcChannel.ProfilesGet)).resolves.toMatchObject({ profiles: [{ id: 'default' }] });
    expect(state.views).toHaveLength(0);

    await boot({ profiles: PROFILES, before: (s) => s.ptyHostStart.mockResolvedValueOnce(s.ptyHost).mockRejectedValueOnce(new Error('壊れています')) });
    expect(state.dialog.showErrorBox).toHaveBeenCalledWith('プロファイル「個人」を開けませんでした', expect.stringContaining('壊れています'));
    expect(state.quit).not.toHaveBeenCalled();
    expect(state.views).toHaveLength(0);
  });

  it('名前と色を変えると、どの画面にも知らせる', async () => {
    await boot({ profiles: PROFILES });
    await invokeFrom(view().webContents, IpcChannel.ProfilesUpdate, 'p2', { name: '自分', color: '#5FB98A' });
    expect(sentTo(mainWindow().webContents, IpcChannel.ProfilesChanged).at(-1)).toMatchObject({ profiles: [{ name: '会社' }, { name: '自分', color: '#5fb98a' }] });
    expect(sentTo(view().webContents, IpcChannel.ProfilesChanged).at(-1)).toMatchObject({ current: 'p2' });
  });
});

describe('プロファイルをまたいで同じにする表示設定', () => {
  const COLUMNS = 'tanacode.columns';
  const savedPrefs = () => (JSON.parse(readFileSync(join(state.userData, 'shared-prefs.json'), 'utf8')) as { values: Record<string, string> }).values;
  const sendFrom = (sender: FakeWebContents, channel: string, ...args: unknown[]) => sendWith({ sender, senderFrame: sender.mainFrame }, channel, ...args);

  it('起動したときは、先に聞いてきた画面の値を採り、あとの画面にはその値を返す（知らないキー・形の違う値は採らない）', async () => {
    await boot({ profiles: PROFILES });
    await expect(invoke(IpcChannel.PrefsSync, { [COLUMNS]: '{"sessions":300}', 'tanacode.sessionOrderLock': '["A"]', 'tanacode.scmView': 1 })).resolves.toEqual({ [COLUMNS]: '{"sessions":300}' });
    await expect(invokeFrom(view().webContents, IpcChannel.PrefsSync, { [COLUMNS]: '{"sessions":200}', 'tanacode.scmView': 'tree' })).resolves.toEqual({
      [COLUMNS]: '{"sessions":300}',
      'tanacode.scmView': 'tree',
    });
    expect(savedPrefs()).toEqual({ [COLUMNS]: '{"sessions":300}', 'tanacode.scmView': 'tree' });
    // あとの画面から採ったものは、先の画面に配る
    expect(sentTo(mainWindow().webContents, IpcChannel.PrefsChanged)).toEqual([{ key: 'tanacode.scmView', value: 'tree' }]);
    await expect(invokeFrom({}, IpcChannel.PrefsSync, {})).rejects.toThrow('アプリの画面からの呼び出しではありません');
  });

  it('変えると覚えて、ほかのプロファイルの画面にだけ配る。次の起動でも同じ値を返す', async () => {
    await boot({ profiles: PROFILES });
    sendFrom(view().webContents, IpcChannel.PrefsSet, COLUMNS, '{"sessions":320}');
    expect(sentTo(mainWindow().webContents, IpcChannel.PrefsChanged)).toEqual([{ key: COLUMNS, value: '{"sessions":320}' }]);
    expect(sentTo(view().webContents, IpcChannel.PrefsChanged)).toEqual([]);
    // 同じ値・知らないキー・長すぎる値では配らない
    sendFrom(view().webContents, IpcChannel.PrefsSet, COLUMNS, '{"sessions":320}');
    sendFrom(view().webContents, IpcChannel.PrefsSet, 'tanacode.newSessionOptions', '{}');
    sendFrom(view().webContents, IpcChannel.PrefsSet, COLUMNS, 'x'.repeat(1001));
    expect(sentTo(mainWindow().webContents, IpcChannel.PrefsChanged)).toHaveLength(1);
    expect(savedPrefs()).toEqual({ [COLUMNS]: '{"sessions":320}' });

    const saved = readFileSync(join(state.userData, 'shared-prefs.json'), 'utf8');
    await boot({ profiles: PROFILES, before: (s) => writeFileSync(join(s.userData, 'shared-prefs.json'), saved) });
    await expect(invoke(IpcChannel.PrefsSync, { [COLUMNS]: '{"sessions":200}' })).resolves.toEqual({ [COLUMNS]: '{"sessions":320}' });
  });
});
