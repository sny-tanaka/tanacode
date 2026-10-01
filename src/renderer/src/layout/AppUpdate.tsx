import { useEffect, useRef, useState } from 'react';
import type { AppUpdate } from '@shared/app-update';

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
// まだ見ていないあいだ、印を動かし直す間隔
const REPLAY_MS = 60 * 60_000;

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
        <CheckIcon />
      </span>
    );
  return <UpdateAvailable key={update.latest} update={update} />;
}

// 新しいバージョンの印。目の端でも気づけるよう、見つけたときに矢印を受け皿へ落とす動きと波紋を出す。
// 見るまでは、1 時間ごとに（アプリが前に出ているとき・前に戻ってきたときに）動かし直す。マウスを乗せるか押したら、そのバージョンではもう動かさない
function UpdateAvailable({ update }: { update: AppUpdate }) {
  const [seen, setSeen] = useState(() => seenVersion() === update.latest);
  // 動きを始め直すための番号（button の key にして、作り直す）
  const [round, setRound] = useState(0);
  const playedAt = useRef(Date.now());

  useEffect(() => {
    if (seen) return;
    const replay = () => {
      if (!document.hasFocus() || Date.now() - playedAt.current < REPLAY_MS) return;
      playedAt.current = Date.now();
      setRound((r) => r + 1);
    };
    const timer = setInterval(replay, 60_000);
    window.addEventListener('focus', replay);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', replay);
    };
  }, [seen]);

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
      key={round}
      className={`app-update available${seen ? '' : ' calling'}`}
      aria-label={`v${update.latest} があります`}
      data-tip={`v${update.latest} があります\n押すと、GitHub の Releases のページを開きます\n\n${STEPS}`}
      onMouseEnter={markSeen}
      onFocus={markSeen}
      onClick={() => (markSeen(), window.open(update.url))}
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

// 受け皿に下向きの矢印が入る形（ダウンロード）。ステータスバーの Claude Code のバージョンの ↑↓（動作確認済のバージョンとの比較）と見分けられるよう、丸で囲まない
function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path className="app-update-arrow" d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7" />
      <path d="M2.8 10.8v1.4c0 .7.6 1.3 1.3 1.3h7.8c.7 0 1.3-.6 1.3-1.3v-1.4" />
    </svg>
  );
}
