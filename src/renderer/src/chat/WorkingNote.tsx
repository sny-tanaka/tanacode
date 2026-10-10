import { useEffect, useRef, useState } from 'react';
import { language, t } from '@shared/i18n';
import type { Activity } from '@shared/screen';
import { CheckMark } from '../layout/CheckMark';

// 進み具合の名前（working は出さない）
function phaseLabel(phase: Activity['phase']): string | null {
  return phase === 'working' ? null : t(`chat.working.${phase}`);
}

// 画面の表記（5s・1m 5s・1h 2m）を、今の言語の表記（日本語なら 5秒・1分5秒・1時間2分。日本語だけ間を詰める）にする
function localElapsed(elapsed: string): string {
  return elapsed
    .replace(/(\d+)h/, (_, n: string) => t('chat.duration.hours', { count: n }))
    .replace(/(\d+)m/, (_, n: string) => t('chat.duration.minutes', { count: n }))
    .replace(/(\d+)s/, (_, n: string) => t('chat.duration.seconds', { count: n }))
    .replace(/\s+/g, language() === 'ja' ? '' : ' ');
}

// 進み具合は 1 秒ごとに変わるので、ここだけで受け取る（チャット全体を描き直さない）
function useActivity(sessionId: string | undefined): Activity | null {
  const [activity, setActivity] = useState<Activity | null>(null);
  useEffect(() => {
    setActivity(null);
    if (!sessionId) return;
    let alive = true;
    void window.tanacode.screen.activity(sessionId).then((a) => alive && setActivity(a));
    const off = window.tanacode.screen.onActivity((payload) => {
      if (payload.sessionId === sessionId) setActivity(payload.activity);
    });
    return () => {
      alive = false;
      off();
    };
  }, [sessionId]);
  return activity;
}

function activityText(activity: Activity | null): string[] {
  if (!activity) return [];
  return [
    phaseLabel(activity.phase),
    activity.phase === 'writing' && activity.tokens ? t('chat.working.tokens', { count: activity.tokens }) : null,
    activity.elapsed ? localElapsed(activity.elapsed) : null,
  ].filter((text): text is string => !!text);
}

// チャットの末尾に出す「作業中」。セッション一覧の作業中と同じ色と回る印にして、目に留まるようにする。
// 横に Claude Code の画面のタイマーの行から読んだ進み具合（考えている・応答を書いている・経過時間）を出す。
// sessionId が無いとき（サブエージェントの表示など）は、進み具合を出さない。
// label: 作業中の ToDo の進行形の名前（例: 原因を調査中）。あれば「作業中」の代わりに出す
export function WorkingNote({ sessionId, activity: given, label }: { sessionId?: string; activity?: Activity | null; label?: string }) {
  const received = useActivity(given === undefined ? sessionId : undefined);
  const details = activityText(given === undefined ? received : given);
  return (
    <div className="chat-note working">
      <span className="session-indicator running" />
      <span className="working-label">{label ? `${label.replace(/[…。.]+$/, '')}…` : t('chat.working.inProgress')}</span>
      {details.length > 0 && <span className="working-detail">{details.join(' · ')}</span>}
    </div>
  );
}

// ターンが終わったとき、「作業中…」をいきなり消さず、チェックを描いて「完了」と出してから消す（CSS の working-done で消える）
export function DoneNote() {
  return (
    <div className="chat-note working-done">
      <CheckMark animate slot={9} />
      {t('chat.working.done')}
    </div>
  );
}

// 作業中から待機中に変わったら、しばらく true を返す（完了の表示を出す間）
export function useJustFinished(running: boolean, idle: boolean, resetKey: string): boolean {
  const [done, setDone] = useState(false);
  const wasRunning = useRef(running);
  useEffect(() => {
    const finished = wasRunning.current && !running && idle;
    wasRunning.current = running;
    if (running) setDone(false);
    if (!finished) return;
    setDone(true);
    const timer = setTimeout(() => setDone(false), DONE_MS);
    return () => clearTimeout(timer);
  }, [running, idle]);
  // セッションを切り替えたら出さない
  useEffect(() => {
    setDone(false);
    wasRunning.current = false;
  }, [resetKey]);
  return done;
}

// 完了の表示を出しておく時間（CSS の working-done と合わせる）
const DONE_MS = 1800;
