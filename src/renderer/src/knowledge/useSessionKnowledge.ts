import { useCallback, useEffect } from 'react';
import { useSessionValues } from '../sessionValues';
import type { SessionKnowledge } from '@shared/knowledge';

const NO_KNOWLEDGE: SessionKnowledge = { files: {}, contextTokens: null };

// セッションごとの、Claude が読んだ・書いたファイルとコンテキストの使用量。描き直すのは選択中のセッションが変わったときだけ
export function useSessionKnowledge(selectedId: string | null): {
  knowledgeOf: (sessionId: string | null) => SessionKnowledge;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<SessionKnowledge, SessionKnowledge>(selectedId, NO_KNOWLEDGE);
  useEffect(
    () =>
      window.tanacode.knowledge.onChanged(({ sessionId, knowledge }) =>
        update(sessionId, (old) => {
          // 応答のたびにトークン数だけが変わる。ファイルの一覧が同じなら前のものを使い回す（エクスプローラーを描き直さない）
          const files = old && JSON.stringify(old.files) === JSON.stringify(knowledge.files) ? old.files : knowledge.files;
          // トークン数も同じなら、前のものをそのまま使う（App を描き直さない）
          if (old && files === old.files && old.contextTokens === knowledge.contextTokens) return old;
          return { ...knowledge, files };
        }),
      ),
    [update],
  );
  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.knowledge.get(sessionId).then((k) => update(sessionId, (prev) => prev ?? k));
    },
    [update],
  );
  return { knowledgeOf: valueOf, load };
}

// コンテキストの使用量と上限の出し方は、main（自動の最適化圧縮）と同じもの
export { contextUsage, contextWindow } from '@shared/context';
