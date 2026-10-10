import { memo } from 'react';
import type { QuestionAnswer } from '@shared/chat';
import { t } from '@shared/i18n';
import type { BashTask, TaskRef } from '@shared/task';
import { useBlockTranslation } from '../translate/BlockTranslation';
import { DisclosureIcon, IconButton, RewindIcon } from '../icons';
import type { WorkflowRuns } from '../workflow/useSessionWorkflows';
import { WorkflowCard } from '../workflow/WorkflowCard';
import type { SessionLink } from '../sessions/sessionLinks';
import { HookRuns } from './HookRuns';
import { ChatImages } from './ChatImages';
import { Markdown } from './Markdown';
import { SentFilesCard } from './SentFilesCard';
import { ParentHeading, SessionLinkList, SessionRefText } from './SessionRefs';
import { ToolCard } from './ToolCard';
import type { ChatItem } from './chatState';
import { isSessionTool } from './toolLabel';
import { openChecklistCard } from '../checklist/openCard';
import type { SubagentRuns } from './useSessionSubagents';

type Props = {
  item: ChatItem;
  workflows: WorkflowRuns;
  subagents: SubagentRuns;
  bashTasks: ReadonlyMap<string, BashTask>;
  onRewind: ((text: string) => void) | null;
  onOpenFile: (absPath: string, line?: number) => void;
  // サブエージェント・ワークフロー・バックグラウンドの Bash の中身を開く。null なら開けない（タスクの中身の表示の中など）
  onOpenTask: ((ref: TaskRef) => void) | null;
  // 本文のシェルのコードブロックを、ターミナルで実行する。無ければ実行ボタンを出さない
  onRunCommand?: (command: string) => void;
  // 一覧のセッション（ID と名前）。親からの指示・子からの知らせ・@ の参照・セッションのツールのカードに、名前を出すのに使う
  sessions?: readonly SessionLink[];
  // そのセッションへ移る。無ければ移れない（タスクの中身の表示の中など）
  onSelectSession?: (id: string) => void;
  // このチャットのセッションの親（無ければ null）。ほかのセッションからの指示が、親からのものかを見分ける
  parentId?: string | null;
};

const NO_SESSIONS: readonly SessionLink[] = [];

// ほかのセッションの名前を出す行か。出さない行は、一覧の名前が変わっても描き直さない
export function showsSessions(item: ChatItem): boolean {
  if (item.kind === 'user') return !!item.parent || item.text.includes('@session:');
  if (item.kind === 'notice') return !!item.sessions?.length;
  return item.kind === 'tool' && isSessionTool(item.name);
}

// タスクの一覧（Map）は、どれかのタスクが動くたびに新しくなる。行に関係するのは、そのツールのタスクだけなので、それだけを比べる
// （一覧の中の変わっていないタスクは、stableRuns で前と同じオブジェクトになっている）
export function sameTasks(a: TaskMaps, b: TaskMaps, ids: string[]): boolean {
  if (a.workflows === b.workflows && a.subagents === b.subagents && a.bashTasks === b.bashTasks) return true;
  return ids.every((id) => a.workflows.get(id) === b.workflows.get(id) && a.subagents.get(id) === b.subagents.get(id) && a.bashTasks.get(id) === b.bashTasks.get(id));
}

export type TaskMaps = Pick<Props, 'workflows' | 'subagents' | 'bashTasks'>;

function sameRow(a: Props, b: Props): boolean {
  return (
    a.item === b.item &&
    a.onRewind === b.onRewind &&
    a.onOpenFile === b.onOpenFile &&
    a.onOpenTask === b.onOpenTask &&
    a.onRunCommand === b.onRunCommand &&
    (!showsSessions(a.item) || (a.sessions === b.sessions && a.onSelectSession === b.onSelectSession && a.parentId === b.parentId)) &&
    sameTasks(a, b, a.item.kind === 'tool' ? [a.item.id] : [])
  );
}

// チャットの 1 行。本体のチャットと、タスク（サブエージェントなど）の中身の表示で使う。
// 入力欄に打つたびにチャット全体が描き直されるので、中身が変わった行だけを描き直す
export const ChatRow = memo(function ChatRow({
  item,
  workflows,
  subagents,
  bashTasks,
  onRewind,
  onOpenFile,
  onOpenTask,
  onRunCommand,
  sessions = NO_SESSIONS,
  onSelectSession,
  parentId = null,
}: Props) {
  if (item.kind === 'user') {
    // 親セッションの Claude からの指示は、人の発言と見分けて出す。
    // 巻き戻しは出さない（Claude Code の /rewind の一覧では囲みの付いた元の文字で出るので、文字で探せない）
    return (
      <div className={`chat-user reveal-host${item.parent ? ' from-parent' : ''}`}>
        <span className="chat-prompt">{item.parent ? '»' : '›'}</span>
        <div className="chat-user-body">
          {item.parent && <ParentHeading parentId={item.parent} isParent={item.parent === parentId} sessions={sessions} onSelectSession={onSelectSession} />}
          {item.text && (
            <span className="chat-user-text">
              <SessionRefText text={item.text} sessions={sessions} onSelectSession={onSelectSession} />
            </span>
          )}
          {item.images && <ChatImages keys={item.images} />}
        </div>
        {onRewind && !item.parent && item.text && !item.text.startsWith('/') && (
          <IconButton
            reveal
            size="sm"
            icon={RewindIcon}
            label={t('chat.row.rewind')}
            tip={t('chat.row.rewindTip')}
            className="chat-rewind"
            onClick={() => onRewind(item.text)}
          />
        )}
      </div>
    );
  }
  if (item.kind === 'text') {
    return <ResponseBlock text={item.text} onRunCommand={onRunCommand} />;
  }
  if (item.kind === 'notice') {
    // 子セッションからの知らせには、その子へ移るリンクを、チェックリストの知らせには、そのカードを開くリンクを添える
    const links = (
      <>
        {item.sessions && <SessionLinkList ids={item.sessions} sessions={sessions} onSelectSession={onSelectSession} />}
        {item.cards && item.cards.length > 0 && (
          <button
            type="button"
            className="session-ref"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openChecklistCard(item.cards![0]);
            }}
            data-tip={t('chat.row.openCardTip')}
          >
            {t('chat.row.openCard')}
          </button>
        )}
      </>
    );
    if (!item.detail) {
      return (
        <div className="chat-notice">
          {item.text}
          {links}
        </div>
      );
    }
    return (
      <details className="chat-notice expandable">
        <summary>
          {/* details の開閉は標準の動きなので、矢印は閉じた形で置き、開いたとき（[open]）に回すのは CSS */}
          <DisclosureIcon open={false} />
          {item.text}
          {links}
        </summary>
        <pre className="chat-notice-detail">{item.detail}</pre>
      </details>
    );
  }
  if (item.kind === 'info') {
    return <div className="chat-info">{item.text}</div>;
  }
  if (item.kind === 'shell') {
    return (
      <details className="chat-shell">
        <summary>
          <span className="chat-shell-prompt">!</span>
          <span className="chat-shell-command">{item.command}</span>
          {item.output && <span className="chat-shell-toggle">{t('chat.row.shellOutput')}</span>}
        </summary>
        {item.output && <pre className="tool-pre">{item.output}</pre>}
      </details>
    );
  }
  if (item.kind === 'divider') {
    return <div className="chat-divider">{item.text}</div>;
  }
  if (item.kind === 'error') {
    return <div className={`chat-error${item.retrying ? ' retrying' : ''}`}>{item.text}</div>;
  }
  if (item.kind === 'hook') {
    return (
      <div className="chat-hooks">
        <span className="chat-hooks-label">{t('chat.row.hooks')}</span>
        <HookRuns runs={item.runs} />
      </div>
    );
  }
  if (item.kind === 'thinking') {
    return <ThinkingBlock text={item.text} />;
  }
  if (item.answers) return <AnswersCard answers={item.answers} />;
  if (item.sentFiles) {
    return <SentFilesCard files={item.sentFiles} failed={item.status === 'error'} onOpenFile={onOpenFile} />;
  }
  if (item.name === 'Workflow') {
    const run = workflows.get(item.id);
    return (
      <WorkflowCard
        run={run}
        fallbackName={item.target}
        onOpen={run && onOpenTask ? () => onOpenTask({ kind: 'workflow', toolUseId: item.id }) : null}
      />
    );
  }
  const subagent = subagents.get(item.id);
  const bash = bashTasks.get(item.id);
  const task: TaskRef | null = subagent ? { kind: 'subagent', toolUseId: item.id } : bash ? { kind: 'bash', toolUseId: item.id } : null;
  return (
    <ToolCard
      item={item}
      subagent={subagent}
      bash={bash}
      onOpenFile={onOpenFile}
      onOpenTask={task && onOpenTask ? () => onOpenTask(task) : null}
      sessions={sessions}
      onSelectSession={onSelectSession}
    />
  );
}, sameRow);

// Claude の応答の本文。日本語でない文なら、右上に翻訳のボタンを出しておき、押すと下に訳文を出す。
// ボタンは本文より先に置いて右へ回り込ませる（本文はボタンをよけて折り返すので、文字が隠れない）
function ResponseBlock({ text, onRunCommand }: { text: string; onRunCommand?: (command: string) => void }) {
  // 訳文のコードブロックには、実行ボタンを付けない（原文の方にある）
  const translation = useBlockTranslation(text, (translated) => <Markdown text={translated} />);
  return (
    <div className="chat-response">
      {translation.button}
      <Markdown text={text} onRunCommand={onRunCommand} />
      {translation.panel}
    </div>
  );
}

// 思考（本文が記録されているときだけ）。翻訳のボタンは見出しの横に出し、訳文は本文の下に出す
function ThinkingBlock({ text }: { text: string }) {
  const translation = useBlockTranslation(text, (translated) => <div className="chat-thinking-text">{translated}</div>);
  return (
    <details className="chat-thinking" open>
      <summary>
        <DisclosureIcon open={false} />
        {t('chat.row.thinking')}
        {translation.button}
      </summary>
      <div className="chat-thinking-text">{text}</div>
      {translation.panel}
    </details>
  );
}

// AskUserQuestion の質問と、選んだ答え。作業の書き出しでも使う
export function AnswersCard({ answers }: { answers: QuestionAnswer[] }) {
  return (
    <div className="chat-answers">
      <div className="chat-answers-label">{t('chat.row.answers')}</div>
      {answers.map((a, i) => (
        <div key={i} className="chat-answer">
          <div className="chat-answer-question">
            {a.header && <span className="chat-answer-header">{a.header}</span>}
            {a.question}
          </div>
          <div className="chat-answer-value">→ {a.answer}</div>
        </div>
      ))}
    </div>
  );
}
