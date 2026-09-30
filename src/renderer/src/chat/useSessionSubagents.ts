import { useCallback, useEffect } from 'react';
import type { SubagentRun } from '@shared/subagent';
import { useSessionValues } from '../sessionValues';
import { stableRuns } from '../tasks/stableRuns';

// セッションごとのサブエージェントの進み具合。キーは起動した Agent ツールの tool_use ID
export type SubagentRuns = ReadonlyMap<string, SubagentRun>;
const NO_RUNS: SubagentRuns = new Map();

// 描き直すのは選択中のセッションが変わったときだけ
export function useSessionSubagents(selectedId: string | null): {
  subagentsOf: (sessionId: string | null) => SubagentRuns;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<SubagentRuns, SubagentRuns>(selectedId, NO_RUNS);
  const set = useCallback((sessionId: string, list: SubagentRun[]) => update(sessionId, (prev) => stableRuns(prev, list)), [update]);
  useEffect(() => window.tanacode.subagents.onChanged(({ sessionId, runs: list }) => set(sessionId, list)), [set]);
  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.subagents.get(sessionId).then((list) => set(sessionId, list));
    },
    [set],
  );
  return { subagentsOf: valueOf, load };
}
