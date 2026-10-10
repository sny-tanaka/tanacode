import { memo, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { humanUnread, liveCards, liveLists, progressOf, type Card, type Checklist } from '@shared/checklist';
import { t } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import { AddIcon, CloseIcon, CopyIcon, DisclosureIcon, IconButton, TrashIcon } from '../icons';
import { CardCheck } from './CardCheck';
import { CopyDialog } from './CopyDialog';
import { ListForm } from './ListForm';
import { applyChecklist } from './useChecklists';

type Props = {
  session: SessionSummary;
  lists: Checklist[];
  // コピー先に選べるセッション
  sessions: SessionSummary[];
  // 詳細を開いているカード
  activeCardId: string | null;
  onOpen: (listId: string, cardId: string) => void;
};

// ドラッグで運ぶカード（dataTransfer には型だけを入れ、中身はここに持つ）
const DRAG_TYPE = 'application/x-tanacode-cards';

// チェックリスト（サイドパネル）。リストごとに、カードのタイトルだけを縦に並べる。カードを押すと、エディタの場所に詳細を開く。
// チェックはここで直接付け外しできる。⌘・⇧ クリックで複数選んで、別のセッションへのコピー・別のリストへの移動・削除ができる。
// ドラッグで並べ替えと、別のリストへの移動ができる
export const ChecklistPanel = memo(function ChecklistPanel({ session, lists, sessions, activeCardId, onOpen }: Props) {
  const sessionId = session.id;
  const live = liveLists(lists);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // カードを足している（タイトルだけを打つ）リスト
  const [adding, setAdding] = useState<string | null>(null);
  // 作る・名前と説明を変えるリスト（id が null なら新しく作る）
  const [editing, setEditing] = useState<{ id: string | null; name: string; description: string } | null>(null);
  // 選んでいるカード（1 つのリストの中だけ）と、⇧ クリックの起点
  const [selection, setSelection] = useState<{ listId: string; ids: ReadonlySet<string>; anchor: string } | null>(null);
  const [copying, setCopying] = useState<{ list: Checklist; cardIds: string[] } | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const dragging = useRef<{ listId: string; cardIds: string[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // セッションを替えたら、選んでいるものと書きかけを捨てる
  useEffect(() => {
    setSelection(null);
    setAdding(null);
    setEditing(null);
    setCopying(null);
  }, [sessionId]);

  // 消えたカードを選びから外す
  const selected = selection ? [...selection.ids].filter((id) => lists.find((l) => l.id === selection.listId)?.cards.some((c) => c.id === id && !c.deletedAt)) : [];
  const selectedList = selection ? live.find((l) => l.id === selection.listId) : undefined;

  const apply = (op: Parameters<typeof applyChecklist>[1]) => applyChecklist(sessionId, op);

  const clickCard = (e: MouseEvent, list: Checklist, card: Card) => {
    if (e.metaKey || e.ctrlKey) {
      setSelection((prev) => {
        const ids = new Set(prev?.listId === list.id ? prev.ids : []);
        if (!ids.delete(card.id)) ids.add(card.id);
        return ids.size > 0 ? { listId: list.id, ids, anchor: card.id } : null;
      });
      return;
    }
    if (e.shiftKey && selection?.listId === list.id) {
      const cards = liveCards(list);
      const from = cards.findIndex((c) => c.id === selection.anchor);
      const to = cards.findIndex((c) => c.id === card.id);
      if (from >= 0 && to >= 0) {
        const range = cards.slice(Math.min(from, to), Math.max(from, to) + 1).map((c) => c.id);
        setSelection({ listId: list.id, ids: new Set(range), anchor: selection.anchor });
        return;
      }
    }
    setSelection({ listId: list.id, ids: new Set([card.id]), anchor: card.id });
    onOpen(list.id, card.id);
  };

  const toggleList = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // --- ドラッグ ---
  const dragStart = (e: DragEvent, list: Checklist, card: Card) => {
    const ids = selection?.listId === list.id && selection.ids.has(card.id) ? liveCards(list).filter((c) => selection.ids.has(c.id)).map((c) => c.id) : [card.id];
    dragging.current = { listId: list.id, cardIds: ids };
    e.dataTransfer.setData(DRAG_TYPE, '');
    e.dataTransfer.effectAllowed = 'move';
  };
  const dragOver = (e: DragEvent, key: string) => {
    if (!dragging.current || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== key) setDropTarget(key);
  };
  // before: このカードの前に入れる（null ならリストの最後に）
  const drop = (e: DragEvent, toListId: string, before: string | null) => {
    e.preventDefault();
    const moving = dragging.current;
    dragging.current = null;
    setDropTarget(null);
    if (!moving || moving.cardIds.includes(before ?? '')) return;
    void apply({ type: 'card-move', listId: moving.listId, cardIds: moving.cardIds, toListId, before });
  };
  const dragEnd = () => {
    dragging.current = null;
    setDropTarget(null);
  };

  const trashCount = lists.filter((l) => l.deletedAt).length + lists.reduce((n, l) => n + l.cards.filter((c) => c.deletedAt).length, 0);

  return (
    <div className="checklist-panel">
      <div className="checklist-toolbar">
        <button className="ghost-button" onClick={() => setEditing({ id: null, name: '', description: '' })}>
          {t('checklist.panel.createList')}
        </button>
      </div>
      {editing?.id === null && (
        <ListForm
          initial={editing}
          submitLabel={t('checklist.panel.create')}
          onSubmit={async (name, description) => {
            if (await apply({ type: 'list-create', name, description })) setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <div className="checklist-scroll">
        {live.length === 0 && !editing && (
          <div className="scm-empty">{t('checklist.panel.empty')}</div>
        )}
        {live.map((list) => {
          const { done, total } = progressOf(list);
          const open = !collapsed.has(list.id);
          const cards = liveCards(list);
          if (editing?.id === list.id) {
            return (
              <ListForm
                key={list.id}
                initial={editing}
                submitLabel={t('common.save')}
                onSubmit={async (name, description) => {
                  if (await apply({ type: 'list-update', listId: list.id, name, description })) setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            );
          }
          return (
            <div key={list.id} className="checklist-list">
              <div
                className={`checklist-list-head reveal-host${dropTarget === `end:${list.id}` ? ' drop' : ''}`}
                onClick={() => toggleList(list.id)}
                onDoubleClick={() => setEditing({ id: list.id, name: list.name, description: list.description })}
                onDragOver={(e) => dragOver(e, `end:${list.id}`)}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => drop(e, list.id, null)}
                data-tip={t('checklist.panel.listTip', { description: list.description || t('checklist.panel.noDescription') })}
                data-tip-side="right"
              >
                <DisclosureIcon open={open} />
                <span className="checklist-list-name">{list.name}</span>
                <span className={`checklist-progress${total > 0 && done === total ? ' done' : ''}`}>
                  {done}/{total}
                </span>
                <div className="spacer" />
                <IconButton
                  icon={AddIcon}
                  size="sm"
                  reveal
                  label={t('checklist.panel.addCard')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsed((prev) => new Set([...prev].filter((id) => id !== list.id)));
                    setAdding(list.id);
                  }}
                />
                <IconButton
                  icon={TrashIcon}
                  size="sm"
                  reveal
                  danger
                  label={t('checklist.panel.trashList')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(t('checklist.panel.confirmTrashList', { name: list.name }))) void apply({ type: 'list-delete', listId: list.id });
                  }}
                />
              </div>
              {open && list.description && <div className="checklist-list-description">{list.description}</div>}
              {open && (
                <div className="checklist-cards">
                  {cards.map((card) => {
                    const unread = humanUnread(card);
                    const isSelected = selected.includes(card.id);
                    return (
                      <div
                        key={card.id}
                        className={`checklist-card${card.id === activeCardId ? ' active' : ''}${isSelected ? ' selected' : ''}${card.checked ? ' checked' : ''}${dropTarget === card.id ? ' drop' : ''}`}
                        draggable
                        onDragStart={(e) => dragStart(e, list, card)}
                        onDragOver={(e) => dragOver(e, card.id)}
                        onDragLeave={() => setDropTarget(null)}
                        onDrop={(e) => drop(e, list.id, card.id)}
                        onDragEnd={dragEnd}
                        onClick={(e) => clickCard(e, list, card)}
                      >
                        <CardCheck
                          checked={card.checked}
                          by={card.checkedBy}
                          onToggle={() => void apply({ type: 'card-check', listId: list.id, cardIds: [card.id], checked: !card.checked })}
                        />
                        <span className="checklist-number">#{card.number}</span>
                        <span className="checklist-title">{card.title}</span>
                        {unread > 0 && <span className="checklist-unread" data-tip={t('checklist.panel.unreadTip', { count: unread })} aria-label={t('checklist.panel.unreadLabel', { count: unread })} />}
                      </div>
                    );
                  })}
                  {cards.length === 0 && adding !== list.id && <div className="scm-none">{t('checklist.panel.noCards')}</div>}
                  {adding === list.id && (
                    <NewCardInput
                      onSubmit={(title) => void apply({ type: 'card-add', listId: list.id, title })}
                      onClose={() => setAdding(null)}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
        {trashCount > 0 && (
          <Trash
            lists={lists}
            open={trashOpen}
            count={trashCount}
            onToggle={() => setTrashOpen((v) => !v)}
            onRestoreList={(listId) => void apply({ type: 'list-restore', listId })}
            onRestoreCard={(listId, cardId) => void apply({ type: 'card-restore', listId, cardIds: [cardId] })}
            onEmpty={() => {
              if (window.confirm(t('checklist.panel.confirmEmptyTrash', { count: trashCount }))) void apply({ type: 'trash-empty' });
            }}
          />
        )}
      </div>
      {selectedList && selected.length > 1 && (
        <div className="checklist-selection">
          <span className="checklist-selection-count">{t('checklist.panel.selected', { count: selected.length })}</span>
          <div className="spacer" />
          {live.length > 1 && (
            <select
              className="checklist-move"
              value=""
              aria-label={t('checklist.panel.moveToList')}
              onChange={(e) => {
                const toListId = e.target.value;
                if (toListId) void apply({ type: 'card-move', listId: selectedList.id, cardIds: selected, toListId }).then(() => setSelection(null));
              }}
            >
              <option value="">{t('checklist.panel.movePlaceholder')}</option>
              {live
                .filter((l) => l.id !== selectedList.id)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </select>
          )}
          <IconButton icon={CopyIcon} size="sm" label={t('checklist.action.copyToSession')} onClick={() => setCopying({ list: selectedList, cardIds: selected })} />
          <IconButton
            icon={TrashIcon}
            size="sm"
            danger
            label={t('checklist.action.trash')}
            onClick={() => void apply({ type: 'card-delete', listId: selectedList.id, cardIds: selected }).then(() => setSelection(null))}
          />
          <IconButton icon={CloseIcon} size="sm" label={t('checklist.panel.clearSelection')} onClick={() => setSelection(null)} />
        </div>
      )}
      {copying && <CopyDialog session={session} sessions={sessions} list={copying.list} cardIds={copying.cardIds} onClose={() => setCopying(null)} />}
    </div>
  );
});

// カードのタイトルを打って足す。Enter で足して続けて打てる。Esc か、空のまま離れると閉じる
function NewCardInput({ onSubmit, onClose }: { onSubmit: (title: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  return (
    <input
      className="checklist-new-card"
      autoFocus
      placeholder={t('checklist.panel.newCardPlaceholder')}
      value={title}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => {
        if (title.trim()) onSubmit(title.trim());
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter' && title.trim()) {
          onSubmit(title.trim());
          setTitle('');
        }
        if (e.key === 'Escape') onClose();
      }}
    />
  );
}

function Trash({
  lists,
  open,
  count,
  onToggle,
  onRestoreList,
  onRestoreCard,
  onEmpty,
}: {
  lists: Checklist[];
  open: boolean;
  count: number;
  onToggle: () => void;
  onRestoreList: (listId: string) => void;
  onRestoreCard: (listId: string, cardId: string) => void;
  onEmpty: () => void;
}) {
  const trashedLists = lists.filter((l) => l.deletedAt);
  const trashedCards = lists.filter((l) => !l.deletedAt).flatMap((l) => l.cards.filter((c) => c.deletedAt).map((c) => ({ list: l, card: c })));
  return (
    <div className="checklist-trash">
      <button className="checklist-trash-head" onClick={onToggle}>
        <DisclosureIcon open={open} />
        {t('checklist.trash.title')} <span className="scm-count">{count}</span>
      </button>
      {open && (
        <div className="checklist-trash-body">
          {trashedLists.map((list) => (
            <div key={list.id} className="checklist-trash-item">
              <span className="checklist-trash-name">{t('checklist.trash.list', { name: list.name, count: liveCards(list).length })}</span>
              <button className="ghost-button" onClick={() => onRestoreList(list.id)}>
                {t('checklist.trash.restore')}
              </button>
            </div>
          ))}
          {trashedCards.map(({ list, card }) => (
            <div key={card.id} className="checklist-trash-item">
              <span className="checklist-trash-name">
                {list.name} #{card.number} {card.title}
              </span>
              <button className="ghost-button" onClick={() => onRestoreCard(list.id, card.id)}>
                {t('checklist.trash.restore')}
              </button>
            </div>
          ))}
          <button className="ghost-button danger checklist-trash-empty" onClick={onEmpty}>
            {t('checklist.trash.empty')}
          </button>
        </div>
      )}
    </div>
  );
}
