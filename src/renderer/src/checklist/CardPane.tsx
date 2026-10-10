import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { authorLabel, humanUnread, type Author, type Card, type CardEvent, type Checklist, type ThreadEntry } from '@shared/checklist';
import { t } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import { Markdown } from '../chat/Markdown';
import { CloseIcon, CopyIcon, IconButton, SendIcon, TrashIcon } from '../icons';
import { CardCheck } from './CardCheck';
import { CopyDialog } from './CopyDialog';
import { applyChecklist } from './useChecklists';

// 「Claude に通知する」の前回の選択（画面ごとの使い勝手なので localStorage に持つ）
const NOTIFY_KEY = 'tanacode.checklist.notify';

function loadNotify(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveNotify(on: boolean): void {
  try {
    localStorage.setItem(NOTIFY_KEY, on ? '1' : '0');
  } catch {
    // 覚えられなくても、この画面のあいだは選べる
  }
}

type Props = {
  session: SessionSummary;
  sessions: SessionSummary[];
  list: Checklist;
  card: Card;
  onClose: () => void;
};

// チェックリストのカードの詳細。エディタの場所に出す。上からタイトル・説明文・スレッドの順に並べ、返信欄は下に固定する。
// スレッドはメインのチャットとは別に残る。返信欄の「Claude に通知する」にチェックがあれば、返信したことを手の空いた Claude に知らせる
export function CardPane({ session, sessions, list, card, onClose }: Props) {
  const sessionId = session.id;
  const apply = (op: Parameters<typeof applyChecklist>[1]) => applyChecklist(sessionId, op);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [notify, setNotify] = useState(loadNotify);
  const [sendingCards, setSendingCards] = useState<ReadonlySet<string>>(() => new Set());
  const sending = sendingCards.has(card.id);
  const cardRef = useRef(card.id);
  cardRef.current = card.id;
  const [copying, setCopying] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);
  const unread = humanUnread(card);

  // 開いている間に届いた Claude の返信も、読んだことにする
  useEffect(() => {
    if (unread > 0) void window.tanacode.checklist.apply(sessionId, { type: 'card-read', listId: list.id, cardId: card.id }).catch(() => {});
  }, [sessionId, list.id, card.id, unread]);

  // カードを替えたら、書きかけを捨てて、スレッドの最後を見せる
  useEffect(() => {
    setEditingTitle(null);
    setEditingBody(null);
    setReply('');
  }, [card.id]);
  useLayoutEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' });
  }, [card.id, card.thread.length]);

  const send = async () => {
    const text = reply.trim();
    if (!text || sending) return;
    const id = card.id;
    setSendingCards((prev) => new Set(prev).add(id));
    if ((await apply({ type: 'card-reply', listId: list.id, cardId: id, text, notify })) && cardRef.current === id) setReply('');
    setSendingCards((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const saveTitle = () => {
    const title = editingTitle?.trim();
    setEditingTitle(null);
    if (title && title !== card.title) void apply({ type: 'card-update', listId: list.id, cardId: card.id, title });
  };

  return (
    <section className="editor card-pane">
      <div className="diff-pane-head">
        <CardCheck size="md" checked={card.checked} by={card.checkedBy} onToggle={() => void apply({ type: 'card-check', listId: list.id, cardIds: [card.id], checked: !card.checked })} />
        <span className="card-pane-where">
          {list.name} #{card.number}
        </span>
        <div className="spacer" />
        <IconButton icon={CopyIcon} size="md" label={t('checklist.action.copyToSession')} onClick={() => setCopying(true)} />
        <IconButton
          icon={TrashIcon}
          size="md"
          danger
          label={t('checklist.action.trash')}
          tip={t('checklist.cardPane.trashTip')}
          onClick={() => void apply({ type: 'card-delete', listId: list.id, cardIds: [card.id] }).then((ok) => ok && onClose())}
        />
        <IconButton icon={CloseIcon} size="sm" label={t('common.close')} onClick={onClose} />
      </div>
      <div className="card-pane-scroll">
        {editingTitle !== null ? (
          <textarea
            className="card-pane-title card-pane-title-input"
            rows={1}
            autoFocus
            value={editingTitle}
            // 1 行のタイトルなので、貼り付けた改行は空白にする
            onChange={(e) => setEditingTitle(e.target.value.replace(/\s*\n\s*/g, ' '))}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingTitle(null);
            }}
          />
        ) : (
          <h2 className="card-pane-title" title={t('checklist.cardPane.renameTip')} onDoubleClick={() => setEditingTitle(card.title)}>
            {card.title}
          </h2>
        )}
        <div className="card-pane-meta">
          {t(card.createdBy === 'claude' ? 'checklist.cardPane.createdByClaude' : 'checklist.cardPane.createdByHuman')} · {formatTime(card.createdAt)}
          {card.checked && card.checkedAt && ` · ${t(card.checkedBy === 'claude' ? 'checklist.cardPane.checkedByClaude' : 'checklist.cardPane.checkedByHuman', { time: formatTime(card.checkedAt) })}`}
        </div>
        <div className="card-pane-body">
          {editingBody !== null ? (
            <div className="card-pane-body-edit">
              <textarea
                autoFocus
                rows={8}
                value={editingBody}
                placeholder={t('checklist.cardPane.bodyPlaceholder')}
                onChange={(e) => setEditingBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Escape') setEditingBody(null);
                  if (e.key === 'Enter' && e.metaKey) {
                    void apply({ type: 'card-update', listId: list.id, cardId: card.id, body: editingBody });
                    setEditingBody(null);
                  }
                }}
              />
              <div className="checklist-form-foot">
                <button className="ghost-button" onClick={() => setEditingBody(null)}>
                  {t('common.cancel')}
                </button>
                <button
                  className="send-button"
                  onClick={() => {
                    void apply({ type: 'card-update', listId: list.id, cardId: card.id, body: editingBody });
                    setEditingBody(null);
                  }}
                >
                  {t('checklist.cardPane.saveBody')}
                </button>
              </div>
            </div>
          ) : (
            <>
              {card.body ? <Markdown text={card.body} /> : <p className="card-pane-empty">{t('checklist.cardPane.noBody')}</p>}
              <button className="ghost-button card-pane-edit" onClick={() => setEditingBody(card.body)}>
                {card.body ? t('checklist.cardPane.editBody') : t('checklist.cardPane.writeBody')}
              </button>
            </>
          )}
        </div>
        <div className="card-thread">
          <div className="card-thread-head">{t('checklist.cardPane.thread')}</div>
          {card.thread.map((entry) => (
            <ThreadRow key={entry.id} entry={entry} />
          ))}
          <div ref={threadEnd} />
        </div>
      </div>
      <div className="card-composer">
        <textarea
          rows={3}
          value={reply}
          placeholder={t('checklist.cardPane.replyPlaceholder')}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="card-composer-foot">
          <label className="checklist-notify" data-tip={session.running ? t('checklist.cardPane.notifyTip') : t('checklist.cardPane.notifyTipStopped')}>
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => {
                setNotify(e.target.checked);
                saveNotify(e.target.checked);
              }}
            />
            {t('checklist.cardPane.notify')}
          </label>
          <div className="spacer" />
          <IconButton icon={SendIcon} primary label={t('checklist.cardPane.reply')} tip={t('checklist.cardPane.replyTip')} busy={sending} disabled={!reply.trim()} onClick={() => void send()} />
        </div>
      </div>
      {copying && <CopyDialog session={session} sessions={sessions} list={list} cardIds={[card.id]} onClose={() => setCopying(false)} />}
    </section>
  );
}

function ThreadRow({ entry }: { entry: ThreadEntry }) {
  if (entry.kind === 'event') {
    return (
      <div className="card-thread-event">
        {eventLabel(entry.event, entry.author)} · {formatTime(entry.at)}
      </div>
    );
  }
  return (
    // 作者のクラスは by- を付ける。`claude` だけだと、Claude Code ペイン（.claude）の幅などが当たってしまう
    <div className={`card-thread-reply by-${entry.author}`}>
      <div className="card-thread-reply-head">
        <span className="card-thread-author">{authorLabel(entry.author)}</span>
        <span className="card-thread-time">{formatTime(entry.at)}</span>
        {entry.notify && <span className="card-thread-notified">{t('checklist.cardPane.notified')}</span>}
      </div>
      <Markdown text={entry.text} />
    </div>
  );
}

// 記録の行の文（「Claude がチェックしました」など）。言語によって主語で文の形が変わるので、書いた人ごとに別の文言にする。
// 文言の {from}・{fromList} などには、記録の項目をそのまま埋め込む
function eventLabel(event: CardEvent, author: Author): string {
  return t(`checklist.${author === 'claude' ? 'eventByClaude' : 'eventByHuman'}.${event.type}`, event);
}

// 今日なら時刻だけ、それ以外は日付も
function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
