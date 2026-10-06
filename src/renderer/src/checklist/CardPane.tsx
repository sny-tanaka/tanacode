import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AUTHOR_LABEL, eventText, humanUnread, withParticle, type Card, type Checklist, type ThreadEntry } from '@shared/checklist';
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
  const [sending, setSending] = useState(false);
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
    setSending(true);
    if (await apply({ type: 'card-reply', listId: list.id, cardId: card.id, text, notify })) setReply('');
    setSending(false);
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
        {editingTitle !== null ? (
          <input
            className="card-pane-title-input"
            autoFocus
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingTitle(null);
            }}
          />
        ) : (
          <span className="diff-pane-title card-pane-title" title="ダブルクリックでタイトルを変える" onDoubleClick={() => setEditingTitle(card.title)}>
            {card.title}
          </span>
        )}
        <div className="spacer" />
        <IconButton icon={CopyIcon} size="md" label="別のセッションへコピー" onClick={() => setCopying(true)} />
        <IconButton
          icon={TrashIcon}
          size="md"
          danger
          label="ゴミ箱に入れる"
          tip="ゴミ箱に入れる（サイドパネルのゴミ箱から戻せます）"
          onClick={() => void apply({ type: 'card-delete', listId: list.id, cardIds: [card.id] }).then((ok) => ok && onClose())}
        />
        <IconButton icon={CloseIcon} size="sm" label="閉じる" onClick={onClose} />
      </div>
      <div className="card-pane-scroll">
        <div className="card-pane-meta">
          {withParticle(AUTHOR_LABEL[card.createdBy], 'が')}作成 · {formatTime(card.createdAt)}
          {card.checked && card.checkedAt && ` · ${withParticle(AUTHOR_LABEL[card.checkedBy ?? 'human'], 'が')}チェック（${formatTime(card.checkedAt)}）`}
        </div>
        <div className="card-pane-body">
          {editingBody !== null ? (
            <div className="card-pane-body-edit">
              <textarea
                autoFocus
                rows={8}
                value={editingBody}
                placeholder="説明文（Markdown）"
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
                  キャンセル
                </button>
                <button
                  className="send-button"
                  onClick={() => {
                    void apply({ type: 'card-update', listId: list.id, cardId: card.id, body: editingBody });
                    setEditingBody(null);
                  }}
                >
                  保存（⌘Enter）
                </button>
              </div>
            </div>
          ) : (
            <>
              {card.body ? <Markdown text={card.body} /> : <p className="card-pane-empty">説明文はありません</p>}
              <button className="ghost-button card-pane-edit" onClick={() => setEditingBody(card.body)}>
                {card.body ? '説明文を編集' : '説明文を書く'}
              </button>
            </>
          )}
        </div>
        <div className="card-thread">
          <div className="card-thread-head">スレッド</div>
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
          placeholder="返信（Markdown。⌘Enter で送る）"
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
          <label className="checklist-notify" data-tip={session.running ? '返信したことを、手が空いたら Claude に知らせます' : 'Claude Code が止まっているので、知らせは届きません。Claude は次にチェックリストを読んだとき、未読の返信として気づきます'}>
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => {
                setNotify(e.target.checked);
                saveNotify(e.target.checked);
              }}
            />
            Claude に通知する
          </label>
          <div className="spacer" />
          <IconButton icon={SendIcon} primary label="返信する" tip="返信する（⌘Enter）" busy={sending} disabled={!reply.trim()} onClick={() => void send()} />
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
        {eventText(entry.event, AUTHOR_LABEL[entry.author])} · {formatTime(entry.at)}
      </div>
    );
  }
  return (
    <div className={`card-thread-reply ${entry.author}`}>
      <div className="card-thread-reply-head">
        <span className="card-thread-author">{AUTHOR_LABEL[entry.author]}</span>
        <span className="card-thread-time">{formatTime(entry.at)}</span>
        {entry.notify && <span className="card-thread-notified">Claude に通知</span>}
      </div>
      <Markdown text={entry.text} />
    </div>
  );
}

// 今日なら時刻だけ、それ以外は日付も
function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
