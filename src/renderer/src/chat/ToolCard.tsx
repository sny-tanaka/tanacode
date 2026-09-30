import { useEffect, useRef, useState } from 'react';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import { StatusDot, type DotState } from '../layout/StatusDot';
import { BASH_STATE_LABEL } from '../tasks/taskList';
import { ChatImages } from './ChatImages';
import { HookRuns } from './HookRuns';
import { toolLabel } from './toolLabel';
import type { ChatItem } from './chatState';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const STATUS_LABEL = { running: '実行中…', done: '完了', error: 'エラー / 中断' } as const;
const SUBAGENT_LABEL = { running: '実行中…', done: '完了', failed: '失敗', stopped: '停止' } as const;

type Props = {
  item: ToolItem;
  subagent: SubagentRun | undefined;
  // バックグラウンドで起動した Bash
  bash: BashTask | undefined;
  onOpenFile: (absPath: string, line?: number) => void;
  // 中身（サブエージェントの会話・Bash の出力）を大きく開く
  onOpenTask: (() => void) | null;
};

// 実行中から終わったものに変わってから、枠のグラデーションを消し終えてチェックを描き終えるまで（CSS の tool-card の transition より少し長く）
const FINISH_MS = 800;

// 実行中から終わったものに変わった直後か。この間は、流れているグラデーションの枠を止めずに薄くして消し、チェックを描く。
// いきなり切り替えるとちらつくので、効果ではなく描くときに決める（切り替わった回の描画から動きを始める）
function useFinishing(state: DotState): boolean {
  const prev = useRef(state);
  const until = useRef(0);
  const [, setTick] = useState(0);
  const now = Date.now();
  if (prev.current === 'running' && state !== 'running') until.current = now + FINISH_MS;
  prev.current = state;
  const finishing = until.current > now;
  useEffect(() => {
    if (!finishing) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, until.current - Date.now()));
    return () => clearTimeout(timer);
  });
  return finishing;
}

// ツールの呼び出し。▸ で開くと入力・出力・差分を見られる。ファイルを扱うツールはカードのクリックでファイルを開く
export function ToolCard({ item, subagent, bash, onOpenFile, onOpenTask }: Props) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(item.input || item.output || item.patch || subagent?.recent.length || subagent?.result);
  const opensFile = !!item.filePath;
  const status = subagent ? SUBAGENT_LABEL[subagent.state] : bash ? BASH_STATE_LABEL[bash.state] : STATUS_LABEL[item.status];
  const dot: DotState = subagent
    ? subagent.state === 'running' ? 'running' : subagent.state === 'done' ? 'done' : 'error'
    : bash
      ? bash.state === 'running' ? 'running' : bash.state === 'completed' ? 'done' : 'error'
      : item.status;
  const finishing = useFinishing(dot);

  return (
    <div
      className={`tool-card${opensFile || hasDetail || onOpenTask ? ' clickable' : ''}${dot === 'running' ? ' running' : ''}${finishing ? ' finishing' : ''}`}
      onClick={() =>
        onOpenTask ? onOpenTask() : opensFile ? onOpenFile(item.filePath!, item.line) : hasDetail && setOpen((v) => !v)
      }
    >
      <div className="tool-card-head">
        <StatusDot state={dot} animate={finishing} />
        <span className="tool-name" title={item.name}>
          {toolLabel(item.name)}
        </span>
        {/* 何をするかの説明（Bash・Agent などの description）があれば、それだけを出す。コマンドなどの中身は開くと見える */}
        {item.description ? (
          <span className="tool-target described">{item.description}</span>
        ) : (
          <span className="tool-target" title={item.target}>
            {item.target}
          </span>
        )}
        {DIFF_TOOLS.has(item.name) && item.added !== undefined && (
          <>
            <span className="diff-add">+{item.added}</span>
            <span className="diff-del">−{item.removed ?? 0}</span>
          </>
        )}
        {hasDetail && (
          <button
            className={`tool-toggle${open ? ' open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-label={open ? '詳細を閉じる' : '詳細を開く'}
            data-tip={open ? '詳細を閉じる' : '詳細を開く'}
          >
            ▸
          </button>
        )}
      </div>
      <div className="tool-card-status">
        {dot === 'running' ? <span className="flow-text">{status}</span> : status}
        {subagent && <SubagentProgress run={subagent} />}
        {bash && <span className="subagent-progress">バックグラウンド{bash.exitCode !== null ? ` · 終了コード ${bash.exitCode}` : ''}</span>}
        {onOpenTask && <span className="tool-open">開く ›</span>}
      </div>
      {item.images && <ChatImages keys={item.images} />}
      {item.hooks && item.hooks.length > 0 && <HookRuns runs={item.hooks} />}
      {open && (
        <div className="tool-detail" onClick={(e) => e.stopPropagation()}>
          {subagent && subagent.recent.length > 0 && (
            <Section label={subagent.state === 'running' ? '直近のツール' : '最後のツール'}>
              <pre className="tool-pre">{subagent.recent.map((r) => `${toolLabel(r.name)}  ${r.target}`).join('\n')}</pre>
            </Section>
          )}
          {item.input && (
            <Section label={item.name === 'Agent' || item.name === 'Task' ? 'プロンプト' : '入力'}>
              <pre className="tool-pre">{item.input}</pre>
            </Section>
          )}
          {item.patch && (
            <Section label="差分">
              <pre className="tool-pre diff">
                {item.patch.map((line, i) => (
                  <span key={i} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
                    {line}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </Section>
          )}
          {subagent?.result && (
            <Section label="結果">
              <pre className="tool-pre">{subagent.result}</pre>
            </Section>
          )}
          {item.output && (
            <Section label={item.status === 'error' ? 'エラー' : '結果'}>
              <pre className={`tool-pre${item.status === 'error' ? ' error' : ''}`}>{item.output}</pre>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function SubagentProgress({ run }: { run: SubagentRun }) {
  const last = run.recent[run.recent.length - 1];
  const parts = [
    run.background ? 'バックグラウンド' : null,
    `ツール ${run.toolCalls}回`,
    run.state === 'running' && last ? `直前: ${toolLabel(last.name)}` : null,
    run.durationMs !== null ? formatDuration(run.durationMs) : null,
    run.tokens !== null ? `${Math.round(run.tokens / 1000)}k tokens` : null,
  ].filter(Boolean);
  return <span className="subagent-progress">{parts.join(' · ')}</span>;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tool-section">
      <div className="tool-section-label">{label}</div>
      {children}
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`;
}
