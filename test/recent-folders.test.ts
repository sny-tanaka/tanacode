import { expect, it } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { listRecentFolders, parseHiddenFolders } from '@shared/recent-folders';

// 新規セッションの「最近のフォルダ」

const session = (cwd: string, createdAt = 0, worktreeRoot?: string): SessionSummary => ({
  id: `${cwd}@${createdAt}`,
  title: null,
  cwd,
  archived: false,
  createdAt,
  updatedAt: createdAt,
  running: false,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: worktreeRoot ? { name: 'w', branch: 'worktree-w', root: worktreeRoot, preparing: null } : null,
});

it('セッションの並び（新しい順）のまま、フォルダをひとつずつ出す', () => {
  const sessions = [session('/work/a'), session('/work/b'), session('/work/a')];
  expect(listRecentFolders(sessions, {})).toEqual(['/work/a', '/work/b']);
});

it('worktree のセッションは、worktree ではなく元のフォルダを出す', () => {
  const sessions = [session('/work/a/.claude/worktrees/w', 0, '/work/a'), session('/work/a')];
  expect(listRecentFolders(sessions, {})).toEqual(['/work/a']);
});

it('外したフォルダは出さない。外したフォルダのセッションは、一覧に残る', () => {
  const sessions = [session('/work/a', 100), session('/work/b', 100)];
  expect(listRecentFolders(sessions, { '/work/a': 200 })).toEqual(['/work/b']);
});

it('外したあとに、そのフォルダで新しいセッションを作ったら、また出す', () => {
  const sessions = [session('/work/a', 300), session('/work/b', 100), session('/work/a', 100)];
  expect(listRecentFolders(sessions, { '/work/a': 200 })).toEqual(['/work/a', '/work/b']);
});

it('外したあとに更新されただけの古いセッションでは、戻らない', () => {
  // a のセッションは外したあとも使われている（先頭）が、作ったのは外す前
  const sessions = [session('/work/a', 100), session('/work/b', 100)];
  expect(listRecentFolders(sessions, { '/work/a': 200 })).toEqual(['/work/b']);
});

it('戻ったときの並びは、フォルダのセッションが最初に出てくる位置のまま', () => {
  // 先頭の a は外す前に作ったもの、3 番目の a は外したあとに作ったもの
  const sessions = [session('/work/a', 150), session('/work/b', 100), session('/work/a', 300)];
  expect(listRecentFolders(sessions, { '/work/a': 200 })).toEqual(['/work/a', '/work/b']);
});

it('worktree のセッションを外したあとに作っても、元のフォルダが戻る', () => {
  const sessions = [session('/work/a/.claude/worktrees/w', 300, '/work/a'), session('/work/a', 100)];
  expect(listRecentFolders(sessions, { '/work/a': 200 })).toEqual(['/work/a']);
});

it('保存した JSON を読み直す。壊れたもの・型が違うものは捨てる', () => {
  expect(parseHiddenFolders('{"/work/a":200}')).toEqual({ '/work/a': 200 });
  expect(parseHiddenFolders('{"/work/a":200,"/work/b":"x","/work/c":null}')).toEqual({ '/work/a': 200 });
  expect(parseHiddenFolders(null)).toEqual({});
  expect(parseHiddenFolders('')).toEqual({});
  expect(parseHiddenFolders('{壊れた')).toEqual({});
  expect(parseHiddenFolders('["/work/a"]')).toEqual({});
  expect(parseHiddenFolders('"text"')).toEqual({});
});
