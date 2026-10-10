import { useEffect, useRef, useState } from 'react';
import { cardOfTool } from '@shared/checklist-tools';
import { t } from '@shared/i18n';
import { sessionIdOfTool } from '@shared/session-tools';
import { walkthroughOfTool } from '@shared/walkthrough-tools';
import { openChecklistCard } from '../checklist/openCard';
import { openWalkthroughTarget } from '../walkthrough/openWalkthrough';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import { ChevronRightIcon, DisclosureIcon } from '../icons';
import { StatusDot, type DotState } from '../layout/StatusDot';
import { findSession, sessionName, type SessionLink } from '../sessions/sessionLinks';
import { bashStateLabel } from '../tasks/taskList';
import { ChatImages } from './ChatImages';
import { HookRuns } from './HookRuns';
import { toolLabel } from './toolLabel';
import type { ChatItem, ToolStatus } from './chatState';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

// 変えた行の数（+3 −1）を出すツール
export const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// ツールの状態の名前
export const statusLabel = (status: ToolStatus) => t(`chat.toolCard.${status}`);


type Props = {
  item: ToolItem;
  subagent: SubagentRun | undefined;
  // バックグラウンドで起動した Bash
  bash: BashTask | undefined;
  onOpenFile: (absPath: string, line?: number) => void;
  // 中身（サブエージェントの会話・Bash の出力）を大きく開く
  onOpenTask: (() => void) | null;
  // 一覧のセッション（ID と名前）。セッションのツール（start_session・send_message など）のカードで、対象のセッションを出すのに使う
  sessions?: readonly SessionLink[];
  // 対象のセッションへ移る。無ければ移れない
  onSelectSession?: (id: string) => void;
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

// ツールの呼び出し。右の矢印で開くと入力・出力・差分を見られる。ファイルを扱うツールはカードのクリックでファイルを開く。
// セッションのツールは、カードのクリックで対象のセッションへ移る
export function ToolCard({ item, subagent, bash, onOpenFile, onOpenTask, sessions, onSelectSession }: Props) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(item.input || item.output || item.patch || subagent?.recent.length || subagent?.result);
  const opensFile = !!item.filePath;
  // セッションのツールの対象（start_session は結果の、ほかは入力の session_id。先頭 8 文字のこともあるので、一覧から先頭一致で探す）
  const sessionKey = sessions ? sessionIdOfTool(item.name, item.input, item.output) : null;
  const session = sessionKey && sessions ? findSession(sessions, sessionKey) : null;
  const openSession = session && onSelectSession ? () => onSelectSession(session.id) : null;
  // チェックリストのツールは、カードのクリックで対象のカードを開く（別のセッションへのコピーは、このセッションのカードではないので開かない）
  const card = item.name.endsWith('__cards_copy') ? null : cardOfTool(item.name, item.input);
  const openCard = card ? () => openChecklistCard(card) : null;
  // ウォークスルーのツールは、カードのクリックで今のウォークスルー（start_walkthrough）か、示した場所（show_code）を開く
  const walk = walkthroughOfTool(item.name, item.input);
  const openWalk = walk ? () => openWalkthroughTarget(walk) : null;
  // 入力の session_id がそのまま対象に出るツール（send_message など）は、ID の代わりに名前を出す
  const targetIsId = !!sessionKey && /^[0-9a-f-]{8,36}$/.test(item.target.trim());
  const target = targetIsId && session ? sessionName(session) : item.target;
  const status = subagent ? t(`chat.toolCard.${subagent.state}`) : bash ? bashStateLabel(bash.state) : statusLabel(item.status);
  const dot: DotState = subagent
    ? subagent.state === 'running' ? 'running' : subagent.state === 'done' ? 'done' : 'error'
    : bash
      ? bash.state === 'running' ? 'running' : bash.state === 'completed' ? 'done' : 'error'
      : item.status;
  const finishing = useFinishing(dot);

  return (
    <div
      className={`tool-card${opensFile || hasDetail || onOpenTask || openSession || openCard || openWalk ? ' clickable' : ''}${dot === 'running' ? ' running' : ''}${finishing ? ' finishing' : ''}`}
      onClick={() =>
        onOpenTask
          ? onOpenTask()
          : openSession
            ? openSession()
            : openCard
              ? openCard()
              : openWalk
              ? openWalk()
              : opensFile
              ? onOpenFile(item.filePath!, item.line)
              : hasDetail && setOpen((v) => !v)
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
            {target}
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
            className="tool-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-label={open ? t('chat.toolCard.closeDetail') : t('chat.toolCard.openDetail')}
            data-tip={open ? t('chat.toolCard.closeDetail') : t('chat.toolCard.openDetail')}
          >
            <DisclosureIcon open={open} />
          </button>
        )}
      </div>
      <div className="tool-card-status">
        {dot === 'running' ? <span className="flow-text">{status}</span> : status}
        {subagent && <SubagentProgress run={subagent} />}
        {bash && (
          <span className="subagent-progress">
            {t('chat.toolCard.background')}
            {bash.exitCode !== null ? ` · ${t('chat.toolCard.exitCode', { code: bash.exitCode })}` : ''}
          </span>
        )}
        {/* 対象のセッションの名前（対象の欄に名前を出していなければ） */}
        {session && !(targetIsId && !item.description) && <span className="subagent-progress tool-session">{sessionName(session)}</span>}
        {/* カード全体のクリックで開くので、ボタンにはせず、名前とツールチップだけ付けたアイコンを置く */}
        {onOpenTask ? (
          <span className="tool-open" role="img" aria-label={t('common.open')} data-tip={t('common.open')}>
            <ChevronRightIcon size={12} />
          </span>
        ) : (
          openSession && (
            <span className="tool-open" role="img" aria-label={t('chat.toolCard.openSession')} data-tip={t('chat.toolCard.openSessionNamed', { name: sessionName(session!) })}>
              <ChevronRightIcon size={12} />
            </span>
          )
        )}
      </div>
      {item.images && <ChatImages keys={item.images} />}
      {item.hooks && item.hooks.length > 0 && <HookRuns runs={item.hooks} />}
      {open && (
        <div className="tool-detail" onClick={(e) => e.stopPropagation()}>
          <ToolDetail item={item} subagent={subagent} />
        </div>
      )}
    </div>
  );
}

// 開いたカードの中身（入力・差分・結果）。作業の書き出しでも使う
export function ToolDetail({ item, subagent }: { item: ToolItem; subagent?: SubagentRun }) {
  return (
    <>
      {subagent && subagent.recent.length > 0 && (
        <Section label={subagent.state === 'running' ? t('chat.toolCard.recentTools') : t('chat.toolCard.finalTools')}>
          <pre className="tool-pre">{subagent.recent.map((r) => `${toolLabel(r.name)}  ${r.target}`).join('\n')}</pre>
        </Section>
      )}
      {item.input && (
        <Section label={item.name === 'Agent' || item.name === 'Task' ? t('chat.toolCard.prompt') : t('chat.toolCard.input')}>
          <pre className="tool-pre">{item.input}</pre>
        </Section>
      )}
      {item.patch && (
        <Section label={t('chat.toolCard.diff')}>
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
        <Section label={t('chat.toolCard.result')}>
          <pre className="tool-pre">{subagent.result}</pre>
        </Section>
      )}
      {item.output && (
        <Section label={item.status === 'error' ? t('chat.toolCard.errorOutput') : t('chat.toolCard.result')}>
          <pre className={`tool-pre${item.status === 'error' ? ' error' : ''}`}>{item.output}</pre>
        </Section>
      )}
    </>
  );
}

function SubagentProgress({ run }: { run: SubagentRun }) {
  const last = run.recent[run.recent.length - 1];
  const parts = [
    run.background ? t('chat.toolCard.background') : null,
    t('chat.toolCard.toolCalls', { count: run.toolCalls }),
    run.state === 'running' && last ? t('chat.toolCard.previousTool', { tool: toolLabel(last.name) }) : null,
    run.durationMs !== null ? formatDuration(run.durationMs) : null,
    run.tokens !== null ? t('chat.toolCard.tokens', { count: Math.round(run.tokens / 1000) }) : null,
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
  return s < 60 ? t('chat.duration.seconds', { count: s }) : t('chat.duration.minutesSeconds', { minutes: Math.floor(s / 60), seconds: s % 60 });
}
