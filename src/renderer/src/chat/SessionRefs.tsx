import type { ReactNode } from 'react';
import { t } from '@shared/i18n';
import { SESSION_REF_PATTERN } from '@shared/session-tools';
import { tx } from '../i18n';
import { ChevronRightIcon } from '../icons';
import { findSession, sessionName, type SessionLink } from '../sessions/sessionLinks';

// チャットの中の、ほかのセッションへの参照と移る操作（親からの指示の見出し・子からの知らせ・@ で選んだセッションの札）

type Links = {
  sessions: readonly SessionLink[];
  // そのセッションへ移る。無ければ名前だけ出す（タスクの中身の表示の中など）
  onSelectSession: ((id: string) => void) | undefined;
};

// 発言の本文。@ で選んだセッションへの参照（@session:xxxxxxxx（名前））は名前の札にする。
// 名前は今の名前（一覧に無ければ、参照に添えた名前）
export function SessionRefText({ text, sessions, onSelectSession }: Links & { text: string }) {
  const matches = [...text.matchAll(new RegExp(SESSION_REF_PATTERN))];
  if (matches.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of matches) {
    const index = m.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const session = findSession(sessions, m[1]);
    const name = session ? sessionName(session) : m[2] || m[1];
    parts.push(
      session && onSelectSession ? (
        <button key={index} type="button" className="session-ref" onClick={() => onSelectSession(session.id)} data-tip={t('composer.sessionRef.open', { name })}>
          @{name}
        </button>
      ) : (
        <span key={index} className={`session-ref${session ? '' : ' missing'}`} data-tip={session ? undefined : t('composer.sessionRef.missing', { id: m[1] })}>
          @{name}
        </span>
      ),
    );
    last = index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// 親セッションの Claude からの指示に付ける見出し。押すと親セッションへ移る（親を一覧から削除していたら、名前を出さない）。
// isParent: 送ったのが、このセッションの親か。独立したセッションの最初の指示は、親ではなく、起動したセッションからのもの
export function ParentHeading({ parentId, isParent, sessions, onSelectSession }: Links & { parentId: string; isParent: boolean }) {
  const parent = findSession(sessions, parentId);
  const named = isParent ? 'composer.sessionRef.fromParentNamed' : 'composer.sessionRef.fromSessionNamed';
  if (!parent || !onSelectSession) {
    return (
      <div className="chat-from-parent">
        {parent ? t(named, { name: sessionName(parent) }) : t(isParent ? 'composer.sessionRef.fromParent' : 'composer.sessionRef.fromSession')}
      </div>
    );
  }
  const tip = isParent ? t('composer.sessionRef.openParent') : t('composer.sessionRef.open', { name: sessionName(parent) });
  return (
    <button type="button" className="chat-from-parent" onClick={() => onSelectSession(parent.id)} data-tip={tip}>
      {tx(named, { name: <span className="chat-from-parent-name">{sessionName(parent)}</span> })}
      <ChevronRightIcon size={12} />
    </button>
  );
}

// 子セッションからの知らせに付ける、その子へ移るリンク。一覧に無い子は出さない
export function SessionLinkList({ ids, sessions, onSelectSession }: Links & { ids: string[] }) {
  const found = ids.map((id) => findSession(sessions, id)).filter((s): s is SessionLink => !!s);
  if (found.length === 0 || !onSelectSession) return null;
  return (
    <span className="chat-session-links">
      {found.map((s) => (
        <button
          key={s.id}
          type="button"
          className="chat-session-link"
          data-tip={t('composer.sessionRef.open', { name: sessionName(s) })}
          onClick={(e) => {
            // 開ける知らせ（details）の中でも、開閉せずに移る
            e.preventDefault();
            e.stopPropagation();
            onSelectSession(s.id);
          }}
        >
          {sessionName(s)}
          <ChevronRightIcon size={12} />
        </button>
      ))}
    </span>
  );
}
