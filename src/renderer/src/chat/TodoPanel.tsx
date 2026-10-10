import { useRef, useState } from 'react';
import type { TodoItem } from '@shared/chat';
import { t } from '@shared/i18n';
import { DisclosureIcon } from '../icons';
import { CheckMark } from '../layout/CheckMark';

const MARK: Record<string, string> = { pending: '○' };
// チェックを描き終えるまでの時間（CSS の check-draw より少し長く）
const DRAW_MS = 1000;

// Claude の Todo リスト（最後の TodoWrite）。チャットの上に固定して、進み具合を出す
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  // 終わったばかりの項目は、チェックを描いて見せる（最初に開いたときに終わっていたものは描かない）。
  // 描いている途中で描き直されても止まらないよう、描き終わるまでの時刻を覚えておく
  const completedBefore = useRef<Set<string> | null>(null);
  const drawingUntil = useRef(new Map<string, number>());
  const now = Date.now();
  for (const t of todos) {
    if (t.status === 'completed' && completedBefore.current && !completedBefore.current.has(t.content)) drawingUntil.current.set(t.content, now + DRAW_MS);
  }
  completedBefore.current = new Set(todos.filter((t) => t.status === 'completed').map((t) => t.content));
  const drawing = (content: string) => (drawingUntil.current.get(content) ?? 0) > now;
  return (
    <div className="todo-panel">
      <button className="todo-head" onClick={() => setOpen((v) => !v)}>
        <DisclosureIcon open={open} />
        <span className="todo-title">{t('chat.todo.title')}</span>
        <span className="todo-count">
          {done}/{todos.length}
        </span>
        {!open && current && <span className="todo-current">{current.activeForm ?? current.content}</span>}
      </button>
      {open && <TodoList todos={todos} drawing={drawing} />}
    </div>
  );
}

// 項目の一覧。drawing: チェックを描いて見せる項目。作業の書き出しでも使う（描かない）
export function TodoList({ todos, drawing = () => false }: { todos: TodoItem[]; drawing?: (content: string) => boolean }) {
  return (
    <ul className="todo-list">
      {todos.map((todo, i) => (
        <li key={i} className={`todo-item ${todo.status}`}>
          <span className="todo-mark">
            {todo.status === 'completed' ? (
              <CheckMark animate={drawing(todo.content)} />
            ) : todo.status === 'in_progress' ? (
              <span className="spinner" />
            ) : (
              (MARK[todo.status] ?? '○')
            )}
          </span>
          <span className="todo-text">{todo.status === 'in_progress' ? (todo.activeForm ?? todo.content) : todo.content}</span>
        </li>
      ))}
    </ul>
  );
}
