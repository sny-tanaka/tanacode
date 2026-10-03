import { useEffect, useState } from 'react';
import type { AppUpdate } from '@shared/app-update';
import { CheckCircleIcon, DownloadIcon } from '../icons';

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
const STEPS = [
  '更新の手順',
  '・ソースから入れた場合: git pull・npm install・npm run install-app を実行して、tanacode を起動し直します',
  '・ビルド済みのアプリの場合: 「ファイル → Claude Code も止めて終了」で終了してから、新しいバージョンを入れます',
].join('\n');

// 新しいバージョンの印を見た（マウスを乗せた・押した）バージョン。見たバージョンでは、もう印を動かさない（このマシンだけの表示の状態なので localStorage に置く）
export const SEEN_KEY = 'tanacode.app-update.seen';

function seenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

// タイトルバーのバージョンの横の印。最新なら控えめなチェック、新しいバージョンがあれば青いダウンロードの印。
// 文字は出さず、マウスを乗せると「最新バージョンです」「v0.1.5 があります」と、更新の手順が出る。
// 新しいバージョンの印を押すと、そのバージョンの Releases のページを開く
export function AppUpdateMark({ update }: { update: AppUpdate | null }) {
  if (!update) return null;
  if (!update.available)
    return (
      <span className="app-update latest" data-tip="最新バージョンです">
        <CheckCircleIcon size={14} />
      </span>
    );
  return <UpdateAvailable key={update.latest} update={update} />;
}

// 新しいバージョンの印。目の端でも気づけるよう、矢印を受け皿へ落とす動きと波紋を出す。
// 画面を見ていないときに動いても気づけないので、マウスを乗せるか押すまで繰り返す。乗せるか押したら、そのバージョンではもう動かさない
function UpdateAvailable({ update }: { update: AppUpdate }) {
  const [seen, setSeen] = useState(() => seenVersion() === update.latest);

  const markSeen = () => {
    if (seen) return;
    setSeen(true);
    try {
      localStorage.setItem(SEEN_KEY, update.latest);
    } catch {
      // 保存できなくても、このあいだは止める
    }
  };

  return (
    <button
      className={`app-update available${seen ? '' : ' calling'}`}
      aria-label={`v${update.latest} があります`}
      data-tip={`v${update.latest} があります\n押すと、GitHub の Releases のページを開きます\n\n${STEPS}`}
      onMouseEnter={markSeen}
      onFocus={markSeen}
      onClick={() => (markSeen(), window.open(update.url))}
    >
      <DownloadIcon size={14} />
    </button>
  );
}
