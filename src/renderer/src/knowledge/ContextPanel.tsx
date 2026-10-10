import { useCallback, useMemo, useState } from 'react';
import { compactInstructions, type CompactMark, type ContextItem, type SessionContext } from '@shared/context';
import { t } from '@shared/i18n';
import { tx } from '../i18n';
import { DisclosureIcon } from '../icons';
import { Busy } from '../layout/Busy';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';
import { formatTokens } from '../workflow/WorkflowCard';
import { useCompactMarks, useSessionContext } from './useSessionContext';

type Sort = 'size' | 'time';
const SORT_KEY = 'tanacode.contextSort';

function loadSort(): Sort {
  return readSharedPref(SORT_KEY) === 'time' ? 'time' : 'size';
}

type Props = {
  sessionId: string;
  // 中身の一覧（取りに行っている間は null）
  context: SessionContext | null;
  // 全体の使用量と上限（statusLine の値。応答がまだ無ければ null）
  tokens: number | null;
  limit: number;
  canCompact: boolean;
  compacting: boolean;
  // 組み立てた指示を添えて /compact を送る
  onCompact: (instructions: string) => void;
};

// サイドパネルの「コンテキスト」のセッションごとの入れ物。中身を取りに行く（App で key にセッションの id を付け、
// 切り替えたら作り直す。書きかけの指示を別のセッションに送らないため）
export function SessionContextPanel({
  visible,
  revision,
  ...props
}: Omit<Props, 'context'> & { visible: boolean; revision: number }) {
  const context = useSessionContext(props.sessionId, visible, revision);
  return <ContextPanel {...props} context={context} />;
}

// 今のコンテキストの中身を、大きさの帯と一緒に並べる。行ごとに「残す」「捨てる」の印を付け、印から組み立てた指示を添えて圧縮する
export function ContextPanel({ sessionId, context, tokens, limit, canCompact, compacting, onCompact }: Props) {
  const [sort, setSort] = useState<Sort>(loadSort);
  const [showCompacted, setShowCompacted] = useState(false);
  // 送る前に見せる指示の文（直せる）。null なら一覧の操作中
  const [draft, setDraft] = useState<string | null>(null);
  // 印は今の要約の行（圧縮の区切り）ごと。圧縮が進んだら、前の印は使わない
  const epoch = context?.items.find((i) => i.kind === 'summary' && !i.compacted)?.id ?? '';
  const { marks, toggle, clear } = useCompactMarks(sessionId, epoch);

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
  // 印は、今のコンテキストにあるものだけ数える（圧縮のあとは、前の印は要約に置き換わったものに付いている）
  const keep = current.filter((i) => marks.get(i.id) === 'keep').length;
  const drop = current.filter((i) => marks.get(i.id) === 'drop').length;

  // 印は、圧縮が終わって要約の行が変わるまで残す（送れなかったときに、付け直さなくてよいように）
  const send = () => {
    const text = draft?.trim();
    if (!text || !canCompact) return;
    onCompact(text);
    setDraft(null);
  };
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
          <ContextRow key={item.id} item={item} max={max} mark={marks.get(item.id)} onMark={toggle} />
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

      <div className="context-compact">
        {draft === null ? (
          <>
            <div className="context-compact-row">
              <span className="context-mark-count">{t('context.panel.marks', { keep, drop })}</span>
              {keep + drop > 0 && (
                <button className="ghost-button" onClick={clear}>
                  {t('context.panel.clearMarks')}
                </button>
              )}
              <button
                className="send-button"
                disabled={!canCompact || keep + drop === 0}
                onClick={() => setDraft(compactInstructions(current, marks))}
              >
                {t('context.panel.compactWithMarks')}
              </button>
            </div>
            <p className="context-note">
              {compacting ? (
                <Busy>{t('context.panel.compacting')}</Busy>
              ) : (
                t('context.panel.note')
              )}
            </p>
          </>
        ) : (
          <>
            <div className="context-compact-title">{t('context.panel.draftTitle')}</div>
            <textarea
              value={draft}
              rows={5}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="context-compact-row">
              <button className="ghost-button" onClick={() => setDraft(null)}>
                {t('common.back')}
              </button>
              <button className="send-button" disabled={!canCompact || !draft.trim()} onClick={send}>
                {t('context.panel.compact')}
              </button>
            </div>
            {!canCompact && <p className="context-note">{t('context.panel.cannotCompact')}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function ContextRow({
  item,
  max,
  mark,
  onMark,
}: {
  item: ContextItem;
  max: number;
  mark?: CompactMark;
  onMark?: (itemId: string, mark: CompactMark) => void;
}) {
  const name = nameOf(item);
  return (
    <div className={`context-row${item.compacted ? ' compacted' : ''}${mark ? ` ${mark}` : ''}`}>
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
        {onMark && (
          <span className="context-marks">
            <button className={`context-mark keep${mark === 'keep' ? ' on' : ''}`} aria-pressed={mark === 'keep'} onClick={() => onMark(item.id, 'keep')}>
              {t('context.row.keep')}
            </button>
            <button className={`context-mark drop${mark === 'drop' ? ' on' : ''}`} aria-pressed={mark === 'drop'} onClick={() => onMark(item.id, 'drop')}>
              {t('context.row.drop')}
            </button>
          </span>
        )}
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
