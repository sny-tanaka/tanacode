import { Fragment } from 'react';
import type { HookRun, TodoItem } from '@shared/chat';
import { t } from '@shared/i18n';
import { AnswersCard, ChatRow } from '../chat/ChatRow';
import { HookChip, HookDetail } from '../chat/HookRuns';
import { SentFilesCard } from '../chat/SentFilesCard';
import { TodoList } from '../chat/TodoPanel';
import { DIFF_TOOLS, STATUS_LABEL, ToolDetail } from '../chat/ToolCard';
import type { ChatItem } from '../chat/chatState';
import { toolLabel } from '../chat/toolLabel';
import { groupSummary, groupTools, hookSummary, type HookGroup, type ToolGroup, type ToolItem } from '../chat/toolGroups';
import { DisclosureIcon } from '../icons';
import { StatusDot } from '../layout/StatusDot';
import { formatDateTime, formatPeriod, type ExportMeta } from './exportContent';

type Props = {
  meta: ExportMeta;
  items: ChatItem[];
  // ToDo の一覧を変えたツールの呼び出しごとの、変えたあとの一覧（todoSteps）
  todoSteps: ReadonlyMap<string, TodoItem[]>;
  // 画像の鍵ごとの data URL（読めなかったものは null）
  images: ReadonlyMap<string, string | null>;
  // Markdown を消毒済みの HTML にする（画面では markdownHtml。DOM が要るので差し替えられるようにしておく）
  markdown: (text: string) => string;
};

const NO_TASKS = new Map();

// 作業の書き出しの中身。renderToStaticMarkup で HTML の文字列にする（JavaScript は入れない）。
// 見た目はチャットと同じクラスを使い、畳む・開くは <details> で動かす
export function ExportDocument({ meta, items, todoSteps, images, markdown }: Props) {
  const rows = groupTools(items);
  return (
    <main className="export-page">
      <header className="export-head">
        <div className="export-brand">
          <span className="claude-mark" />
          {t('export.document.brand')}
        </div>
        <h1 className="export-title">{meta.title}</h1>
        <dl className="export-facts">
          <Fact label={t('export.document.folder')} value={meta.cwd} mono />
          {meta.branches.length > 0 && <Fact label={t('export.document.branch')} value={meta.branches.join(' → ')} mono />}
          {meta.period && <Fact label={t('export.document.period')} value={formatPeriod(meta.period)} />}
          <Fact label={t('export.document.range')} value={meta.range} />
          {meta.omitted.length > 0 && <Fact label={t('export.document.omitted')} value={meta.omitted.join(t('export.document.listSeparator'))} />}
        </dl>
        {meta.files.length > 0 && (
          <details className="export-files" open>
            <summary>
              <DisclosureIcon open={false} />
              {t('export.document.changedFiles', { count: meta.files.length })}
            </summary>
            <ul>
              {meta.files.map((file) => (
                <li key={file.path}>
                  <span className="export-file-path">{file.path}</span>
                  <span className="diff-add">+{file.added}</span>
                  <span className="diff-del">−{file.removed}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </header>
      <div className="chat-list export-chat">
        {rows.map((row) => {
          if (row.kind === 'tool-group') {
            const todos = lastTodos(row, todoSteps);
            return (
              <Fragment key={row.id}>
                <ExportToolGroup group={row} images={images} />
                {todos && <ExportTodos todos={todos} />}
              </Fragment>
            );
          }
          if (row.kind === 'hook-group') return <ExportHookGroup key={row.id} group={row} />;
          if (row.kind === 'user') return <ExportUser key={`user:${row.id}`} item={row} images={images} />;
          // 消毒済みの HTML（チャットと同じ Markdown の整形と消毒）
          if (row.kind === 'text') return <div key={`text:${row.id}`} className="markdown" dangerouslySetInnerHTML={{ __html: markdown(row.text) }} />;
          if (row.kind === 'tool' && row.sentFiles) return <SentFilesCard key={`tool:${row.id}`} files={row.sentFiles} failed={row.status === 'error'} />;
          if (row.kind === 'tool' && row.answers) return <AnswersCard key={`tool:${row.id}`} answers={row.answers} />;
          // お知らせ・思考・区切り・エラー・! のコマンドは、チャットの行をそのまま使う（どれも <details> か文字だけ）
          return (
            <ChatRow
              key={`${row.kind}:${row.id}`}
              item={row}
              workflows={NO_TASKS}
              subagents={NO_TASKS}
              bashTasks={NO_TASKS}
              onRewind={null}
              onOpenFile={() => {}}
              onOpenTask={null}
            />
          );
        })}
      </div>
      <footer className="export-foot">{t('export.document.exportedAt', { time: formatDateTime(meta.exportedAt) })}</footer>
    </main>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="export-fact">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  );
}

// まとまりの中で最後に ToDo を変えたあとの一覧（変えていなければ null）
function lastTodos(group: ToolGroup, steps: ReadonlyMap<string, TodoItem[]>): TodoItem[] | null {
  for (let i = group.tools.length - 1; i >= 0; i--) {
    const todos = steps.get(group.tools[i].id);
    if (todos) return todos;
  }
  return null;
}

function ExportUser({ item, images }: { item: Extract<ChatItem, { kind: 'user' }>; images: Props['images'] }) {
  return (
    <div className="chat-user">
      <span className="chat-prompt">›</span>
      <div className="chat-user-body">
        {item.text && <span className="chat-user-text">{item.text}</span>}
        {item.images && <ExportImages keys={item.images} images={images} />}
      </div>
      {item.at !== undefined && (
        <time className="export-time" dateTime={new Date(item.at).toISOString()}>
          {formatDateTime(item.at).slice(5)}
        </time>
      )}
    </div>
  );
}

// 本文と本文の間のツールの呼び出し。チャットと同じく「N件の操作」に畳む
function ExportToolGroup({ group, images }: { group: ToolGroup; images: Props['images'] }) {
  const summary = groupSummary(group);
  return (
    <details className="tool-group export-group">
      <summary className="tool-group-head">
        <DisclosureIcon open={false} />
        <span className="tool-group-count">{summary.count}</span>
        {summary.parts.map((part) => (
          <span key={part} className="tool-group-part">
            · {part}
          </span>
        ))}
        {summary.failed > 0 && <span className="tool-group-failed">· {t('export.document.failed', { count: summary.failed })}</span>}
        {summary.duration && <span className="tool-group-meta">· {summary.duration}</span>}
      </summary>
      <div className="tool-group-list">
        {group.items.map((item) => (item.kind === 'tool' ? <ExportToolCard key={item.id} item={item} images={images} /> : null))}
      </div>
    </details>
  );
}

// ツールの呼び出し 1 件。見出しの行を押すと、入力・差分・結果が開く
function ExportToolCard({ item, images }: { item: ToolItem; images: Props['images'] }) {
  const hasDetail = !!(item.input || item.output || item.patch);
  const head = (
    <>
      <div className="tool-card-head">
        <StatusDot state={item.status} />
        <span className="tool-name">{toolLabel(item.name)}</span>
        {item.description ? <span className="tool-target described">{item.description}</span> : <span className="tool-target">{item.target}</span>}
        {DIFF_TOOLS.has(item.name) && item.added !== undefined && (
          <>
            <span className="diff-add">+{item.added}</span>
            <span className="diff-del">−{item.removed ?? 0}</span>
          </>
        )}
        {hasDetail && (
          <span className="tool-toggle">
            <DisclosureIcon open={false} />
          </span>
        )}
      </div>
      <div className="tool-card-status">{STATUS_LABEL[item.status]}</div>
    </>
  );
  return (
    <div className="tool-card">
      {hasDetail ? (
        <details className="export-tool">
          <summary>{head}</summary>
          <div className="tool-detail">
            <ToolDetail item={item} />
          </div>
        </details>
      ) : (
        head
      )}
      {item.images && <ExportImages keys={item.images} images={images} />}
      {item.hooks && item.hooks.length > 0 && <ExportHookRuns runs={item.hooks} />}
    </div>
  );
}

function ExportHookGroup({ group }: { group: HookGroup }) {
  const summary = hookSummary(group);
  return (
    <details className="tool-group export-group">
      <summary className="tool-group-head">
        <DisclosureIcon open={false} />
        <span className="tool-group-count">{summary.count}</span>
        {summary.events.map((event) => (
          <span key={event} className="tool-group-part">
            · {event}
          </span>
        ))}
        {summary.blocked > 0 && <span className="tool-group-failed">· {t('export.document.blocked', { count: summary.blocked })}</span>}
        {summary.failed > 0 && <span className="tool-group-failed">· {t('export.document.failed', { count: summary.failed })}</span>}
        {summary.duration && <span className="tool-group-meta">· {summary.duration}</span>}
      </summary>
      <div className="tool-group-list">
        <ExportHookRuns runs={group.runs} />
      </div>
    </details>
  );
}

function ExportHookRuns({ runs }: { runs: HookRun[] }) {
  return (
    <div className="hook-runs">
      {runs.map((run, i) => (
        <details key={i} className={`hook-run export-hook ${run.outcome}`}>
          <summary className="hook-chip">
            <HookChip run={run} />
          </summary>
          <HookDetail run={run} />
        </details>
      ))}
    </div>
  );
}

// 画像を小さく並べる。押すと大きく出し、もう一度押すと戻る（JavaScript を使わず、<details> の開閉で切り替える）
function ExportImages({ keys, images }: { keys: string[]; images: Props['images'] }) {
  return (
    <div className="chat-images">
      {keys.map((key) => {
        const url = images.get(key);
        if (!url) {
          return (
            <div key={key} className="chat-image placeholder">
              {t('export.document.imageMissing')}
            </div>
          );
        }
        return (
          <details key={key} className="export-image">
            <summary className="chat-image" aria-label={t('export.document.zoomImage')}>
              <img src={url} alt="" />
            </summary>
          </details>
        );
      })}
    </div>
  );
}

// ToDo の進み具合（そのまとまりで ToDo を変えたあとの一覧）
function ExportTodos({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="todo-panel export-todos">
      <div className="todo-head">
        <span className="todo-title">{t('export.document.todo')}</span>
        <span className="todo-count">
          {done}/{todos.length}
        </span>
      </div>
      <TodoList todos={todos} />
    </div>
  );
}
