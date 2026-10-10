import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import { errorMessage } from '../errorMessage';
import type { TaskEntry } from './taskList';

// 止める操作が済んでから、タスクの状態が変わる知らせ（会話ログ）を待つ時間。これだけ待っても変わらなければ、押せる状態に戻す
const SETTLE_MS = 8000;

// 動いているバックグラウンドのタスクを止める（本家の /tasks の画面を操作するので、数秒かかる）。
// stopping: 止めている途中のタスク（key）。終わって状態が変わるまで、押せなくする。
// 止められなかったときは、理由を出す
export function useStopTask(sessionId: string | null) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const release = useCallback((key: string) => {
    setStopping((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const stop = useCallback(
    (task: TaskEntry) => {
      if (!sessionId) return;
      setStopping((prev) => new Set(prev).add(task.key));
      window.tanacode.tasks.stop(sessionId, task.ref).then(
        (error) => {
          if (error) {
            release(task.key);
            window.alert(error);
            return;
          }
          const timer = setTimeout(() => (timers.current.delete(timer), release(task.key)), SETTLE_MS);
          timers.current.add(timer);
        },
        (error: unknown) => {
          release(task.key);
          window.alert(t('tasks.stop.failed', { error: errorMessage(error) }));
        },
      );
    },
    [sessionId, release],
  );
  return { stopping, stop };
}
