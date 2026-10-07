import type { Card, Checklist } from '@shared/checklist';
import type { SessionSummary } from '@shared/ipc';

// チェックリストの画面のテスト（press-checklist*.test.tsx）で使う、作り物のセッション・リスト・カード

export const NOW = Date.now();

export function card(id: string, number: number, title: string, over: Partial<Card> = {}): Card {
  return {
    id,
    number,
    title,
    body: '',
    checked: false,
    createdBy: 'human',
    createdAt: NOW,
    updatedAt: NOW,
    thread: [],
    readByHuman: NOW,
    readByClaude: NOW,
    ...over,
  };
}

export function list(id: string, name: string, cards: Card[], over: Partial<Checklist> = {}): Checklist {
  return { id, name, description: '', nextNumber: cards.length + 1, cards, createdBy: 'human', createdAt: NOW, ...over };
}

export function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: `セッション ${id}`,
    cwd: '/work/shop',
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    running: true,
    unread: false,
    attention: null,
    backgroundTasks: 0,
    model: null,
    effort: null,
    settingsFile: null,
    remoteControl: false,
    worktree: null,
    parentId: null,
    ...over,
  };
}

// ドラッグの dataTransfer の代わり（jsdom には無い）。dragstart で入れた型を、dragover・drop で読めるようにする
export function dataTransfer() {
  const types: string[] = [];
  return {
    types,
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: (type: string) => {
      if (!types.includes(type)) types.push(type);
    },
    getData: () => '',
  };
}

// 解決を外から決められる Promise（送っている途中の状態を確かめる）
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
