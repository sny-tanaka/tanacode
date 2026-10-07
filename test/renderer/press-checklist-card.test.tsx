// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Checklist } from '@shared/checklist';
import type { SessionSummary } from '@shared/ipc';
import { CardPane } from '../../src/renderer/src/checklist/CardPane';
import './dom';
import { mockApi } from './mock-api';
import { card, deferred, list, NOW, session } from './press-checklist-fixtures';

// チェックリストのカードの詳細（エディタの場所）。チェック・コピー・ゴミ箱・タイトルと説明文の編集・スレッドへの返信と
// 「Claude に通知する」。どのボタンも、いま開いているセッション・リスト・カードを書き換える（checklist.apply）ことを確かめる。
// カード・セッションを替えた直後に押しても、替えた先に効くことも確かめる

let api: ReturnType<typeof mockApi>;
let alertSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  api = mockApi();
  api.install();
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOTIFY_KEY = 'tanacode.checklist.notify';
const S1 = session('s1');
const S2 = session('s2', { title: '同じフォルダ' });
const SESSIONS: SessionSummary[] = [S1, S2];

const first = () => card('c1', 1, '税率を読む', { body: '設定ファイルの `tax` を読む' });
const second = () => card('c2', 2, '表示を差し替える', { checked: true, checkedBy: 'claude', checkedAt: NOW });
const todo = (...cards: Card[]) => list('L1', 'やること', cards.length > 0 ? cards : [first(), second()]);

function show(over: { session?: SessionSummary; list?: Checklist; card?: Card } = {}) {
  const onClose = vi.fn();
  const l = over.list ?? todo();
  const props = { session: over.session ?? S1, sessions: SESSIONS, list: l, card: over.card ?? l.cards[0], onClose };
  const view = render(<CardPane {...props} />);
  return { ...view, onClose, props };
}

const applied = () => api.argsOf('checklist.apply');
const settle = () => act(() => Promise.resolve());
const titleText = () => document.querySelector('h2.card-pane-title') as HTMLElement;
const titleInput = () => document.querySelector('textarea.card-pane-title-input') as HTMLTextAreaElement;
const reply = () => screen.getByPlaceholderText('返信（Markdown。⌘Enter で送る）') as HTMLTextAreaElement;
const sendButton = () => screen.getByLabelText('返信する') as HTMLButtonElement;
const notifyBox = () => within(document.querySelector('.card-composer') as HTMLElement).getByRole('checkbox') as HTMLInputElement;

describe('見出しのボタン', () => {
  it('チェック欄は、このカードのチェックを付け外しする', () => {
    const { rerender, props } = show();
    fireEvent.click(screen.getByRole('checkbox', { name: 'チェックする' }));
    rerender(<CardPane {...props} card={second()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'チェックを外す（Claudeがチェック）' }));
    expect(applied()).toEqual([
      ['s1', { type: 'card-check', listId: 'L1', cardIds: ['c1'], checked: true }],
      ['s1', { type: 'card-check', listId: 'L1', cardIds: ['c2'], checked: false }],
    ]);
  });

  it('「別のセッションへコピー」で、このカードだけをコピーするダイアログを出し、閉じられる', async () => {
    show();
    fireEvent.click(screen.getByLabelText('別のセッションへコピー'));
    const dialog = screen.getByRole('dialog', { name: '別のセッションへコピー' });
    expect(dialog.textContent).toContain('「やること」の #1 を');
    fireEvent.click(within(dialog).getByText('コピー'));
    expect(api.argsOf('checklist.copy')).toEqual([[{ fromSession: 's1', listId: 'L1', cardIds: ['c1'], toSession: 's2', toList: 'やること', notify: true }]]);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('「ゴミ箱に入れる」で、このカードをゴミ箱に入れてから詳細を閉じる。入れられなければ閉じない', async () => {
    const { onClose } = show();
    fireEvent.click(screen.getByLabelText('ゴミ箱に入れる'));
    expect(applied()).toEqual([['s1', { type: 'card-delete', listId: 'L1', cardIds: ['c1'] }]]);
    expect(onClose).not.toHaveBeenCalled();
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();
    api = mockApi({ 'checklist.apply': () => Promise.reject(new Error('書き込めません')) });
    api.install();
    const failed = show();
    fireEvent.click(screen.getByLabelText('ゴミ箱に入れる'));
    await settle();
    expect(alertSpy).toHaveBeenCalledWith('チェックリストを変えられませんでした: 書き込めません');
    expect(failed.onClose).not.toHaveBeenCalled();
  });

  it('「閉じる」で詳細を閉じる', () => {
    const { onClose } = show();
    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('タイトルの編集', () => {
  it('ダブルクリックで今のタイトルの入力欄を出す。貼り付けた改行は空白にし、Enter で確定して書き換える', () => {
    show();
    fireEvent.doubleClick(titleText());
    expect(titleInput().value).toBe('税率を読む');
    expect(document.activeElement).toBe(titleInput());
    fireEvent.change(titleInput(), { target: { value: '税率を\n  設定から読む ' } });
    expect(titleInput().value).toBe('税率を 設定から読む ');
    fireEvent.keyDown(titleInput(), { key: 'Enter', isComposing: true });
    expect(titleInput()).toBeTruthy();
    fireEvent.keyDown(titleInput(), { key: 'Enter' });
    expect(applied()).toEqual([['s1', { type: 'card-update', listId: 'L1', cardId: 'c1', title: '税率を 設定から読む' }]]);
    expect(titleInput()).toBeNull();
    expect(titleText()).toBeTruthy();
  });

  it('入力欄から離れても確定する。変えていない・空にしたときは書き換えない', () => {
    show();
    fireEvent.doubleClick(titleText());
    fireEvent.change(titleInput(), { target: { value: '離れて確定' } });
    fireEvent.blur(titleInput());
    fireEvent.doubleClick(titleText());
    fireEvent.blur(titleInput());
    fireEvent.doubleClick(titleText());
    fireEvent.change(titleInput(), { target: { value: '   ' } });
    fireEvent.blur(titleInput());
    expect(applied()).toEqual([['s1', { type: 'card-update', listId: 'L1', cardId: 'c1', title: '離れて確定' }]]);
  });

  it('Esc で、書き換えずに編集をやめる', () => {
    show();
    fireEvent.doubleClick(titleText());
    fireEvent.change(titleInput(), { target: { value: 'やめる' } });
    fireEvent.keyDown(titleInput(), { key: 'Escape' });
    expect(titleInput()).toBeNull();
    expect(titleText().textContent).toBe('税率を読む');
    expect(applied()).toEqual([]);
  });
});

describe('説明文の編集', () => {
  const bodyBox = () => screen.getByPlaceholderText('説明文（Markdown）') as HTMLTextAreaElement;

  it('「説明文を編集」で今の説明文を出し、「保存」で書き換える', () => {
    show();
    fireEvent.click(screen.getByText('説明文を編集'));
    expect(bodyBox().value).toBe('設定ファイルの `tax` を読む');
    fireEvent.change(bodyBox(), { target: { value: '環境変数より設定ファイルを優先する' } });
    fireEvent.click(screen.getByText('保存（⌘Enter）'));
    expect(applied()).toEqual([['s1', { type: 'card-update', listId: 'L1', cardId: 'c1', body: '環境変数より設定ファイルを優先する' }]]);
    expect(screen.queryByPlaceholderText('説明文（Markdown）')).toBeNull();
  });

  it('説明文が無ければ「説明文を書く」と出し、⌘Enter で保存する。変換の確定の Enter・ただの Enter では保存しない', () => {
    show({ card: second() });
    expect(screen.getByText('説明文はありません')).toBeTruthy();
    fireEvent.click(screen.getByText('説明文を書く'));
    expect(bodyBox().value).toBe('');
    fireEvent.change(bodyBox(), { target: { value: '画面の表示を 1 か所に' } });
    fireEvent.keyDown(bodyBox(), { key: 'Enter' });
    fireEvent.keyDown(bodyBox(), { key: 'Enter', metaKey: true, isComposing: true });
    expect(applied()).toEqual([]);
    fireEvent.keyDown(bodyBox(), { key: 'Enter', metaKey: true });
    expect(applied()).toEqual([['s1', { type: 'card-update', listId: 'L1', cardId: 'c2', body: '画面の表示を 1 か所に' }]]);
    expect(screen.queryByPlaceholderText('説明文（Markdown）')).toBeNull();
  });

  it('「キャンセル」と Esc で、書き換えずに編集をやめる', () => {
    show();
    fireEvent.click(screen.getByText('説明文を編集'));
    fireEvent.change(bodyBox(), { target: { value: '捨てる' } });
    fireEvent.click(screen.getByText('キャンセル'));
    expect(screen.queryByPlaceholderText('説明文（Markdown）')).toBeNull();
    fireEvent.click(screen.getByText('説明文を編集'));
    fireEvent.change(bodyBox(), { target: { value: '捨てる' } });
    fireEvent.keyDown(bodyBox(), { key: 'Escape' });
    expect(screen.queryByPlaceholderText('説明文（Markdown）')).toBeNull();
    expect(applied()).toEqual([]);
  });
});

describe('スレッドへの返信', () => {
  it('打った返信を「返信する」で送り、送れたら返信欄を空にする。空白だけでは押せない', async () => {
    show();
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(reply(), { target: { value: '  ' } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(reply(), { target: { value: ' ボタンの文言も見てください ' } });
    fireEvent.click(sendButton());
    expect(applied()).toEqual([['s1', { type: 'card-reply', listId: 'L1', cardId: 'c1', text: 'ボタンの文言も見てください', notify: true }]]);
    await settle();
    expect(reply().value).toBe('');
  });

  it('⌘Enter でも送る。ただの Enter・変換の確定の Enter では送らない', async () => {
    show();
    fireEvent.change(reply(), { target: { value: '確かめました' } });
    fireEvent.keyDown(reply(), { key: 'Enter' });
    fireEvent.keyDown(reply(), { key: 'Enter', metaKey: true, isComposing: true });
    expect(applied()).toEqual([]);
    fireEvent.keyDown(reply(), { key: 'Enter', metaKey: true });
    expect(applied()).toEqual([['s1', { type: 'card-reply', listId: 'L1', cardId: 'c1', text: '確かめました', notify: true }]]);
    await settle();
  });

  it('送っている間は押せず、二重に送らない。送れなかったら理由を出し、打った返信は残す', async () => {
    const sending = deferred();
    api = mockApi({ 'checklist.apply': () => sending.promise });
    api.install();
    show();
    fireEvent.change(reply(), { target: { value: '一度だけ' } });
    fireEvent.click(sendButton());
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(reply(), { key: 'Enter', metaKey: true });
    expect(applied()).toHaveLength(1);
    await act(async () => sending.reject(new Error('書き込めません')));
    expect(alertSpy).toHaveBeenCalledWith('チェックリストを変えられませんでした: 書き込めません');
    expect(reply().value).toBe('一度だけ');
    expect(sendButton().disabled).toBe(false);
  });

  it('「Claude に通知する」を外すと、知らせずに返信する。選んだものは覚えていて、次に開いたときもそのまま', async () => {
    show();
    expect(notifyBox().checked).toBe(true);
    fireEvent.click(notifyBox());
    expect(notifyBox().checked).toBe(false);
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('0');
    fireEvent.change(reply(), { target: { value: '知らせない' } });
    fireEvent.click(sendButton());
    expect(applied()).toEqual([['s1', { type: 'card-reply', listId: 'L1', cardId: 'c1', text: '知らせない', notify: false }]]);
    await settle();

    cleanup();
    show();
    expect(notifyBox().checked).toBe(false);
    fireEvent.click(notifyBox());
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('1');
    expect(notifyBox().checked).toBe(true);
  });

  it('Claude の未読の返信があるカードを開くと、読んだことにする', () => {
    const unread = card('c3', 3, '未読あり', { thread: [{ id: 'r1', at: NOW + 1000, author: 'claude', kind: 'reply', text: '終わりました' }] });
    show({ list: todo(first(), unread), card: unread });
    expect(applied()).toEqual([['s1', { type: 'card-read', listId: 'L1', cardId: 'c3' }]]);
  });
});

describe('カード・セッションを替えた直後', () => {
  it('カードを替えると、打ちかけの返信・タイトル・説明文を捨て、返信は替えた先のカードへ送る', async () => {
    const { rerender, props } = show();
    fireEvent.change(reply(), { target: { value: '前のカードへの返信' } });
    fireEvent.doubleClick(titleText());
    fireEvent.change(titleInput(), { target: { value: '前のカードのタイトル' } });
    rerender(<CardPane {...props} card={second()} />);
    expect(reply().value).toBe('');
    expect(titleInput()).toBeNull();
    expect(titleText().textContent).toBe('表示を差し替える');
    expect(applied()).toEqual([]);

    fireEvent.change(reply(), { target: { value: '替えた先への返信' } });
    fireEvent.click(sendButton());
    expect(applied()).toEqual([['s1', { type: 'card-reply', listId: 'L1', cardId: 'c2', text: '替えた先への返信', notify: true }]]);
    await settle();
  });

  it('カードを替えた直後のチェック・タイトル・説明文・ゴミ箱・コピーも、替えた先のカードに効く', async () => {
    const { rerender, props, onClose } = show();
    fireEvent.click(screen.getByText('説明文を編集'));
    rerender(<CardPane {...props} card={second()} />);
    expect(screen.queryByPlaceholderText('説明文（Markdown）')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /^チェックを外す/ }));
    fireEvent.doubleClick(titleText());
    expect(titleInput().value).toBe('表示を差し替える');
    fireEvent.change(titleInput(), { target: { value: '表示を 1 か所に' } });
    fireEvent.keyDown(titleInput(), { key: 'Enter' });
    fireEvent.click(screen.getByText('説明文を書く'));
    fireEvent.change(screen.getByPlaceholderText('説明文（Markdown）'), { target: { value: '本文' } });
    fireEvent.click(screen.getByText('保存（⌘Enter）'));
    fireEvent.click(screen.getByLabelText('ゴミ箱に入れる'));
    expect(applied()).toEqual([
      ['s1', { type: 'card-check', listId: 'L1', cardIds: ['c2'], checked: false }],
      ['s1', { type: 'card-update', listId: 'L1', cardId: 'c2', title: '表示を 1 か所に' }],
      ['s1', { type: 'card-update', listId: 'L1', cardId: 'c2', body: '本文' }],
      ['s1', { type: 'card-delete', listId: 'L1', cardIds: ['c2'] }],
    ]);
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('別のセッションへコピー'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('コピー'));
    expect(api.argsOf('checklist.copy')).toEqual([[{ fromSession: 's1', listId: 'L1', cardIds: ['c2'], toSession: 's2', toList: 'やること', notify: true }]]);
    await settle();
  });

  it('別のリストへ移ったカード（詳細は追いかける）では、移った先のリストを書き換える', async () => {
    const { rerender, props } = show();
    const moved = list('L2', '完了前チェック', [card('c1', 5, '税率を読む')]);
    rerender(<CardPane {...props} list={moved} card={moved.cards[0]} />);
    expect(screen.getByText('完了前チェック #5')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'チェックする' }));
    fireEvent.change(reply(), { target: { value: '移った先で' } });
    fireEvent.click(sendButton());
    expect(applied()).toEqual([
      ['s1', { type: 'card-check', listId: 'L2', cardIds: ['c1'], checked: true }],
      ['s1', { type: 'card-reply', listId: 'L2', cardId: 'c1', text: '移った先で', notify: true }],
    ]);
    await settle();
  });

  it('セッションを替えた直後のボタンは、替えた先のセッションのカードを書き換え、そのセッションからコピーする', async () => {
    const { rerender, props } = show();
    const other = list('M1', '別のやること', [card('d1', 1, '別のカード')]);
    rerender(<CardPane {...props} session={S2} list={other} card={other.cards[0]} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'チェックする' }));
    fireEvent.change(reply(), { target: { value: '別のセッションへ' } });
    fireEvent.keyDown(reply(), { key: 'Enter', metaKey: true });
    expect(applied()).toEqual([
      ['s2', { type: 'card-check', listId: 'M1', cardIds: ['d1'], checked: true }],
      ['s2', { type: 'card-reply', listId: 'M1', cardId: 'd1', text: '別のセッションへ', notify: true }],
    ]);
    await settle();
    fireEvent.click(screen.getByLabelText('別のセッションへコピー'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('コピー'));
    expect(api.argsOf('checklist.copy')).toEqual([[{ fromSession: 's2', listId: 'M1', cardIds: ['d1'], toSession: 's1', toList: '別のやること', notify: true }]]);
    await settle();
  });
});
