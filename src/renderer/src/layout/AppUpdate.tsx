import { useEffect, useState } from 'react';
import type { AppUpdate } from '@shared/app-update';
import { t } from '@shared/i18n';
import { CheckCircleIcon, DownloadIcon } from '../icons';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';

// tanacode の新しいバージョン（GitHub の Releases）。まだ分からない・確かめる設定がオフなら null
export function useAppUpdate(): AppUpdate | null {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  useEffect(() => {
    let active = true;
    void window.tanacode.appUpdate.get().then((u) => active && setUpdate(u ?? null));
    const off = window.tanacode.appUpdate.onChanged(setUpdate);
    return () => {
      active = false;
      off();
    };
  }, []);
  return update;
}

// 新しいバージョンを入れる手順（README の「更新」と同じ）
function steps(): string {
  return [t('app.update.stepsTitle'), t('app.update.stepHomebrew'), t('app.update.stepBuilt'), t('app.update.stepSource')].join('\n');
}

// 新しいバージョンの印を見た（マウスを乗せた・押した）バージョン。見たバージョンでは、もう印を動かさない。どのプロファイルの画面でも同じにする（sharedPrefs）
export const SEEN_KEY = 'tanacode.app-update.seen';

const seenVersion = () => readSharedPref(SEEN_KEY);

// タイトルバーのバージョンの横の印。最新なら控えめなチェック、新しいバージョンがあれば青いダウンロードの印。
// 文字は出さず、マウスを乗せると「最新バージョンです」「v0.1.5 があります」と、更新の手順が出る。
// 新しいバージョンの印を押すと、そのバージョンの Releases のページを開く。
// Homebrew で入れていて、新しいバージョンをダウンロードし終えたら、印の代わりに「再起動して更新」のボタンを出す
export function AppUpdateMark({ update }: { update: AppUpdate | null }) {
  if (!update) return null;
  if (!update.available)
    return (
      <span className="app-update latest" data-tip={t('app.update.latest')}>
        <CheckCircleIcon size={14} />
      </span>
    );
  if (update.homebrew?.status === 'ready') return <UpdateReady version={update.homebrew.version} />;
  return <UpdateAvailable key={update.latest} update={update} />;
}

// 新しいバージョンの印。目の端でも気づけるよう、矢印を受け皿へ落とす動きと波紋を出す。
// 画面を見ていないときに動いても気づけないので、マウスを乗せるか押すまで繰り返す。乗せるか押したら、そのバージョンではもう動かさない
function UpdateAvailable({ update }: { update: AppUpdate }) {
  const [seen, setSeen] = useState(() => seenVersion() === update.latest);

  const markSeen = () => {
    if (seen) return;
    setSeen(true);
    writeSharedPref(SEEN_KEY, update.latest);
  };
  useSharedPrefChange(SEEN_KEY, () => setSeen(seenVersion() === update.latest));

  return (
    <button
      className={`app-update available${seen ? '' : ' calling'}`}
      aria-label={t('app.update.available', { version: update.latest })}
      data-tip={`${t('app.update.available', { version: update.latest })}\n${homebrewNote(update)}${t('app.update.openReleases')}\n\n${steps()}`}
      onMouseEnter={markSeen}
      onFocus={markSeen}
      onClick={() => (markSeen(), window.open(update.url))}
    >
      <DownloadIcon size={14} />
    </button>
  );
}

// Homebrew で用意している途中・用意できなかったときに、ツールチップに足す一文
function homebrewNote(update: AppUpdate): string {
  if (update.homebrew?.status === 'downloading') return `${t('app.update.homebrewDownloading')}\n`;
  if (update.homebrew?.status === 'failed') return `${t('app.update.homebrewFailed')}\n`;
  return '';
}

// ダウンロード済みの新しいバージョン（Homebrew）。押すと、tanacode を終了し、入れ替えてから起動し直す。
// Claude Code が動いていれば、止めるかを main が聞く
function UpdateReady({ version }: { version: string }) {
  return (
    <button
      className="app-update available ready"
      aria-label={t('app.update.readyLabel', { version })}
      data-tip={[t('app.update.downloaded', { version }), t('app.update.readyRestart'), t('app.update.readyOnQuit')].join('\n')}
      onClick={() => void window.tanacode.appUpdate.install()}
    >
      <DownloadIcon size={14} />
      <span>{t('app.update.restart')}</span>
    </button>
  );
}
