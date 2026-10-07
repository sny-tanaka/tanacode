// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Menu, MenuOption } from '@shared/screen';
import { ChatInput } from '../../src/renderer/src/chat/ChatInput';
import { SchedulePicker } from '../../src/renderer/src/chat/SchedulePicker';
import { CommentList } from '../../src/renderer/src/review/CommentList';
import type { ReviewComment } from '../../src/renderer/src/review/comments';
import { MenuCard } from '../../src/renderer/src/screen/MenuCard';
import './dom';
import { mockApi } from './mock-api';

// チャットの入力欄のまわり（ドラッグ・コードへのコメントの札・時刻を指定して送信）と、コメントの一覧・選択メニューの自由記述のボタンを押して、
// 押した先に効くかを確かめる

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi();
  api.install();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const comment = (id: string, path: string, startLine: number, endLine: number, text: string): ReviewComment => ({ id, path, startLine, endLine, quote: '', text });
const COMMENTS = [comment('c1', 'src/tax.ts', 3, 3, '設定から読む'), comment('c2', 'src/cart.ts', 10, 12, '名前を変える')];

type InputProps = ComponentProps<typeof ChatInput>;
function inputProps(over: Partial<InputProps> = {}): InputProps {
  return {
    completion: { key: 'k', listFiles: () => Promise.resolve([]), listCommands: () => Promise.resolve([]) },
    value: '',
    onChange: () => {},
    attachments: [],
    onAttachmentsChange: () => {},
    placeholder: '指示を入力',
    blocked: false,
    onSend: () => {},
    showInterrupt: false,
    onInterrupt: () => {},
    comments: [],
    onRemoveComment: () => {},
    onShowComment: () => {},
    ...over,
  };
}

describe('入力欄（ChatInput）', () => {
  it('ファイルを重ねると枠を強調し、離れたら戻す。ファイルでないもの（文字など）を重ねても強調しない', () => {
    const { container } = render(<ChatInput {...inputProps()} />);
    const box = container.querySelector('.chat-input')!;
    const over = createDragOver(box, ['text/plain']);
    expect(over.defaultPrevented).toBe(false);
    expect(box.classList.contains('dragging')).toBe(false);
    // ファイルなら既定の動き（ファイルを開く）を止めて、落とせるようにする
    expect(createDragOver(box, ['Files']).defaultPrevented).toBe(true);
    expect(box.classList.contains('dragging')).toBe(true);
    fireEvent.dragLeave(box);
    expect(box.classList.contains('dragging')).toBe(false);
  });

  it('コードへのコメントの札を押すとそのコメントを見せ、札の「外す」を押すとそのコメントだけを外す（見せはしない）', () => {
    const onShowComment = vi.fn();
    const onRemoveComment = vi.fn();
    const { container } = render(<ChatInput {...inputProps({ comments: COMMENTS, onShowComment, onRemoveComment })} />);
    const chips = [...container.querySelectorAll<HTMLElement>('.comment-chip')];
    expect(chips.map((c) => c.querySelector('.comment-chip-where')!.textContent)).toEqual(['tax.ts:3', 'cart.ts:10-12']);
    fireEvent.click(chips[1]);
    expect(onShowComment).toHaveBeenCalledWith(COMMENTS[1]);
    fireEvent.click(within(chips[0]).getByRole('button', { name: '外す' }));
    expect(onRemoveComment).toHaveBeenCalledWith('c1');
    expect(onShowComment).toHaveBeenCalledTimes(1);
  });
});

// dataTransfer.types を持つ dragover を送って、そのイベントを返す
function createDragOver(target: Element, types: string[]): Event {
  const event = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types, files: [] } });
  fireEvent(target, event);
  return event;
}

describe('時刻を指定して送信（SchedulePicker）', () => {
  // 2026-10-07（水）10:20（その Mac の時刻）
  const NOW = new Date(2026, 9, 7, 10, 20);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  const menu = () => screen.queryByRole('dialog', { name: '時刻を指定して送信' });
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

  it('ボタンで時刻のメニューを開き（もう一度押すと閉じる）、すぐ選べる時刻を押すとその時刻を渡して閉じる', () => {
    const onPick = vi.fn();
    render(<SchedulePicker label="時刻を指定して送信" onPick={onPick} />);
    const button = screen.getByRole('button', { name: '時刻を指定して送信' });
    fireEvent.click(button);
    expect(menu()).not.toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // 日時の欄の初めは、次のちょうどの時刻
    expect([field('日付').value, field('時刻').value]).toEqual(['2026-10-07', '11:00']);
    fireEvent.click(button);
    expect(menu()).toBeNull();
    fireEvent.click(button);
    fireEvent.click(screen.getByText('明日の朝'));
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 9, 8, 9, 0).getTime());
    expect(menu()).toBeNull();
    fireEvent.click(button);
    fireEvent.click(screen.getByText('30 分後'));
    expect(onPick).toHaveBeenLastCalledWith(NOW.getTime() + 30 * 60_000);
  });

  it('日付と時刻を打って「予約」を押すと、その時刻を渡す。過ぎた時刻では押せず、わけを出す', () => {
    const onPick = vi.fn();
    render(<SchedulePicker label="時刻を指定して送信" onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: '時刻を指定して送信' }));
    const reserve = () => screen.getByRole('button', { name: '予約' }) as HTMLButtonElement;
    fireEvent.change(field('時刻'), { target: { value: '09:00' } });
    expect(field('時刻').value).toBe('09:00');
    expect(reserve().disabled).toBe(true);
    expect(screen.getByText('これから先の時刻を指定してください')).toBeTruthy();
    fireEvent.change(field('日付'), { target: { value: '2026-10-09' } });
    expect(field('日付').value).toBe('2026-10-09');
    expect(reserve().disabled).toBe(false);
    expect(screen.queryByText('これから先の時刻を指定してください')).toBeNull();
    fireEvent.change(field('時刻'), { target: { value: '18:30' } });
    fireEvent.click(reserve());
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 9, 9, 18, 30).getTime());
    expect(menu()).toBeNull();
  });

  it('時刻を変えるときは、今の予約の時刻を欄に入れて開く', () => {
    render(<SchedulePicker label="時刻を変える" initial={new Date(2026, 9, 12, 15, 45).getTime()} onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '時刻を変える' }));
    expect([field('日付').value, field('時刻').value]).toEqual(['2026-10-12', '15:45']);
  });
});

describe('コードへのコメントの一覧（CommentList）', () => {
  it('コメントを押すとその場所を見せ、「削除」を押すとそのコメントだけを消す（見せはしない）', () => {
    const onShow = vi.fn();
    const onRemove = vi.fn();
    const { container } = render(<CommentList comments={COMMENTS} onShow={onShow} onRemove={onRemove} />);
    const rows = [...container.querySelectorAll<HTMLElement>('.review-comment')];
    expect(rows.map((r) => r.querySelector('.review-comment-where')!.textContent)).toEqual(['src/tax.ts:3', 'src/cart.ts:10-12']);
    fireEvent.click(rows[0]);
    expect(onShow).toHaveBeenCalledWith(COMMENTS[0]);
    fireEvent.click(within(rows[1]).getByRole('button', { name: '削除' }));
    expect(onRemove).toHaveBeenCalledWith('c2');
    expect(onShow).toHaveBeenCalledTimes(1);
  });
});

describe('選択メニューの自由記述（MenuCard）', () => {
  const option = (id: string, label: string, over: Partial<MenuOption> = {}): MenuOption => ({ id, label, description: '', pointed: false, checked: null, textInput: false, ...over });
  const menu: Menu = { kind: 'question', tabs: [], title: 'どれにしますか？', context: [], options: [option('1', 'はい'), option('2', 'Type something.', { textInput: true })], multiSelect: false, hint: '' };

  it('「やめる」を押すと、打ちかけた答えを送らずに入力欄を閉じる。開き直した欄は空', () => {
    render(<MenuCard sessionId="s1" menu={menu} />);
    fireEvent.click(screen.getByText('その他（自由に入力）'));
    fireEvent.change(screen.getByPlaceholderText('回答を入力'), { target: { value: '別の案' } });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByPlaceholderText('回答を入力')).toBeNull();
    expect(api.argsOf('screen.choose')).toEqual([]);
    expect(api.argsOf('pty.write')).toEqual([]);
    fireEvent.click(screen.getByText('その他（自由に入力）'));
    expect((screen.getByPlaceholderText('回答を入力') as HTMLInputElement).value).toBe('');
  });
});
