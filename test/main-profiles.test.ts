import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { allOf, boot, cleanup, fakeEvent, invoke, invokeFrom, mainWindow, state, type Fake, type FakeView } from './helpers/main-app';

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
const view = () => state.views[0] as FakeView;
const sentTo = (contents: { sent: [string, unknown][] }, channel: string) => contents.sent.filter(([c]) => c === channel).map(([, payload]) => payload);

describe('足したプロファイルを開く', () => {
  it('それぞれの pty ホストとデータのフォルダ・Claude Code の設定のフォルダで開き、画面をウインドウに重ねる（見ていなければ隠す）', async () => {
    await boot({ profiles: PROFILES });
    expect(state.ptyHostStart.mock.calls.map((c) => c[0])).toEqual([state.userData, join(state.userData, 'profiles', 'p2')]);
    expect(managers()).toHaveLength(2);
    // 既定のプロファイルは、アプリの環境変数のまま（null）
    expect(managers()[0]!.args.at(-1)).toBeNull();
    expect(managers()[1]!.args.at(-1)).toBe('/Users/me/.claude-me');
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
    await expect(invokeFrom({}, IpcChannel.SessionsList)).rejects.toThrow('この画面のプロファイルが見つかりません');
    // プロファイルの様子は、その画面から見たもの
    const profiles = [{ id: 'default', name: '会社', color: '#6d9ccf', claudeDir: null }, PERSONAL];
    await expect(invokeFrom(view().webContents, IpcChannel.ProfilesGet)).resolves.toEqual({ profiles, current: 'p2', othersAttention: false });
    await expect(invoke(IpcChannel.ProfilesGet)).resolves.toEqual({ profiles, current: 'default', othersAttention: false });
  });

  it('切り替えると、そのプロファイルの画面だけを出して入力を向け、メニューを作り直す', async () => {
    await boot({ profiles: PROFILES });
    const menu = state.menu;
    await invoke(IpcChannel.ProfilesSwitch, 'p2');
    expect(view().visible).toBe(true);
    expect(view().webContents.focus).toHaveBeenCalledTimes(1);
    expect(state.menu).not.toBe(menu);
    await invokeFrom(view().webContents, IpcChannel.ProfilesSwitch, 'default');
    expect(view().visible).toBe(false);
    // 開いていないプロファイルには変えない
    await invoke(IpcChannel.ProfilesSwitch, 'nope');
    expect(view().visible).toBe(false);
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
    expect(managers()[1]!.args.at(-1)).toBe(claudeDir);
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
  const sendFrom = (sender: unknown, channel: string, ...args: unknown[]) => state.listeners.get(channel)!({ sender }, ...args);

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
    await expect(invokeFrom({}, IpcChannel.PrefsSync, {})).rejects.toThrow('この画面のプロファイルが見つかりません');
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
