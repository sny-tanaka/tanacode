import { expect, it } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { inLockedOrder, sessionTree } from '@shared/session-order';

// セッション一覧の並びのロック

const session = (id: string): SessionSummary => ({
  id,
  title: id,
  cwd: '/work',
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: false,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
});

const ids = (sessions: SessionSummary[]) => sessions.map((s) => s.id);

it('ロックした時点の並びのまま、受け取る並びが入れ替わっても動かさない', () => {
  // c が更新されて、受け取る並びでは先頭に来た
  const received = ['c', 'a', 'b'].map(session);
  expect(ids(inLockedOrder(received, ['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
});

it('ロックしたあとにできたセッションは、先頭に置く', () => {
  const received = ['n2', 'n1', 'b', 'a'].map(session);
  expect(ids(inLockedOrder(received, ['a', 'b']))).toEqual(['n2', 'n1', 'a', 'b']);
});

it('消えたセッションは出さない', () => {
  const received = ['b', 'a'].map(session);
  expect(ids(inLockedOrder(received, ['a', 'gone', 'b']))).toEqual(['a', 'b']);
});

it('並びが空なら、受け取った並びのまま', () => {
  const received = ['b', 'a'].map(session);
  expect(ids(inLockedOrder(received, []))).toEqual(['b', 'a']);
});

// 親子のセッションの並び（子を親の下にぶら下げる）

const child = (id: string, parentId: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({ ...session(id), parentId, ...patch });
const rows = (list: SessionSummary[], all = list, collapsed: string[] = []) =>
  sessionTree(list, all, new Set(collapsed)).map((r) => `${'  '.repeat(r.depth)}${r.session.id}${r.depth === 0 && r.parent ? `<${r.parent.id}` : ''}`);

it('子は親の直後に、受け取った並びのまま出す。親子のない行と親の行の並びは変えない', () => {
  // c1 は親より新しく更新されて先頭に来ていても、親の下に出す
  const received = [child('c1', 'p'), session('a'), session('p'), child('c2', 'p'), session('b')];
  expect(rows(received)).toEqual(['a', 'p', '  c1', '  c2', 'b']);
});

it('畳んだ親の子は出さない', () => {
  const received = [session('p'), child('c1', 'p'), child('c2', 'p'), session('a')];
  expect(rows(received, received, ['p'])).toEqual(['p', 'a']);
  expect(sessionTree(received, received, new Set(['p']))[0].children.map((s) => s.id)).toEqual(['c1', 'c2']);
});

it('親が同じ区分にいない子は、いちばん上の段に出して親を添える。親を一覧から削除した子は、親を添えない', () => {
  const all = [child('c1', 'p'), child('c2', 'gone'), session('a'), { ...session('p'), archived: true }];
  const active = all.filter((s) => !s.archived);
  expect(rows(active, all)).toEqual(['c1<p', 'c2', 'a']);
});

it('孫や、親子が輪になったものは、いちばん上の段に出す（親子は 1 段まで）', () => {
  const received = [session('p'), child('c', 'p'), child('g', 'c'), child('x', 'y'), child('y', 'x')];
  expect(rows(received)).toEqual(['p', '  c', 'g<c', 'x<y', 'y<x']);
});

it('ロックした並びでも、子は親の直後に出す', () => {
  const received = [child('c1', 'p'), session('a'), session('p')];
  expect(rows(inLockedOrder(received, ['p', 'a', 'c1']))).toEqual(['p', '  c1', 'a']);
});
