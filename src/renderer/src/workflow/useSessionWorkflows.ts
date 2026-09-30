import { useCallback, useEffect } from 'react';
import type { WorkflowRun } from '@shared/workflow';
import { useSessionValues } from '../sessionValues';
import { stableRuns } from '../tasks/stableRuns';

// セッションごとのワークフローの実行状況。キーは起動した Workflow ツールの tool_use ID
export type WorkflowRuns = ReadonlyMap<string, WorkflowRun>;
const NO_RUNS: WorkflowRuns = new Map();

// 描き直すのは選択中のセッションが変わったときだけ
export function useSessionWorkflows(selectedId: string | null): {
  workflowsOf: (sessionId: string | null) => WorkflowRuns;
  load: (sessionId: string) => void;
} {
  const { valueOf, update } = useSessionValues<WorkflowRuns, WorkflowRuns>(selectedId, NO_RUNS);
  const set = useCallback((sessionId: string, list: WorkflowRun[]) => update(sessionId, (prev) => stableRuns(prev, list)), [update]);
  useEffect(() => window.tanacode.workflows.onChanged(({ sessionId, runs: list }) => set(sessionId, list)), [set]);
  const load = useCallback(
    (sessionId: string) => {
      void window.tanacode.workflows.get(sessionId).then((list) => set(sessionId, list));
    },
    [set],
  );
  return { workflowsOf: valueOf, load };
}
