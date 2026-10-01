import { expect, it } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { inLockedOrder } from '@shared/session-order';

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
  remoteControl: false,
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
