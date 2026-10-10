import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatEvent } from '@shared/chat';
import { t } from '@shared/i18n';
import type { SubagentRun } from '@shared/subagent';
import type { AgentLogRef, BashTask } from '@shared/task';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';
import { ChatRow } from '../chat/ChatRow';
import { HookGroupRow } from '../chat/HookGroupRow';
import { ToolGroupRow } from '../chat/ToolGroupRow';
import { groupTools, reuseGroups, type ChatRowItem } from '../chat/toolGroups';
import { Markdown } from '../chat/Markdown';
import { chatFromEvents } from '../chat/chatState';
import { WorkingNote } from '../chat/WorkingNote';
import { formatDuration, formatTokens, groupByPhase, shortModel } from '../workflow/WorkflowCard';
import { WorkflowFlow } from '../workflow/WorkflowFlow';
import { bashStateLabel, elapsed, stoppable, taskStateLabel, useNow, type TaskEntry } from './taskList';
import { Busy } from '../layout/Busy';
import { CloseIcon, DisclosureIcon, FlowIcon, IconButton, StopIcon } from '../icons';
import { StatusDot } from '../layout/StatusDot';

// 実行中の会話ログを読み直す間隔
const POLL_MS = 1000;
const NO_RUNS = new Map();

type Props = {
  sessionId: string;
  task: TaskEntry;
  subagent: SubagentRun | undefined;
  workflow: WorkflowRun | undefined;
  bash: BashTask | undefined;
  // 動いているものを止める。stopping: 止めている途中
  stopping: boolean;
  onStop: () => void;
  onClose: () => void;
  onOpenFile: (absPath: string, line?: number) => void;
};

// サブエージェント・ワークフロー・バックグラウンドの Bash の中身。エディタの場所に大きく出す
export function TaskPane({ sessionId, task, subagent, workflow, bash, stopping, onStop, onClose, onOpenFile }: Props) {
  const subagentRef = useMemo<AgentLogRef>(() => ({ kind: 'subagent', toolUseId: task.ref.toolUseId }), [task.ref.toolUseId]);
  return (
    <section className="editor task-pane">
      <div className="diff-pane-head">
        <StatusDot state={task.state === 'running' ? 'running' : task.state === 'done' ? 'done' : 'error'} />
        <span className="task-pane-kind">{t(`tasks.paneKind.${task.ref.kind}`)}</span>
        <span className="diff-pane-title task-pane-title" title={task.name}>
          {task.name}
        </span>
        <TaskMeta task={task} subagent={subagent} workflow={workflow} bash={bash} />
        <div className="spacer" />
        {stoppable(task) && (
          <IconButton
            icon={StopIcon}
            danger
            size="md"
            busy={stopping}
            label={stopping ? t('tasks.stop.stopping') : t('tasks.stop.stop')}
            tip={stopping ? t('tasks.stop.stoppingTip') : undefined}
            onClick={onStop}
          />
        )}
        <IconButton icon={CloseIcon} size="sm" label={t('common.close')} onClick={onClose} />
      </div>
      {task.ref.kind === 'subagent' && (
        <AgentConversation
          sessionId={sessionId}
          logRef={subagentRef}
          live={task.state === 'running'}
          result={subagent?.result ?? null}
          onOpenFile={onOpenFile}
        />
      )}
      {task.ref.kind === 'workflow' && workflow && (
        <WorkflowView key={workflow.toolUseId} sessionId={sessionId} run={workflow} onOpenFile={onOpenFile} />
      )}
      {task.ref.kind === 'bash' && bash && <BashView task={bash} />}
    </section>
  );
}

// 見出しの横の状態・経過時間など。経過時間を 1 秒ごとに進めるので、描き直すのはここだけにする
function TaskMeta({ task, subagent, workflow, bash }: Pick<Props, 'task' | 'subagent' | 'workflow' | 'bash'>) {
  const now = useNow(task.state === 'running');
  const ms = elapsed(task, now);
  const tokens = subagent?.tokens ?? workflow?.totalTokens ?? null;
  return (
    <span className="diff-pane-kind">
      <span className={task.state === 'running' ? 'flow-text' : undefined}>
        {task.ref.kind === 'bash' && bash ? bashStateLabel(bash.state).replace('…', '') : taskStateLabel(task.state)}
      </span>
      {[
        task.background && task.ref.kind === 'subagent' ? t('tasks.pane.background') : null,
        subagent?.model ? shortModel(subagent.model) : null,
        ms !== null ? formatDuration(ms) : null,
        tokens !== null ? t('tasks.pane.tokens', { count: formatTokens(tokens) }) : null,
      ]
        .filter(Boolean)
        .map((part) => ` · ${part}`)
        .join('')}
    </span>
  );
}

// エージェントの会話。本体のチャットと同じ形で出す。最初の発言（起動時の指示）は折りたためるようにする。
// 会話ログは 1 秒ごとに読み直すので、行が増えたときだけ組み立て直す
const AgentConversation = memo(function AgentConversation({
  sessionId,
  logRef,
  live,
  result,
  onOpenFile,
}: {
  sessionId: string;
  logRef: AgentLogRef;
  live: boolean;
  result: string | null;
  onOpenFile: (absPath: string, line?: number) => void;
}) {
  const [events, setEvents] = useState<ChatEvent[] | null>(null);
  const key = JSON.stringify(logRef);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setEvents(null);
    stick.current = true;
  }, [key]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void window.tanacode.tasks.agentLog(sessionId, logRef).then((next) => {
        if (!cancelled) setEvents((prev) => (prev && prev.length === next.length ? prev : next));
      });
    load();
    // 終わった直後の書き込みも拾うため、終わってからも一度読む
    const timer = live ? setInterval(load, POLL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, key, live]);

  const items = useMemo(() => (events ? chatFromEvents(events).items : []), [events]);
  // メインのチャットと同じく、本文と本文の間のツールの呼び出しを「N件の操作」に畳み、実行中のものだけを下に出す
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = useCallback(
    (id: string) =>
      setOpenGroups((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  useEffect(() => setOpenGroups(new Set()), [key]);
  const prompt = items[0];
  const previousRows = useRef<ChatRowItem[]>([]);
  const rows = useMemo(
    // 最初の発言（指示）は上に別に出すので、まとめるのはその後ろから
    () => (previousRows.current = reuseGroups(previousRows.current, groupTools(items[0]?.kind === 'user' ? items.slice(1) : items))),
    [items],
  );
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stick.current) list.scrollTop = list.scrollHeight;
  }, [items.length]);

  return (
    <div
      className="task-body chat-list"
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {events === null && (
        <div className="chat-note">
          <Busy>{t('tasks.pane.loading')}</Busy>
        </div>
      )}
      {events !== null && items.length === 0 && <div className="chat-note">{live ? <Busy>{t('tasks.pane.starting')}</Busy> : t('tasks.pane.noLog')}</div>}
      {prompt?.kind === 'user' && <PromptDetails key={key} text={prompt.text} />}
      {rows.map((row) =>
        row.kind === 'tool-group' ? (
          <ToolGroupRow
            key={row.id}
            group={row}
            open={openGroups.has(row.id)}
            onToggle={toggleGroup}
            workflows={NO_RUNS}
            subagents={NO_RUNS}
            bashTasks={NO_RUNS}
            onOpenFile={onOpenFile}
            onOpenTask={null}
          />
        ) : row.kind === 'hook-group' ? (
          <HookGroupRow key={row.id} group={row} open={openGroups.has(row.id)} onToggle={toggleGroup} />
        ) : (
          <ChatRow
            key={`${row.kind}:${row.id}`}
            item={row}
            workflows={NO_RUNS}
            subagents={NO_RUNS}
            bashTasks={NO_RUNS}
            onRewind={null}
            onOpenFile={onOpenFile}
            onOpenTask={null}
          />
        ),
      )}
      {live && <WorkingNote />}
      {result && !sameAsLastText(items, result) && (
        <div className="task-result">
          <div className="task-result-label">{t('tasks.pane.result')}</div>
          <Markdown text={result} />
        </div>
      )}
    </div>
  );
});

// 最初の発言（起動時の指示）。長いときは畳んでおく。矢印を出すので、開いているかを持つ
function PromptDetails({ text }: { text: string }) {
  const [open, setOpen] = useState(text.length < 600);
  return (
    <details className="task-prompt" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <DisclosureIcon open={open} />
        {t('tasks.pane.prompt')}
      </summary>
      <Markdown text={text} />
    </details>
  );
}

// 結果は最後の返事と同じことが多い。同じなら重ねて出さない（結果は長いと途中で切られている）
function sameAsLastText(items: ReturnType<typeof chatFromEvents>['items'], result: string): boolean {
  const last = [...items].reverse().find((i) => i.kind === 'text');
  if (!last || last.kind !== 'text') return false;
  const head = (text: string) => text.replace(/\s+/g, '').slice(0, 200);
  return head(last.text) === head(result);
}

// ワークフロー: 開いたときはフロー図のまとめ。エージェントを選ぶと、左にフェーズごとのエージェント、右にその会話
// ワークフローの中身。GitHub Actions の実行の画面のように、左に「概要」と全エージェントの一覧をいつも出し、
// 選んだものを右に出す（概要ならフロー図、エージェントならその中のやりとり）。フロー図のエージェントを押しても、一覧で選んだのと同じになる
function WorkflowView({ sessionId, run, onOpenFile }: { sessionId: string; run: WorkflowRun; onOpenFile: (absPath: string, line?: number) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const agent = run.agents.find((a) => a.agentId === selected) ?? null;
  const agentId = agent?.agentId ?? null;
  const logRef = useMemo<AgentLogRef | null>(
    () => (agentId ? { kind: 'workflow', toolUseId: run.toolUseId, agentId } : null),
    [run.toolUseId, agentId],
  );
  const groups = groupByPhase(run);
  return (
    <div className="task-split">
      <div className="task-agents">
        <button className={`task-agent task-overview${agent ? '' : ' active'}`} onClick={() => setSelected(null)}>
          <FlowIcon size={14} />
          <span className="task-agent-name">{t('tasks.workflow.overview')}</span>
        </button>
        <div className="task-agents-label">{t('tasks.workflow.allAgents')}</div>
        {groups.map((group) => (
          <div key={group.title} className="task-phase">
            <div className="task-phase-title">
              <span className="task-phase-name">{group.title}</span>
              {group.detail && <span className="workflow-phase-detail">{group.detail}</span>}
            </div>
            {group.agents.length === 0 && <div className="workflow-empty">{run.status === 'running' ? t('tasks.workflow.waiting') : t('tasks.workflow.noAgents')}</div>}
            {group.agents.map((a) => (
              <AgentItem key={a.agentId} agent={a} active={a.agentId === agentId} onClick={() => setSelected(a.agentId)} />
            ))}
          </div>
        ))}
      </div>
      {agent && logRef ? (
        <AgentConversation
          sessionId={sessionId}
          logRef={logRef}
          live={agent.state === 'running'}
          result={agent.state !== 'running' ? agent.resultPreview : null}
          onOpenFile={onOpenFile}
        />
      ) : (
        <WorkflowFlow run={run} onOpenAgent={setSelected} />
      )}
    </div>
  );
}

function AgentItem({ agent, active, onClick }: { agent: WorkflowAgent; active: boolean; onClick: () => void }) {
  const name = agent.label ?? agent.promptPreview?.split('\n')[0] ?? agent.agentId;
  return (
    <button className={`task-agent${active ? ' active' : ''}`} onClick={onClick} title={name}>
      <StatusDot state={agent.state === 'running' ? 'running' : agent.state === 'done' ? 'done' : 'error'} />
      <span className="task-agent-name">{name}</span>
      <span className="task-agent-meta">
        {agent.model && <span>{shortModel(agent.model)}</span>}
        <span>
          {agent.state === 'running' && agent.lastTool
            ? t('tasks.workflow.toolCallsRunning', { count: agent.toolCalls, tool: agent.lastTool })
            : t('tasks.workflow.toolCalls', { count: agent.toolCalls })}
        </span>
        {agent.durationMs !== null && <span>{formatDuration(agent.durationMs)}</span>}
      </span>
    </button>
  );
}

// バックグラウンドの Bash: コマンドと、流れてくる出力
function BashView({ task }: { task: BashTask }) {
  const outRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [task.output]);
  return (
    <div className="task-body bash-view">
      <pre className="bash-command">
        <span className="bash-prompt">$ </span>
        {task.command}
      </pre>
      <pre
        className="bash-output"
        ref={outRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {task.truncated && <span className="bash-note">{t('tasks.bash.truncated')}{'\n'}</span>}
        {task.output || (task.state === 'running' ? '' : t('tasks.bash.noOutput'))}
        {task.state === 'running' && <span className="bash-cursor">▍</span>}
      </pre>
      <div className="bash-foot">
        {task.state === 'running'
          ? <span className="flow-text">{bashStateLabel('running')}</span>
          : task.exitCode !== null
            ? t('tasks.bash.exitCode', { code: task.exitCode })
            : bashStateLabel(task.state)}
        <span className="bash-id">{t('tasks.bash.taskId', { id: task.taskId })}</span>
      </div>
    </div>
  );
}
