import { useEffect, useState } from 'react';
import { REPO_URL, type AppUpdate } from '@shared/app-update';

// tanacode の新しい版（GitHub の Releases）。まだ分からない・確かめる設定がオフなら null
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

// 新しい版を入れる手順（README の「更新」と同じ）
const STEPS = [
  '更新の手順',
  '・ソースから入れた場合: git pull・npm install・npm run install-app を実行して、tanacode を起動し直します',
  '・ビルド済みのアプリの場合: 「ファイル → Claude Code も止めて終了」で終了してから、新しい版を入れます',
].join('\n');

// タイトルバーのバージョンの横の印。最新なら控えめなチェック、新しい版があれば青いダウンロードの印。
// 文字は出さず、マウスを乗せると「最新版です」「v0.1.5 があります」と、更新の手順が出る。
// 押すと、最新ならリポジトリのページ、新しい版があればその版の Releases のページを GitHub で開く
export function AppUpdateMark({ update }: { update: AppUpdate | null }) {
  if (!update) return null;
  if (!update.available)
    return (
      <button
        className="app-update latest"
        aria-label="最新版です"
        data-tip={'最新版です\n押すと、GitHub の tanacode のページを開きます'}
        onClick={() => window.open(REPO_URL)}
      >
        <CheckIcon />
      </button>
    );
  return (
    <button
      className="app-update available"
      aria-label={`v${update.latest} があります`}
      data-tip={`v${update.latest} があります\n押すと、GitHub の Releases のページを開きます\n\n${STEPS}`}
      onClick={() => window.open(update.url)}
    >
      <DownloadIcon />
    </button>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.2 8.2 7.1 10.1 10.9 6.1" />
    </svg>
  );
}

// 受け皿に下向きの矢印が入る形（ダウンロード）。ステータスバーの Claude Code の版の ↑↓（動作確認済の版との比較）と見分けられるよう、丸で囲まない
function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7" />
      <path d="M2.8 10.8v1.4c0 .7.6 1.3 1.3 1.3h7.8c.7 0 1.3-.6 1.3-1.3v-1.4" />
    </svg>
  );
}
