import { useCallback, useEffect } from 'react';
import { useSessionValues } from '../sessionValues';
import type { SessionKnowledge } from '@shared/knowledge';
import type { StatusLineInfo } from '@shared/statusline';

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

// コンテキストの使用量と上限。statusLine があればその値（上限も正確）、無ければ直近の応答の使用量から。
// 圧縮の直後は、statusLine の使用量が次の応答まで 0 になるので、会話ログの圧縮後の量を使う（無ければ 0 のまま出す）
export function contextUsage(
  model: string | null,
  screenModel: string | null,
  statusLine: StatusLineInfo | null,
  contextTokens: number | null,
): { tokens: number | null; limit: number } {
  const context = statusLine?.context;
  if (context) return { tokens: context.tokens > 0 ? context.tokens : (contextTokens ?? 0), limit: context.size };
  return { tokens: contextTokens, limit: contextWindow(model, screenModel, contextTokens) };
}
