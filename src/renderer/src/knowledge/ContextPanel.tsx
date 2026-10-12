import { useCallback, useMemo, useState } from 'react';
import type { ContextItem, SessionContext } from '@shared/context';
import { t } from '@shared/i18n';
import { tx } from '../i18n';
import { DisclosureIcon } from '../icons';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';
import { formatTokens } from '../workflow/WorkflowCard';
import { useSessionContext } from './useSessionContext';

type Sort = 'size' | 'time';
const SORT_KEY = 'tanacode.contextSort';

function loadSort(): Sort {
  return readSharedPref(SORT_KEY) === 'time' ? 'time' : 'size';
}

type Props = {
  // 中身の一覧（取りに行っている間は null）
  context: SessionContext | null;
  // 全体の使用量と上限（statusLine の値。応答がまだ無ければ null）
  tokens: number | null;
  limit: number;
};

// サイドパネルの「コンテキスト」のセッションごとの入れ物。中身を取りに行く（App で key にセッションの id を付け、切り替えたら作り直す）
export function SessionContextPanel({
  sessionId,
  visible,
  revision,
  ...props
}: Omit<Props, 'context'> & { sessionId: string; visible: boolean; revision: number }) {
  const context = useSessionContext(sessionId, visible, revision);
  return <ContextPanel {...props} context={context} />;
}

// 今のコンテキストの中身（何がどれだけ入っているか）を、大きさの帯と一緒に並べる
export function ContextPanel({ context, tokens, limit }: Props) {
  const [sort, setSort] = useState<Sort>(loadSort);
  const [showCompacted, setShowCompacted] = useState(false);

  const changeSort = useCallback((next: Sort) => {
    setSort(next);
    writeSharedPref(SORT_KEY, next);
  }, []);
  useSharedPrefChange(SORT_KEY, () => setSort(loadSort()));

  const items = context?.items ?? [];
  const current = useMemo(() => sorted(items.filter((i) => !i.compacted), sort), [items, sort]);
  const compacted = useMemo(() => sorted(items.filter((i) => i.compacted), sort), [items, sort]);
  const listed = current.reduce((sum, i) => sum + i.tokens, 0);
  // 帯の長さは、いちばん大きいものに対する割合
  const max = maxOf(current);
  const compactedMax = maxOf(compacted);
  // 圧縮の直後は、全体の使用量が次の応答まで分からない（会話ログの圧縮後の量は、システムプロンプトなどを含まない）
  const known = tokens !== null && tokens >= listed;

  if (!context) return <div className="scm-empty">{t('context.panel.loading')}</div>;
  if (items.length === 0) return <div className="scm-empty">{t('context.panel.empty')}</div>;

  return (
    <div className="context-panel">
      <div className="context-summary">
        {known ? (
          <div className="context-total">
            {tx('context.panel.total', {
              tokens: <strong>{formatTokens(tokens)}</strong>,
              limit: limit >= 1_000_000 ? `${limit / 1_000_000}M` : formatTokens(limit),
              percent: Math.round((tokens / limit) * 100),
            })}
          </div>
        ) : (
          <div className="context-total">{t('context.panel.totalUnknown')}</div>
        )}
        <div className="context-breakdown">
          {t('context.panel.listed', { tokens: formatTokens(listed) })}
          {known && tokens > listed && <> · {t('context.panel.other', { tokens: formatTokens(tokens - listed) })}</>}
        </div>
        <div className="context-toolbar">
          <div className="segmented text" role="tablist" aria-label={t('context.panel.sort')}>
            <button role="tab" aria-selected={sort === 'size'} className={sort === 'size' ? 'active' : ''} onClick={() => changeSort('size')}>
              {t('context.panel.sortBySize')}
            </button>
            <button role="tab" aria-selected={sort === 'time'} className={sort === 'time' ? 'active' : ''} onClick={() => changeSort('time')}>
              {t('context.panel.sortByTime')}
            </button>
          </div>
        </div>
      </div>

      <div className="context-list">
        {current.map((item) => (
          <ContextRow key={item.id} item={item} max={max} />
        ))}
        {compacted.length > 0 && (
          <>
            <button className="context-compacted-head" aria-expanded={showCompacted} onClick={() => setShowCompacted((v) => !v)}>
              <DisclosureIcon open={showCompacted} />
              {t('context.panel.compacted', { count: compacted.length })}
            </button>
            {showCompacted && compacted.map((item) => <ContextRow key={item.id} item={item} max={compactedMax} />)}
          </>
        )}
      </div>

      <p className="context-note">{t('context.panel.note')}</p>
    </div>
  );
}

function ContextRow({
  item,
  max,
}: {
  item: ContextItem;
  max: number;
}) {
  const name = nameOf(item);
  return (
    <div className={`context-row${item.compacted ? ' compacted' : ''}`}>
      <div className="context-row-head">
        <span className="context-kind">{kindOf(item)}</span>
        <span className="context-label" data-tip={name}>
          {name}
        </span>
        <span className="context-tokens">{formatTokens(item.tokens)}</span>
      </div>
      <div className="context-row-foot">
        <span className="context-bar">
          <span style={{ width: `${max > 0 ? Math.max((item.tokens / max) * 100, 1) : 0}%` }} />
        </span>
      </div>
    </div>
  );
}

function sorted(items: ContextItem[], sort: Sort): ContextItem[] {
  return [...items].sort((a, b) => (sort === 'size' ? b.tokens - a.tokens || a.order - b.order : a.order - b.order));
}

function maxOf(items: ContextItem[]): number {
  return items.reduce((max, i) => Math.max(max, i.tokens), 0);
}

// 種類の短い名前
function kindOf(item: ContextItem): string {
  switch (item.kind) {
    case 'file':
      return item.edited ? t('context.kind.written') : t('context.kind.read');
    case 'tool':
      return item.tool ? shortTool(item.tool) : t('context.kind.notice');
    case 'image':
      return t('context.kind.image');
    case 'agent':
      return t('context.kind.agent');
    case 'topic':
      return t('context.kind.topic');
    case 'summary':
      return t('context.kind.summary');
  }
}

function nameOf(item: ContextItem): string {
  if (item.kind === 'image' && item.tool) return [shortTool(item.tool), item.label].filter(Boolean).join(' · ');
  return item.label || shortTool(item.tool ?? '');
}

// MCP のツール（mcp__<サーバー>__<ツール>）は、ツールの名前だけ
function shortTool(tool: string): string {
  return /^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool;
}
