import type { AppUpdate, HomebrewUpdate } from '@shared/app-update';
import { compareVersions } from '@shared/claude-code';
import { t } from '@shared/i18n';

// Claude が頼む、tanacode の更新と再起動（tanacode-sessions の get_app_update・restart_app）。
// 人がスマホの Remote Control から使っていて Mac の前にいなくても、親の Claude に「tanacode を更新して」と頼めるようにする。
// 再起動はいつも「動かしたまま」（Claude Code を止めない）。常駐の pty ホストが claude を保ち、起動し直したアプリが引き継ぐ。
// Homebrew でダウンロード済みの新しいバージョンがあれば、終わったあとに入れ替えてから起動し直す（タイトルバーの「再起動して更新」と同じ）。
// 呼ぶ前の人の許可の確認は、Claude Code の PreToolUse のフックで出させる（tool-permissions.ts の toolPermissionCommand。メニューの「Claude のツールの許可…」で常に許可にもできる）。
// 結果を Claude に返してから少しあとに終える（先に終えると、中継への返事が届かない）。
// 呼んだセッションには、起動し直したアプリが「再起動しました（古いバージョン → 新しいバージョン、または更新に失敗）」と知らせる
// （SessionNotices の channel 'restart'。sessions.json に残して、次のアプリが送る。profile.ts）

// 入れ方。dev: 開発用のビルド（Homebrew の更新は動かない）/ homebrew: Homebrew で入れた / other: それ以外（pkg・zip・ソースのビルド。
// 起動の直後で、Homebrew で入れたかをまだ確かめていないときも）
export type AppInstall = 'dev' | 'homebrew' | 'other';

// 今の更新の様子。latest: GitHub の Releases の最新バージョン（確かめていない・確かめるのを止めているときは null）/
// checkEnabled: 「新しいバージョンが出たら通知する」がオンか / download: Homebrew での用意（Homebrew で入れていない・まだ何も用意していないときは null）
export type AppUpdateInfo = {
  current: string;
  latest: string | null;
  checkEnabled: boolean;
  install: AppInstall;
  download: HomebrewUpdate | null;
};

// download: HomebrewUpdater の今の様子。新しいバージョンの確認（update）を止めていても、ダウンロード済みのものは入れられるので、そのまま見る
export function appUpdateInfo(current: string, update: AppUpdate | null, checkEnabled: boolean, install: AppInstall, download: HomebrewUpdate | null): AppUpdateInfo {
  return { current, latest: update?.latest ?? null, checkEnabled, install, download };
}

// 起動し直したあとに、呼んだセッションへ送る知らせの中身。from: 終える前のバージョン / to: 入れ替えるはずのバージョン（入れ替えないなら null）
export type RestartNotice = { from: string; to: string | null };

// restart_app の結果。restarting: 起動し直す（to: 入れ替えるバージョン）/ 起動し直さない（reason: Claude に返す理由。
// noUpdate: 頼まれたとおり、入れ替えるものが無いので起動し直さなかった（エラーではない）。ほかは、終了の途中などで断った）
export type RestartOutcome =
  | { restarting: true; to: string | null; info: AppUpdateInfo }
  | { restarting: false; reason: string; noUpdate: boolean; info: AppUpdateInfo };

// 結果を返してから終えるまで。中継が返事を受け取り、Claude Code に渡す間をあける
export const RESTART_DELAY_MS = 1000;

type Deps = {
  info: () => AppUpdateInfo;
  // 終了の確認・ほかの再起動の途中か（言語の再起動・タイトルバーの「再起動して更新」など）
  busy: () => boolean;
  // 動かしたまま終えて、起動し直す。update: ダウンロード済みの新しいバージョンに入れ替えてから
  quit: (update: boolean) => void;
  delayMs?: number;
};

export class AppRestart {
  // 起動し直すと決めた（終えるのを待っている）
  private scheduled = false;

  constructor(private readonly deps: Deps) {}

  // 起動し直すと決めたか（決めたあとは、呼んだセッションへの知らせを、このアプリでは送らない）
  pending(): boolean {
    return this.scheduled;
  }

  // 起動し直す。onlyIfUpdate: ダウンロード済みの新しいバージョンがあるときだけ。notify: 呼んだセッションへの知らせを積む（終える前に記録に残す）
  request(onlyIfUpdate: boolean, notify: (notice: RestartNotice) => void): RestartOutcome {
    const info = this.deps.info();
    if (this.scheduled) return { restarting: false, reason: 'tanacode is already restarting. Wait for the notice that it has restarted.', noUpdate: false, info };
    if (this.deps.busy()) return { restarting: false, reason: BUSY, noUpdate: false, info };
    const to = info.download?.status === 'ready' ? info.download.version : null;
    if (!to && onlyIfUpdate) return { restarting: false, reason: `${noUpdateReason(info)} tanacode was not restarted.`, noUpdate: true, info };
    this.scheduled = true;
    notify({ from: info.current, to });
    setTimeout(() => {
      try {
        this.deps.quit(to !== null);
      } catch {
        // 終えられなかった。もう一度頼めるように戻す（積んだ知らせは、次に起動し直したときに送る）
        this.cancel();
      }
    }, this.deps.delayMs ?? RESTART_DELAY_MS);
    return { restarting: true, to, info };
  }

  // 終えるのが取りやめになった（画面が閉じるのを拒んだ・終えられなかった）。もう一度頼めるように戻す
  cancel(): void {
    this.scheduled = false;
  }
}

const BUSY =
  'tanacode is already quitting or restarting, or is showing the user a dialog about it on the Mac. Nothing was done. Tell the user, and try again later if they still want it.';

// 入れ替える新しいバージョンが無い理由と、次にできること（get_app_update の note にも使う）
export function noUpdateReason(info: AppUpdateInfo): string {
  if (info.install === 'dev') return `This is a development build of tanacode, which cannot update itself.`;
  if (info.latest && compareVersions(info.latest, info.current) > 0) {
    if (info.install === 'other')
      return `v${info.latest} is available, but tanacode was not installed with Homebrew, so it cannot update itself. The user installs it from ${releaseUrl(info.latest)}.`;
    if (info.download?.status === 'failed') return `v${info.latest} is available, but tanacode could not download it with Homebrew (it tries again later).`;
    return `v${info.latest} is available and tanacode is still downloading it with Homebrew. Check again later with get_app_update.`;
  }
  if (!info.checkEnabled) return `The user has turned off "${t('main.menu.notifyUpdates')}" under tanacode, so tanacode does not know of a newer version.`;
  if (!info.latest) return `tanacode has not been able to check for new versions yet (for example, it is offline).`;
  return `tanacode is up to date (v${info.current}).`;
}

function releaseUrl(version: string): string {
  return `https://github.com/sny-tanaka/tanacode/releases/tag/v${version}`;
}

// 再起動の前に Claude に返す、起動し直したあとのこと
const AFTER_RESTART =
  'Claude Code keeps running while tanacode restarts, so this session continues; when tanacode is back, a notice tells you how it went. Finish your reply briefly (tell the user in one line that tanacode is restarting) and end your turn. If the new version changed how tanacode keeps Claude Code running (rare, and not known in advance), Claude Code is restarted with --resume instead: the conversation continues, but a command or background task running at that moment is cut off, so run it again. Tools added in a new version of tanacode appear only after Claude Code is restarted.';

// restart_app の結果の文
export function restartResultText(outcome: RestartOutcome): string {
  if (!outcome.restarting) return outcome.reason;
  const { current } = outcome.info;
  const head = outcome.to ? `tanacode is restarting to update from v${current} to v${outcome.to} (installed with Homebrew).` : `tanacode is restarting (v${current}; no downloaded update to install).`;
  return `${head} ${AFTER_RESTART}`;
}

// 起動し直したあとに、呼んだセッションへ送る知らせ。now: 起動し直したアプリのバージョン /
// upgradeRan: 前のアプリが終わったあとに、入れ替え（brew upgrade）を試した（結果のファイルがあった）
export function restartNoticeText(notice: RestartNotice, now: string, upgradeRan: boolean): string {
  if (compareVersions(now, notice.from) !== 0) return `tanacode has restarted, updated from v${notice.from} to v${now}. Tell the user in one line.`;
  // 頼まれたあと、終えるまでの間に用意が無くなった・入れ替えのシェルを起動できなかったので、入れ替えずに起動し直した
  if (notice.to && !upgradeRan)
    return `tanacode has restarted without installing v${notice.to} (the downloaded update could not be installed when it quit), so it is still v${now}. Check with get_app_update and try again later if the user still wants it. Tell the user in one line.`;
  if (notice.to)
    return `tanacode has restarted, but the update to v${notice.to} failed, so it is still v${now}. tanacode shows the user the reason on the Mac (homebrew-update.log in its data folder). Tell the user in one line.`;
  return `tanacode has restarted (v${now}). Tell the user in one line.`;
}

// get_app_update の結果
export function appUpdateJson(info: AppUpdateInfo): Record<string, unknown> {
  const available = !!info.latest && compareVersions(info.latest, info.current) > 0;
  const ready = info.download?.status === 'ready' ? info.download.version : null;
  return {
    current_version: info.current,
    latest_version: info.latest,
    update_available: available,
    checking_enabled: info.checkEnabled,
    installed_with: info.install === 'dev' ? 'development build' : info.install === 'homebrew' ? 'Homebrew' : 'other (not Homebrew)',
    // ダウンロードの様子は、Homebrew で入れていて新しいバージョンがあるときだけ
    ...(info.download ? { download: info.download.status } : {}),
    ...(ready ? { ready_to_install: ready } : {}),
    note: ready
      ? `restart_app installs v${ready} and restarts tanacode.`
      : available
        ? noUpdateReason(info)
        : 'restart_app restarts tanacode without updating.',
  };
}
