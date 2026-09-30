import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';

// フロー図の 1 列。同時に動いたエージェントのまとまり（列どうしは左から右へ順に動いた）
export type FlowStage = {
  key: string;
  // 子ワークフロー（workflow() で呼んだもの）の名前。そのエージェントは「▸ 名前」のフェーズに入っている
  child: string | null;
  agents: WorkflowAgent[];
};

// フェーズ。stages が空なら、そのフェーズでは（まだ）エージェントが動いていない
export type FlowPhase = {
  key: string;
  title: string | null;
  detail: string | null;
  stages: FlowStage[];
};

// 並んで動いたフェーズのまとまり（縦に積んで出す）。まとまりどうしは左から右へ順に動いた
export type FlowGroup = { key: string; phases: FlowPhase[] };

const CHILD = /^▸\s*/;

// フェーズを、並んで動いたものどうしでまとめる。前のまとまりが終わる前に始まったフェーズは、そのまとまりに入れる
// （例: 本番実装と並行してテスト設計を動かす）
export function flowGroups(run: WorkflowRun): FlowGroup[] {
  const groups: FlowGroup[] = [];
  for (const phase of flowPhases(run)) {
    const current = groups[groups.length - 1];
    const start = phaseStart(phase);
    if (current && start !== null && start < groupEnd(current)) current.phases.push(phase);
    else groups.push({ key: phase.key, phases: [phase] });
  }
  return groups;
}

// まとまりが終わった番号。動いているエージェントがあればまだ終わっていない。
// 終わった番号が分からないエージェント（前の実行の結果を使ったもの・止まったもの）は数えない
function groupEnd(group: FlowGroup): number {
  const agents = group.phases.flatMap((p) => p.stages.flatMap((s) => s.agents));
  if (agents.some((a) => a.state === 'running')) return Infinity;
  const ends = agents.map((a) => a.endSeq).filter((e): e is number => e !== null);
  return ends.length > 0 ? Math.max(...ends) : -Infinity;
}

// ワークフローの実行を、フェーズごとの列に並べる。
// フェーズはスクリプトに書かれた順。子ワークフローのエージェントは、動いた時刻から、呼び出したフェーズの中に入れる。
// 同じフェーズの中でも、前のエージェントが全部終わってから始まったもの（再試行など）は次の列にする
export function flowPhases(run: WorkflowRun): FlowPhase[] {
  const declared = run.phases.filter((p) => !CHILD.test(p.title));
  const byPhase = new Map<string, WorkflowAgent[]>();
  for (const agent of run.agents) {
    const key = agent.phase ?? '';
    byPhase.set(key, [...(byPhase.get(key) ?? []), agent]);
  }

  const phases: FlowPhase[] = declared.map((p) => ({
    key: p.title,
    title: p.title,
    detail: p.detail,
    stages: stagesOf(byPhase.get(p.title) ?? [], p.title, null),
  }));
  const others = [...byPhase.entries()]
    .filter(([key]) => !declared.some((p) => p.title === key))
    .sort(([, a], [, b]) => (firstStart(a) ?? Infinity) - (firstStart(b) ?? Infinity));
  for (const [key, agents] of others) {
    const start = firstStart(agents);
    const child = CHILD.test(key) ? key.replace(CHILD, '') : null;
    // 子ワークフローとフェーズの無いエージェントは、動いたときのフェーズに入れる
    const host = child !== null || key === '' ? hostOf(phases, start) : null;
    if (host) {
      host.stages = [...host.stages, ...stagesOf(agents, key, child)].sort(
        (a, b) => (firstStart(a.agents) ?? Infinity) - (firstStart(b.agents) ?? Infinity),
      );
      continue;
    }
    // スクリプトから読めなかったフェーズは、動いた順の位置に差し込む
    const phase: FlowPhase = {
      key: key || '（フェーズなし）',
      title: key || null,
      detail: null,
      stages: stagesOf(agents, key, child),
    };
    const at = phases.findIndex((p) => (phaseStart(p) ?? -Infinity) > (start ?? Infinity));
    phases.splice(at < 0 ? phases.length : at, 0, phase);
  }
  return phases;
}

// 動いた時刻が start のエージェントを入れるフェーズ。start より前に始まったフェーズのうち最後のものの、次の空のフェーズ
// （phase() を呼んでから workflow() で子ワークフローを動かすことが多い）。無ければそのフェーズ、どれも始まっていなければ先頭
function hostOf(phases: FlowPhase[], start: number | null): FlowPhase | null {
  let last = -1;
  for (const [i, phase] of phases.entries()) {
    const s = phaseStart(phase);
    if (s === null) continue;
    if (start !== null && s > start) break;
    last = i;
  }
  const next = phases[last + 1];
  if (next && next.stages.length === 0) return next;
  return phases[Math.max(last, 0)] ?? null;
}

function stagesOf(agents: WorkflowAgent[], key: string, child: string | null): FlowStage[] {
  const sorted = [...agents].sort((a, b) => (a.startSeq ?? Infinity) - (b.startSeq ?? Infinity));
  const stages: FlowStage[] = [];
  for (const agent of sorted) {
    const current = stages[stages.length - 1];
    if (current && !startedAfter(agent, current.agents)) current.agents.push(agent);
    else stages.push({ key: `${key}:${agent.agentId}`, child, agents: [agent] });
  }
  return stages;
}

// agent が、others がすべて終わってから始まったか
function startedAfter(agent: WorkflowAgent, others: WorkflowAgent[]): boolean {
  if (agent.startSeq === null) return false;
  return others.every((o) => o.endSeq !== null && o.endSeq < agent.startSeq!);
}

function firstStart(agents: WorkflowAgent[]): number | null {
  const starts = agents.map((a) => a.startSeq).filter((s): s is number => s !== null);
  return starts.length > 0 ? Math.min(...starts) : null;
}

function phaseStart(phase: FlowPhase): number | null {
  return firstStart(phase.stages.flatMap((s) => s.agents));
}
