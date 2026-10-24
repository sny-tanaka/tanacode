import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRestart, appUpdateInfo, appUpdateJson, noUpdateReason, restartNoticeText, restartResultText, type AppUpdateInfo, type RestartNotice } from '../src/main/app-restart';

// Claude が頼む tanacode の更新と再起動（restart_app・get_app_update）。終えるのと起動し直すのは index.ts、知らせを送るのは profile.ts

const info = (patch: Partial<AppUpdateInfo> = {}): AppUpdateInfo => ({ current: '2.4.0', latest: '2.4.0', checkEnabled: true, install: 'homebrew', download: null, ...patch });

describe('AppRestart', () => {
  let current: AppUpdateInfo;
  let busy: boolean;
  let quits: boolean[];
  let restart: AppRestart;
  let notices: RestartNotice[];
  const notify = (notice: RestartNotice) => notices.push(notice);

  beforeEach(() => {
    vi.useFakeTimers();
    current = info();
    busy = false;
    quits = [];
    notices = [];
    restart = new AppRestart({ info: () => current, busy: () => busy, quit: (update) => quits.push(update), delayMs: 1000 });
  });
  afterEach(() => vi.useRealTimers());

  it('ダウンロード済みの新しいバージョンがあれば、知らせを積み、結果を返してから少しあとに、入れ替えて終える', () => {
    current = info({ latest: '2.5.0', download: { status: 'ready', version: '2.5.0' } });
    const outcome = restart.request(true, notify);
    expect(outcome).toMatchObject({ restarting: true, to: '2.5.0' });
    expect(notices).toEqual([{ from: '2.4.0', to: '2.5.0' }]);
    // 結果を返す前には終えない（先に終えると、中継への返事が届かない）
    expect(quits).toEqual([]);
    expect(restart.pending()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(quits).toEqual([true]);
  });

  it('入れ替えるものが無ければ、only_if_update では起動し直さずに理由を返す。そうでなければ、そのまま起動し直す', () => {
    const skipped = restart.request(true, notify);
    expect(skipped).toMatchObject({ restarting: false, noUpdate: true });
    expect(skipped.restarting === false && skipped.reason).toBe('tanacode is up to date (v2.4.0). tanacode was not restarted.');
    vi.advanceTimersByTime(5000);
    expect(quits).toEqual([]);
    expect(notices).toEqual([]);
    expect(restart.request(false, notify)).toMatchObject({ restarting: true, to: null });
    expect(notices).toEqual([{ from: '2.4.0', to: null }]);
    vi.advanceTimersByTime(1000);
    expect(quits).toEqual([false]);
  });

  it('終えられなかった・取りやめになったら、もう一度頼めるように戻す', () => {
    restart = new AppRestart({
      info: () => current,
      busy: () => false,
      quit: () => {
        throw new Error('終えられない');
      },
      delayMs: 1000,
    });
    expect(restart.request(false, notify).restarting).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(restart.pending()).toBe(false);
    expect(restart.request(false, notify).restarting).toBe(true);
    // 画面が閉じるのを拒んだとき（index.ts が cancel を呼ぶ）
    restart.cancel();
    expect(restart.pending()).toBe(false);
  });

  it('終了の確認・ほかの再起動の途中なら断る。起動し直すと決めたあとに、もう一度頼まれても終え直さない', () => {
    busy = true;
    expect(restart.request(false, notify)).toMatchObject({ restarting: false, noUpdate: false });
    busy = false;
    expect(restart.request(false, notify).restarting).toBe(true);
    const again = restart.request(false, notify);
    expect(again).toMatchObject({ restarting: false, noUpdate: false });
    vi.advanceTimersByTime(1000);
    expect(quits).toEqual([false]);
    expect(notices).toHaveLength(1);
  });
});

describe('入れ替えるものが無い理由', () => {
  it('入れ方・確かめた結果・ダウンロードの様子ごとに', () => {
    expect(noUpdateReason(info({ install: 'dev' }))).toContain('development build');
    expect(noUpdateReason(info({ install: 'other', latest: '2.5.0' }))).toContain('https://github.com/sny-tanaka/tanacode/releases/tag/v2.5.0');
    expect(noUpdateReason(info({ latest: '2.5.0', download: { status: 'downloading' } }))).toContain('still downloading');
    expect(noUpdateReason(info({ latest: '2.5.0', download: { status: 'failed' } }))).toContain('could not download');
    expect(noUpdateReason(info({ latest: null, checkEnabled: false }))).toBe('The user has turned off "新しいバージョンが出たら通知する" under tanacode, so tanacode does not know of a newer version.');
    expect(noUpdateReason(info({ latest: null }))).toContain('has not been able to check');
  });
});

describe('Claude に返す文', () => {
  it('restart_app の結果: 入れ替えるか、そのまま起動し直すか。セッションは続き、知らせが届くこと', () => {
    const update = restartResultText({ restarting: true, to: '2.5.0', info: info() });
    expect(update).toContain('update from v2.4.0 to v2.5.0');
    expect(update).toContain('Claude Code keeps running');
    // PROTOCOL が上がると、claude が --resume で起動し直されることも伝える
    expect(update).toContain('--resume');
    expect(restartResultText({ restarting: true, to: null, info: info() })).toContain('no downloaded update');
  });

  it('起動し直したあとの知らせ: バージョンが変わった・入れ替えに失敗した・入れ替えずに起動し直した', () => {
    expect(restartNoticeText({ from: '2.4.0', to: '2.5.0' }, '2.5.0', true)).toContain('updated from v2.4.0 to v2.5.0');
    expect(restartNoticeText({ from: '2.4.0', to: '2.5.0' }, '2.4.0', true)).toContain('the update to v2.5.0 failed');
    expect(restartNoticeText({ from: '2.4.0', to: null }, '2.4.0', false)).toBe('tanacode has restarted (v2.4.0). Tell the user in one line.');
    // 入れ替えるつもりが無くても、終了の入れ替え（メニューの設定）で新しくなったら、そう伝える
    expect(restartNoticeText({ from: '2.4.0', to: null }, '2.5.0', true)).toContain('updated from v2.4.0 to v2.5.0');
  });

  it('入れ替えるはずだったのに入れ替えを試さなかった（結果のファイルが無い）ときは、失敗ではなく、入れ替えずに起動し直したと伝える', () => {
    const text = restartNoticeText({ from: '2.4.0', to: '2.5.0' }, '2.4.0', false);
    expect(text).toContain('restarted without installing v2.5.0');
    // Mac に理由を出したとは言わない（入れ替えを試していないので、ダイアログは出ない）
    expect(text).not.toContain('on the Mac');
  });

  it('get_app_update: ダウンロード済みなら restart_app で入れられること、新しいバージョンが無ければその旨', () => {
    const ready = appUpdateInfo('2.4.0', { latest: '2.5.0', available: true, url: '' }, true, 'homebrew', { status: 'ready', version: '2.5.0' });
    expect(appUpdateJson(ready)).toMatchObject({ current_version: '2.4.0', latest_version: '2.5.0', update_available: true, installed_with: 'Homebrew', download: 'ready', ready_to_install: '2.5.0' });
    const latest = appUpdateInfo('2.4.0', { latest: '2.4.0', available: false, url: '' }, true, 'other', null);
    expect(appUpdateJson(latest)).toMatchObject({ update_available: false, note: 'restart_app restarts tanacode without updating.' });
    expect(appUpdateJson(latest)).not.toHaveProperty('download');
  });
});
