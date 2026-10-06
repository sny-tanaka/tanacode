import { useCallback, useEffect, useState } from 'react';
import { unreadCount, type Checklist, type ChecklistUnread } from '@shared/checklist';
import { errorMessage } from '../errorMessage';
import { useSessionValues } from '../sessionValues';

const NO_LISTS: Checklist[] = [];

// セッションごとのチェックリストと、セッションごとの Claude からの未読の返信の数（セッション一覧とアクティビティバーの印）。
// リストを描き直すのは選択中のセッションが変わったときだけ
export function useChecklists(selectedId: string | null): {
  listsOf: (sessionId: string | null) => Checklist[];
  load: (sessionId: string) => void;
  unread: ChecklistUnread;
} {
  const { valueOf, update } = useSessionValues<Checklist[], Checklist[]>(selectedId, NO_LISTS);
  const [unread, setUnread] = useState<ChecklistUnread>({});
  const set = useCallback(
    (sessionId: string, lists: Checklist[]) => {
      update(sessionId, () => lists);
      const count = unreadCount(lists);
      setUnread((prev) => {
        if ((prev[sessionId] ?? 0) === count) return prev;
        const { [sessionId]: _, ...rest } = prev;
        return count > 0 ? { ...rest, [sessionId]: count } : rest;
      });
    },
    [update],
  );
  useEffect(() => {
    void window.tanacode.checklist.unread().then(setUnread, () => {});
    return window.tanacode.checklist.onChanged(({ sessionId, lists }) => set(sessionId, lists));
  }, [set]);
  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.checklist.get(sessionId).then((lists) => set(sessionId, lists), () => {});
    },
    [set],
  );
  return { listsOf: valueOf, load, unread };
}

// 画面からの書き換え。できなかったら理由を出す
export function applyChecklist(sessionId: string, op: Parameters<typeof window.tanacode.checklist.apply>[1]): Promise<boolean> {
  return window.tanacode.checklist.apply(sessionId, op).then(
    () => true,
    (error: unknown) => {
      window.alert(`チェックリストを変えられませんでした: ${errorMessage(error)}`);
      return false;
    },
  );
}
