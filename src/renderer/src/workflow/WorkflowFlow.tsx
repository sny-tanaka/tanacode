import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import { flowGroups } from './flow';
import { agentTools, formatDuration, formatTokens, shortModel, workflowStatusLabel } from './WorkflowCard';
import { StatusDot } from '../layout/StatusDot';

type Props = { run: WorkflowRun; onOpenAgent: (agentId: string) => void };

// ワークフローのまとめ。フェーズを左から右へ並べ、同時に動いたエージェントを縦に積んで線で繋ぐ（GitHub Actions のような図）
// 同じ run なら描き直さない（ほかのパネルの変化で、レイアウトの計算をやり直さない）
export const WorkflowFlow = memo(function WorkflowFlow({ run, onOpenAgent }: Props) {
  const edgeGradient = useId();
  const groups = flowGroups(run);
  const done = run.agents.filter((a) => a.state === 'done').length;
  const waiting = run.status === 'running' ? t('workflow.phase.waiting') : t('workflow.flow.notRunning');

  // 線で繋ぐ組。フェーズの中は列のエージェントどうし、フェーズからフェーズへは箱どうし（エージェントが多いと線が多すぎるため）
  const links: Link[] = [];
  groups.forEach((group, g) => {
    for (const phase of group.phases) {
      const keys = phase.stages.map((s) => s.key);
      keys.slice(1).forEach((key, i) => links.push({ kind: 'stage', from: [keys[i]], to: [key] }));
    }
    const next = groups[g + 1];
    if (next) links.push({ kind: 'phase', from: group.phases.map((p) => p.key), to: next.phases.map((p) => p.key) });
  });

  const boardRef = useRef<HTMLDivElement>(null);
  const edges = useEdges(boardRef, links, JSON.stringify([links, run.agents.map((a) => [a.agentId, a.state])]));

  return (
    <div className="task-body flow-view">
      <div className="flow-summary">
        {run.summary && <div className="flow-summary-text">{run.summary}</div>}
        <div className="flow-stats">
          <span className={`workflow-status ${run.status}`}>{workflowStatusLabel(run.status)}</span>
          <span>{t('workflow.stats.agents', { done, total: run.agents.length })}</span>
          {run.totalToolCalls !== null && <span>{t('workflow.stats.toolCalls', { count: run.totalToolCalls })}</span>}
          {run.totalTokens !== null && <span>{t('workflow.stats.tokens', { count: formatTokens(run.totalTokens) })}</span>}
          {run.durationMs !== null && <span>{formatDuration(run.durationMs)}</span>}
        </div>
        {run.resumedLater && <div className="workflow-note">{t('workflow.flow.resumedLater')}</div>}
        <div className="flow-hint">{t('workflow.flow.hint')}</div>
      </div>
      <div className="flow-scroll">
        <div className="flow-board" ref={boardRef}>
          <svg className="flow-edges" aria-hidden>
            {/* 動いているつながりの線は、グラデーション（左から右へ --grad の 3 色）の破線を流す */}
            <defs>
              <linearGradient id={edgeGradient} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100%" y2="0">
                <stop offset="0" style={{ stopColor: 'var(--claude)' }} />
                <stop offset="0.55" style={{ stopColor: 'var(--ide)' }} />
                <stop offset="1" style={{ stopColor: 'var(--blue)' }} />
              </linearGradient>
            </defs>
            {edges.map((e) => (
              <path key={e.key} d={e.d} className={e.active ? 'active' : undefined} stroke={e.active ? `url(#${edgeGradient})` : undefined} />
            ))}
          </svg>
          {groups.map((group) => (
            <div key={group.key} className="flow-group">
              {group.phases.map((phase, i) => (
                <section key={phase.key} className="flow-phase" data-phase={phase.key}>
                  <header className="flow-phase-head" data-align={i === 0 || undefined} title={phase.detail ?? undefined}>
                    <span className="flow-phase-title">{phase.title ?? t('workflow.phase.unphased')}</span>
                    {phase.detail && <span className="flow-phase-detail">{phase.detail}</span>}
                    {[...new Set(phase.stages.map((s) => s.child).filter((c): c is string => !!c))].map((child) => (
                      <span key={child} className="flow-child">
                        {t('workflow.flow.childWorkflow', { name: child })}
                      </span>
                    ))}
                  </header>
                  <div className="flow-phase-body">
                    {phase.stages.length === 0 && (
                      <div className="flow-stage">
                        <div className="flow-node empty" data-node>
                          {waiting}
                        </div>
                      </div>
                    )}
                    {phase.stages.map((stage) => (
                      <div key={stage.key} className={`flow-stage${stage.child ? ' child' : ''}`} data-stage={stage.key}>
                        {stage.agents.map((agent) => (
                          <AgentNode key={agent.agentId} agent={agent} onClick={() => onOpenAgent(agent.agentId)} />
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

function AgentNode({ agent, onClick }: { agent: WorkflowAgent; onClick: () => void }) {
  const name = agent.label ?? agent.promptPreview?.split('\n')[0] ?? agent.agentId;
  return (
    <button
      className={`flow-node ${agent.state}`}
      data-node
      data-active={agent.state === 'running' || undefined}
      onClick={onClick}
      title={name}
    >
      <span className="flow-node-top">
        <StatusDot state={agent.state === 'running' ? 'running' : agent.state === 'done' ? 'done' : 'error'} />
        <span className="flow-node-name">{name}</span>
      </span>
      <span className="flow-node-meta">
        {agent.model && <span>{shortModel(agent.model)}</span>}
        <span>{agentTools(agent)}</span>
        {agent.durationMs !== null && <span>{formatDuration(agent.durationMs)}</span>}
      </span>
    </button>
  );
}

type Link = { kind: 'stage' | 'phase'; from: string[]; to: string[] };
type Edge = { key: string; d: string; active: boolean };
type Point = { left: number; right: number; y: number; active: boolean };

// 繋ぐ列の組ごとに、ノードを線で繋ぐ。片側が 1 つなら直接、両側が複数なら列の間の 1 点に集めてから分ける。
// 先に、まとまりの先頭のフェーズの見出しを同じ高さに揃える（説明の行数が違っても、エージェントの上端が揃う）
function useEdges(boardRef: React.RefObject<HTMLDivElement | null>, links: Link[], layoutKey: string): Edge[] {
  const [edges, setEdges] = useState<Edge[]>([]);
  const linksRef = useRef(links);
  linksRef.current = links;
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const measure = () => {
      const heads = [...board.querySelectorAll<HTMLElement>('[data-align]')];
      heads.forEach((h) => (h.style.minHeight = ''));
      const tallest = Math.max(0, ...heads.map((h) => h.getBoundingClientRect().height));
      heads.forEach((h) => (h.style.minHeight = `${tallest}px`));

      const origin = board.getBoundingClientRect();
      const stages = new Map<string, Point[]>();
      for (const stage of board.querySelectorAll<HTMLElement>('[data-stage]')) {
        const points = [...stage.querySelectorAll<HTMLElement>('[data-node]')].map((node) => {
          const r = node.getBoundingClientRect();
          return { left: r.left - origin.left, right: r.right - origin.left, y: r.top - origin.top + r.height / 2, active: !!node.dataset.active };
        });
        stages.set(stage.dataset.stage!, points);
      }
      // フェーズの箱は、見出しの行の高さで繋ぐ（箱の高さは揃えているので、中央だと何も無いところに線が出る）
      const phases = new Map<string, Point[]>();
      for (const phase of board.querySelectorAll<HTMLElement>('[data-phase]')) {
        const r = phase.getBoundingClientRect();
        const title = phase.querySelector('.flow-phase-title')?.getBoundingClientRect() ?? r;
        const active = !!phase.querySelector('[data-active]');
        phases.set(phase.dataset.phase!, [
          { left: r.left - origin.left, right: r.right - origin.left, y: title.top - origin.top + title.height / 2, active },
        ]);
      }
      const next: Edge[] = [];
      for (const link of linksRef.current) {
        const points = link.kind === 'phase' ? phases : stages;
        const from = link.from.flatMap((key) => points.get(key) ?? []);
        const to = link.to.flatMap((key) => points.get(key) ?? []);
        if (from.length === 0 || to.length === 0) continue;
        const id = `${link.from.join(',')}>${link.to.join(',')}`;
        if (from.length === 1 || to.length === 1) {
          for (const [a, fa] of from.entries())
            for (const [b, tb] of to.entries()) next.push({ key: `${id}:${a}:${b}`, d: curve(fa.right, fa.y, tb.left, tb.y), active: tb.active });
          continue;
        }
        const mid = (Math.max(...from.map((n) => n.right)) + Math.min(...to.map((n) => n.left))) / 2;
        const hubY = [...from, ...to].reduce((sum, n) => sum + n.y, 0) / (from.length + to.length);
        for (const [a, fa] of from.entries()) next.push({ key: `${id}:${a}:in`, d: curve(fa.right, fa.y, mid, hubY), active: false });
        for (const [b, tb] of to.entries()) next.push({ key: `${id}:out:${b}`, d: curve(mid, hubY, tb.left, tb.y), active: tb.active });
      }
      setEdges(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    return () => observer.disconnect();
  }, [boardRef, layoutKey]);
  return edges;
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const c = (x1 + x2) / 2;
  return `M${x1},${y1} C${c},${y1} ${c},${y2} ${x2},${y2}`;
}
