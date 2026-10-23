import { useCallback, useEffect } from 'react';
import type { PendingQuestion } from '@shared/questions';
import { useSessionValues } from '../sessionValues';

// セッションごとの、Claude Code が答えを待っている AskUserQuestion（質問のカードに出す）。
// 描き直すのは選択中のセッションが変わったときだけ
export function useSessionQuestions(selectedId: string | null, listed: ReadonlySet<string> | null): {
  questionOf: (sessionId: string | null) => PendingQuestion | null;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<PendingQuestion | null, null>(selectedId, listed, null);

  useEffect(() => window.tanacode.question.onChanged(({ sessionId, question }) => update(sessionId, () => question)), [update]);

  const load = useCallback(
    (sessionId: string) => {
      // 読み込みの返事より先に届いた知らせ（もっと新しい質問・答えたあとの null）を、古い返事で上書きしない
      void window.tanacode.question.get(sessionId).then((question) => update(sessionId, (prev) => (prev === undefined ? question : prev)));
    },
    [update],
  );

  return { questionOf: valueOf, load };
}
