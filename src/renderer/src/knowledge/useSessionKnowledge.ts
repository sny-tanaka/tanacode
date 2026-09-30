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

// コンテキストの上限。1M コンテキストのモデルか、すでに 20 万を超えていれば 100 万とみなす
export function contextWindow(model: string | null, screenModel: string | null, tokens: number | null): number {
  const oneMillion = /\[1m\]/i.test(model ?? '') || /1M/.test(screenModel ?? '') || (tokens ?? 0) > 200_000;
  return oneMillion ? 1_000_000 : 200_000;
}
