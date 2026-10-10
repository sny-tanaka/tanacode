import { useState } from 'react';
import { t } from '@shared/i18n';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import { StatusDot, type DotState } from '../layout/StatusDot';
import { ChevronRightIcon, IconButton } from '../icons';

const STATUSES = ['running', 'completed', 'failed', 'stopped', 'killed'] as const;

// 実行の状態の名前（知らない状態は、そのまま出す）
export function workflowStatusLabel(status: string): string {
  const known = STATUSES.find((s) => s === status);
  return known ? t(`workflow.status.${known}`) : status;
}

// onOpen: 中身（エージェントごとの会話）を大きく開く
type Props = { run: WorkflowRun | undefined; fallbackName: string; onOpen: (() => void) | null };

// Workflow ツールのカード。フェーズごとにエージェントの進み具合を出す
export function WorkflowCard({ run, fallbackName, onOpen }: Props) {
  if (!run) {
    return (
      <div className="workflow-card">
        <div className="workflow-head">
          <span className="tool-dot running" />
          <span className="tool-name">{t('workflow.card.name')}</span>
          <span className="tool-target">{fallbackName}</span>
        </div>
        <div className="tool-card-status">
          <span className="flow-text">{t('workflow.card.starting')}</span>
        </div>
      </div>
    );
  }

  // 実行中はエージェントのフェーズが分からないことが多い（完了時の記録で分かる）。
  // そのときはフェーズを流れとして上に並べ、エージェントは一列に出す
  const phased = run.agents.every((a) => a.phase !== null);
  const groups = phased ? groupByPhase(run) : [];
  const done = run.agents.filter((a) => a.state === 'done').length;
  return (
    <div className="workflow-card">
      <div className="workflow-head">
        <StatusDot state={dotOf(run.status)} />
        <span className="tool-name">{t('workflow.card.name')}</span>
        <span className="tool-target" title={run.name}>
          {run.name}
        </span>
        {run.resumed && (
          <span className="workflow-badge" title={t('workflow.card.resumedTip')}>
            {t('workflow.card.resumed')}
          </span>
        )}
        <span className={`workflow-status ${run.status}`}>{workflowStatusLabel(run.status)}</span>
        {onOpen && (
          <IconButton icon={ChevronRightIcon} size="sm" label={t('common.open')} onClick={onOpen} />
        )}
      </div>
      {run.summary && <div className="workflow-summary">{run.summary}</div>}
      {run.resumedLater && <div className="workflow-note">{t('workflow.card.resumedLater')}</div>}
      {!phased && (
        <>
          {run.phases.length > 0 && (
            <div className="workflow-steps">
              {run.phases.map((p, i) => (
                <span key={p.title} className="workflow-step" title={p.detail ?? undefined}>
                  {i > 0 && <span className="workflow-step-arrow">→</span>}
                  {p.title}
                </span>
              ))}
            </div>
          )}
          <div className="workflow-phase">
            {run.agents.length === 0 && <div className="workflow-empty">{t('workflow.card.waitingAgents')}</div>}
            {run.agents.map((agent) => (
              <AgentRow key={agent.agentId} agent={agent} />
            ))}
          </div>
        </>
      )}
      {groups.map((group) => (
        <div key={group.title} className="workflow-phase">
          <div className="workflow-phase-title">
            {group.title}
            {group.detail && <span className="workflow-phase-detail">{group.detail}</span>}
          </div>
          {group.agents.length === 0 && <div className="workflow-empty">{run.status === 'running' ? t('workflow.phase.waiting') : t('workflow.card.noAgents')}</div>}
          {group.agents.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} />
          ))}
        </div>
      ))}
      <div className="workflow-foot">
        <span>{t('workflow.stats.agents', { done, total: run.agents.length })}</span>
        {run.totalToolCalls !== null && <span>{t('workflow.stats.toolCalls', { count: run.totalToolCalls })}</span>}
        {run.totalTokens !== null && <span>{t('workflow.stats.tokens', { count: formatTokens(run.totalTokens) })}</span>}
        {run.durationMs !== null && <span>{formatDuration(run.durationMs)}</span>}
      </div>
    </div>
  );
}

function AgentRow({ agent }: { agent: WorkflowAgent }) {
  const [open, setOpen] = useState(false);
  const name = agent.label ?? agent.promptPreview?.split('\n')[0] ?? agent.agentId;
  const detail = open ? (agent.resultPreview ?? agent.promptPreview) : null;
  return (
    <div className="workflow-agent">
      <button className="workflow-agent-row" onClick={() => setOpen((v) => !v)}>
        <StatusDot state={agent.state === 'running' ? 'running' : agent.state === 'done' ? 'done' : 'error'} />
        <span className="workflow-agent-name" title={name}>
          {name}
        </span>
        <span className="workflow-agent-meta">
          {agent.model && <span>{shortModel(agent.model)}</span>}
          <span>{agentTools(agent)}</span>
          {agent.durationMs !== null && <span>{formatDuration(agent.durationMs)}</span>}
        </span>
      </button>
      {detail && (
        <pre className="workflow-agent-detail">
          <span className="workflow-agent-detail-label">{agent.resultPreview ? t('workflow.agent.result') : t('workflow.agent.prompt')}</span>
          {'\n'}
          {detail}
        </pre>
      )}
    </div>
  );
}

// エージェントのツールの呼び出し数（動いている間は、最後に使ったツールも添える）
export function agentTools(agent: WorkflowAgent): string {
  return agent.state === 'running' && agent.lastTool
    ? t('workflow.agent.toolsWithLast', { count: agent.toolCalls, tool: agent.lastTool })
    : t('workflow.agent.tools', { count: agent.toolCalls });
}

export type Group = { title: string; detail: string | null; agents: WorkflowAgent[] };

// 実行中はエージェントのフェーズが分からないことがある。そのときは「エージェント」にまとめる
export function groupByPhase(run: WorkflowRun): Group[] {
  const groups: Group[] = run.phases.map((p) => ({ title: p.title, detail: p.detail, agents: [] }));
  const unphased: WorkflowAgent[] = [];
  for (const agent of run.agents) {
    const group = groups.find((g) => g.title === agent.phase);
    if (group) group.agents.push(agent);
    else unphased.push(agent);
  }
  if (unphased.length > 0 || groups.length === 0) groups.push({ title: t('workflow.phase.unphased'), detail: null, agents: unphased });
  return groups;
}

function dotOf(status: string): DotState {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'done';
  return 'error';
}

// claude-haiku-4-5-20251001 → haiku-4-5、claude-opus-5[1m] → opus-5[1m]
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('workflow.duration.seconds', { count: s });
  const m = Math.floor(s / 60);
  return m < 60 ? t('workflow.duration.minutes', { minutes: m, seconds: s % 60 }) : t('workflow.duration.hours', { hours: Math.floor(m / 60), minutes: m % 60 });
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}
