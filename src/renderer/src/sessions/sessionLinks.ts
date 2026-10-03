import { useMemo } from 'react';
import type { SessionSummary } from '@shared/ipc';

// チャット（親からの指示・子からの知らせ・@ の参照・セッションのツールのカード）から、ほかのセッションへ移るための控え。ID と名前だけ
export type SessionLink = { id: string; title: string | null };

// 一覧は状態が変わるたびに新しくなる。そのまま渡すとチャットの行（memo している）がすべて描き直されるので、
// 顔ぶれか名前が変わったときだけ新しくする
export function useSessionLinks(sessions: SessionSummary[]): SessionLink[] {
  const key = JSON.stringify(sessions.map((s) => [s.id, s.title]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => sessions.map((s) => ({ id: s.id, title: s.title })), [key]);
}

// ID か、その先頭（8 文字以上）で一覧のセッションを探す。2 つ以上が当てはまるときは、どれか決められないので見つからないことにする
export function findSession<T extends { id: string }>(sessions: readonly T[], idOrPrefix: string): T | null {
  const id = idOrPrefix.trim().toLowerCase();
  if (id.length < 8) return null;
  const hits = sessions.filter((s) => s.id.startsWith(id));
  return hits.length === 1 ? hits[0] : null;
}

// 一覧と同じく、名前がまだ無いセッションは「新しいセッション」
export function sessionName(session: { title: string | null }): string {
  return session.title ?? '新しいセッション';
}
