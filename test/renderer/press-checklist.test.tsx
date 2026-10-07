// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Checklist } from '@shared/checklist';
import type { SessionSummary } from '@shared/ipc';
import { ChecklistPanel } from '../../src/renderer/src/checklist/ChecklistPanel';
import './dom';
import { mockApi } from './mock-api';
import { card, dataTransfer, deferred, list, NOW, session } from './press-checklist-fixtures';

// チェックリストのサイドパネル。リストを作る・名前を変える・ゴミ箱に入れる、カードを足す・開く・選ぶ・チェックする・
// ドラッグで並べ替える・別のリストへ移す・別のセッションへコピーする、ゴミ箱から戻す・空にする。
// どのボタンも、押したら今のセッションのチェックリストを、正しいリスト・カードで書き換える（checklist.apply）ことを確かめる

let api: ReturnType<typeof mockApi>;
let confirmSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  api = mockApi();
  api.install();
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const S1 = session('s1');
// コピー先に選べる: 同じフォルダの s2・子セッション（別のフォルダ）の s5。選べない: アーカイブした s3・別のフォルダの s4
const SESSIONS: SessionSummary[] = [
  S1,
  session('s2', { title: '同じフォルダ' }),
  session('s3', { title: 'アーカイブ済み', archived: true }),
  session('s4', { title: '別のフォルダ', cwd: '/work/other' }),
  session('s5', { title: '子セッション', cwd: '/work/child', parentId: 's1' }),
];

const todo = () =>
  list(
    'L1',
    'やること',
    [
      card('c1', 1, '税率を読む'),
      card('c2', 2, '計算をまとめる', { checked: true, checkedBy: 'claude' }),
      card('c3', 3, '表示を差し替える'),
      card('c4', 4, '消したカード', { deletedAt: NOW }),
    ],
    { description: '上から順に進める' },
  );
const goal = () => list('L2', '完了前チェック', [card('g1', 1, 'テストが通る')]);
const trashed = () => list('L3', '捨てたリスト', [card('t1', 1, '中のカード')], { deletedAt: NOW });
const LISTS = () => [todo(), goal(), trashed()];

function show(over: { session?: SessionSummary; lists?: Checklist[]; activeCardId?: string | null; onOpen?: (listId: string, cardId: string) => void } = {}) {
  const onOpen = over.onOpen ?? vi.fn();
  const props = { session: over.session ?? S1, lists: over.lists ?? LISTS(), sessions: SESSIONS, activeCardId: over.activeCardId ?? null, onOpen };
  const view = render(<ChecklistPanel {...props} />);
  return { ...view, onOpen, props };
}

const head = (name: string) => screen.getByText(name, { selector: '.checklist-list-name' }).closest('.checklist-list-head') as HTMLElement;
const cardRow = (title: string) => screen.getByText(title, { selector: '.checklist-title' }).closest('.checklist-card') as HTMLElement;
const applied = () => api.argsOf('checklist.apply');
// checklist.apply の Promise の続き（then）まで進める
const settle = () => act(() => Promise.resolve());

describe('リストを作る・名前と説明を変える（ListForm）', () => {
  it('「リストを作る」で名前と説明を打って「作る」と、前後の空白を除いてリストを作り、フォームを閉じる', async () => {
    show();
    fireEvent.click(screen.getByText('リストを作る'));
    const form = document.querySelector('.checklist-form') as HTMLFormElement;
    const name = within(form).getByPlaceholderText(/^名前/) as HTMLInputElement;
    const submit = within(form).getByText('作る') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: '  確認事項 ' } });
    fireEvent.change(within(form).getByPlaceholderText(/^使い方のルール/), { target: { value: ' 終える前に確かめる ' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(applied()).toEqual([['s1', { type: 'list-create', name: '確認事項', description: '終える前に確かめる' }]]);
    await settle();
    expect(document.querySelector('.checklist-form')).toBeNull();
  });

  it('作れなかったら理由を出し、フォームは残す（打った名前を打ち直さなくてよい）', async () => {
    api = mockApi({ 'checklist.apply': () => Promise.reject(new Error("Error invoking remote method 'checklist:apply': Error: 同じ名前のリストがあります")) });
    api.install();
    show();
    fireEvent.click(screen.getByText('リストを作る'));
    fireEvent.change(screen.getByPlaceholderText(/^名前/), { target: { value: 'やること' } });
    fireEvent.click(screen.getByText('作る'));
    await settle();
    expect(alertSpy).toHaveBeenCalledWith('チェックリストを変えられませんでした: 同じ名前のリストがあります');
    expect((screen.getByPlaceholderText(/^名前/) as HTMLInputElement).value).toBe('やること');
  });

  it('フォームの中で ⌘Enter でも作れる。変換の確定の Enter と、名前が空のときは作らない', () => {
    show();
    fireEvent.click(screen.getByText('リストを作る'));
    const name = screen.getByPlaceholderText(/^名前/);
    fireEvent.keyDown(name, { key: 'Enter', metaKey: true });
    expect(applied()).toEqual([]);
    fireEvent.change(name, { target: { value: '確認事項' } });
    fireEvent.keyDown(name, { key: 'Enter', metaKey: true, isComposing: true });
    expect(applied()).toEqual([]);
    fireEvent.keyDown(name, { key: 'Enter', metaKey: true });
    expect(applied()).toEqual([['s1', { type: 'list-create', name: '確認事項', description: '' }]]);
  });

  it('Esc と「キャンセル」で、作らずにフォームを閉じる', () => {
    show();
    fireEvent.click(screen.getByText('リストを作る'));
    fireEvent.change(screen.getByPlaceholderText(/^名前/), { target: { value: '確認事項' } });
    fireEvent.keyDown(screen.getByPlaceholderText(/^名前/), { key: 'Escape' });
    expect(document.querySelector('.checklist-form')).toBeNull();
    fireEvent.click(screen.getByText('リストを作る'));
    fireEvent.click(within(document.querySelector('.checklist-form') as HTMLElement).getByText('キャンセル'));
    expect(document.querySelector('.checklist-form')).toBeNull();
    expect(applied()).toEqual([]);
  });

  it('リストの見出しをダブルクリックすると、今の名前と説明が入ったフォームを出し、「保存」でそのリストを書き換える', async () => {
    show();
    fireEvent.doubleClick(head('やること'));
    const name = screen.getByPlaceholderText(/^名前/) as HTMLInputElement;
    const description = screen.getByPlaceholderText(/^使い方のルール/) as HTMLTextAreaElement;
    expect([name.value, description.value]).toEqual(['やること', '上から順に進める']);
    fireEvent.change(name, { target: { value: 'やることリスト' } });
    fireEvent.change(description, { target: { value: '' } });
    fireEvent.click(screen.getByText('保存'));
    expect(applied()).toEqual([['s1', { type: 'list-update', listId: 'L1', name: 'やることリスト', description: '' }]]);
    await settle();
    expect(document.querySelector('.checklist-form')).toBeNull();
    expect(head('やること')).toBeTruthy();
  });

  it('名前を変えるフォームも ⌘Enter で保存でき、Esc で閉じる（ほかのリストは書き換えない）', () => {
    show();
    fireEvent.doubleClick(head('完了前チェック'));
    fireEvent.keyDown(screen.getByPlaceholderText(/^使い方のルール/), { key: 'Enter', metaKey: true });
    expect(applied()).toEqual([['s1', { type: 'list-update', listId: 'L2', name: '完了前チェック', description: '' }]]);
    fireEvent.keyDown(screen.getByPlaceholderText(/^名前/), { key: 'Escape' });
    expect(document.querySelector('.checklist-form')).toBeNull();
  });

  it('名前を変えられなかったら理由を出し、フォームは残す', async () => {
    api = mockApi({ 'checklist.apply': () => Promise.reject(new Error('書き込めません')) });
    api.install();
    show();
    fireEvent.doubleClick(head('やること'));
    fireEvent.click(screen.getByText('保存'));
    await settle();
    expect(alertSpy).toHaveBeenCalledWith('チェックリストを変えられませんでした: 書き込めません');
    expect(document.querySelector('.checklist-form')).toBeTruthy();
  });
});

describe('リストの見出し', () => {
  it('押すとカードを畳み、もう一度押すと開く（説明も一緒に）', () => {
    show();
    expect(screen.queryByText('税率を読む')).toBeTruthy();
    expect(screen.queryByText('上から順に進める')).toBeTruthy();
    fireEvent.click(head('やること'));
    expect(screen.queryByText('税率を読む')).toBeNull();
    expect(screen.queryByText('上から順に進める')).toBeNull();
    // ほかのリストは畳まない
    expect(screen.queryByText('テストが通る')).toBeTruthy();
    fireEvent.click(head('やること'));
    expect(screen.queryByText('税率を読む')).toBeTruthy();
  });

  it('「リストをゴミ箱に入れる」は、確かめてからそのリストをゴミ箱に入れる。やめたら何もしない。見出しは畳まない', () => {
    show();
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(within(head('完了前チェック')).getByLabelText('リストをゴミ箱に入れる'));
    expect(confirmSpy).toHaveBeenCalledWith('リスト「完了前チェック」をゴミ箱に入れますか？\n（下の「ゴミ箱」から戻せます）');
    expect(applied()).toEqual([]);
    fireEvent.click(within(head('完了前チェック')).getByLabelText('リストをゴミ箱に入れる'));
    expect(applied()).toEqual([['s1', { type: 'list-delete', listId: 'L2' }]]);
    expect(screen.queryByText('テストが通る')).toBeTruthy();
  });
});

describe('カードを足す（NewCardInput）', () => {
  it('畳んだリストでも「カードを足す」で開いて入力欄を出す。Enter で足して、続けて打てる', () => {
    show();
    fireEvent.click(head('完了前チェック'));
    expect(screen.queryByText('テストが通る')).toBeNull();
    fireEvent.click(within(head('完了前チェック')).getByLabelText('カードを足す'));
    expect(screen.queryByText('テストが通る')).toBeTruthy();
    const input = screen.getByPlaceholderText('タイトル（Enter で足す）') as HTMLInputElement;
    expect(input.closest('.checklist-list')?.querySelector('.checklist-list-name')?.textContent).toBe('完了前チェック');
    fireEvent.change(input, { target: { value: ' 型の検査が通る ' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(applied()).toEqual([]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(applied()).toEqual([['s1', { type: 'card-add', listId: 'L2', title: '型の検査が通る' }]]);
    expect(input.value).toBe('');
    // 空のままの Enter では足さない
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(applied()).toHaveLength(1);
  });

  it('入力欄を押しても、パネルの外（window）にクリックを伝えない', () => {
    show();
    fireEvent.click(within(head('やること')).getByLabelText('カードを足す'));
    const outside = vi.fn();
    window.addEventListener('click', outside);
    try {
      fireEvent.click(screen.getByPlaceholderText('タイトル（Enter で足す）'));
      expect(outside).not.toHaveBeenCalled();
      fireEvent.click(cardRow('税率を読む'));
      expect(outside).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('click', outside);
    }
  });

  it('打ちかけで離れると足して閉じる。空のまま離れる・Esc では足さずに閉じる', () => {
    show();
    fireEvent.click(within(head('やること')).getByLabelText('カードを足す'));
    fireEvent.change(screen.getByPlaceholderText('タイトル（Enter で足す）'), { target: { value: '離れる前に打った' } });
    fireEvent.blur(screen.getByPlaceholderText('タイトル（Enter で足す）'));
    expect(applied()).toEqual([['s1', { type: 'card-add', listId: 'L1', title: '離れる前に打った' }]]);
    expect(screen.queryByPlaceholderText('タイトル（Enter で足す）')).toBeNull();

    fireEvent.click(within(head('やること')).getByLabelText('カードを足す'));
    fireEvent.blur(screen.getByPlaceholderText('タイトル（Enter で足す）'));
    expect(screen.queryByPlaceholderText('タイトル（Enter で足す）')).toBeNull();

    fireEvent.click(within(head('やること')).getByLabelText('カードを足す'));
    fireEvent.change(screen.getByPlaceholderText('タイトル（Enter で足す）'), { target: { value: 'やめる' } });
    fireEvent.keyDown(screen.getByPlaceholderText('タイトル（Enter で足す）'), { key: 'Escape' });
    expect(screen.queryByPlaceholderText('タイトル（Enter で足す）')).toBeNull();
    expect(applied()).toHaveLength(1);
  });
});

describe('カードを開く・チェックする・選ぶ', () => {
  it('カードを押すと、そのリストとカードで詳細を開く', () => {
    const { onOpen } = show();
    fireEvent.click(cardRow('表示を差し替える'));
    expect(onOpen).toHaveBeenCalledWith('L1', 'c3');
    fireEvent.click(cardRow('テストが通る'));
    expect(onOpen).toHaveBeenLastCalledWith('L2', 'g1');
  });

  it('チェック欄は、そのカードのチェックを付け外しする（カードは開かない）', () => {
    const { onOpen } = show();
    fireEvent.click(within(cardRow('税率を読む')).getByRole('checkbox'));
    fireEvent.click(within(cardRow('計算をまとめる')).getByRole('checkbox'));
    expect(applied()).toEqual([
      ['s1', { type: 'card-check', listId: 'L1', cardIds: ['c1'], checked: true }],
      ['s1', { type: 'card-check', listId: 'L1', cardIds: ['c2'], checked: false }],
    ]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('⌘クリックで選び足し・外し、⇧クリックで範囲を選ぶ。2 枚以上で選んだ数を出す', () => {
    const { onOpen } = show();
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    expect(cardRow('税率を読む').classList.contains('selected')).toBe(true);
    expect(document.querySelector('.checklist-selection')).toBeNull();
    fireEvent.click(cardRow('表示を差し替える'), { ctrlKey: true });
    expect(screen.getByText('2 枚を選択中')).toBeTruthy();
    fireEvent.click(cardRow('表示を差し替える'), { metaKey: true });
    expect(document.querySelector('.checklist-selection')).toBeNull();
    expect(cardRow('表示を差し替える').classList.contains('selected')).toBe(false);
    // ⇧クリック: 起点（ふつうに押して開いた c1）から、押したカードまでの範囲
    fireEvent.click(cardRow('税率を読む'));
    fireEvent.click(cardRow('表示を差し替える'), { shiftKey: true });
    expect(screen.getByText('3 枚を選択中')).toBeTruthy();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('選択のバーの「別のリストへ移す」で、選んだカードをそのリストへ移し、選ぶのをやめる', async () => {
    show();
    fireEvent.click(cardRow('税率を読む'));
    fireEvent.click(cardRow('表示を差し替える'), { shiftKey: true });
    const move = screen.getByLabelText('別のリストへ移す') as HTMLSelectElement;
    // 移せるのは、ほかの表示中のリストだけ（ゴミ箱のリストは出さない）
    expect([...move.options].map((o) => o.textContent)).toEqual(['移す…', '完了前チェック']);
    fireEvent.change(move, { target: { value: 'L2' } });
    expect(applied()).toEqual([['s1', { type: 'card-move', listId: 'L1', cardIds: ['c1', 'c2', 'c3'], toListId: 'L2' }]]);
    await settle();
    expect(document.querySelector('.checklist-selection')).toBeNull();
  });

  it('選択のバーの「ゴミ箱に入れる」で、選んだカードをまとめてゴミ箱に入れ、選ぶのをやめる', async () => {
    show();
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    fireEvent.click(cardRow('表示を差し替える'), { metaKey: true });
    fireEvent.click(within(document.querySelector('.checklist-selection') as HTMLElement).getByLabelText('ゴミ箱に入れる'));
    expect(applied()).toEqual([['s1', { type: 'card-delete', listId: 'L1', cardIds: ['c1', 'c3'] }]]);
    await settle();
    expect(document.querySelector('.checklist-selection')).toBeNull();
  });

  it('「選ぶのをやめる」で選択を外す（何も書き換えない）', () => {
    show();
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    fireEvent.click(cardRow('計算をまとめる'), { metaKey: true });
    fireEvent.click(screen.getByLabelText('選ぶのをやめる'));
    expect(document.querySelector('.checklist-selection')).toBeNull();
    expect(cardRow('税率を読む').classList.contains('selected')).toBe(false);
    expect(applied()).toEqual([]);
  });

  it('リストが 1 つだけなら、選択のバーに「別のリストへ移す」を出さない', () => {
    show({ lists: [todo()] });
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    fireEvent.click(cardRow('計算をまとめる'), { metaKey: true });
    expect(screen.getByText('2 枚を選択中')).toBeTruthy();
    expect(screen.queryByLabelText('別のリストへ移す')).toBeNull();
  });
});

describe('ドラッグで並べ替える・別のリストへ移す', () => {
  it('カードをほかのカードの上に落とすと、その前へ移す。落とす先には印を出す', () => {
    show();
    const transfer = dataTransfer();
    fireEvent.dragStart(cardRow('税率を読む'), { dataTransfer: transfer });
    expect(transfer.effectAllowed).toBe('move');
    fireEvent.dragOver(cardRow('表示を差し替える'), { dataTransfer: transfer });
    expect(cardRow('表示を差し替える').classList.contains('drop')).toBe(true);
    expect(transfer.dropEffect).toBe('move');
    fireEvent.drop(cardRow('表示を差し替える'), { dataTransfer: transfer });
    expect(applied()).toEqual([['s1', { type: 'card-move', listId: 'L1', cardIds: ['c1'], toListId: 'L1', before: 'c3' }]]);
    expect(cardRow('表示を差し替える').classList.contains('drop')).toBe(false);
  });

  it('リストの見出しに落とすと、そのリストの最後へ移す。選んだカードはまとめて運ぶ（並び順のまま）', () => {
    show();
    fireEvent.click(cardRow('表示を差し替える'), { metaKey: true });
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    const transfer = dataTransfer();
    fireEvent.dragStart(cardRow('表示を差し替える'), { dataTransfer: transfer });
    fireEvent.dragOver(head('完了前チェック'), { dataTransfer: transfer });
    expect(head('完了前チェック').classList.contains('drop')).toBe(true);
    fireEvent.drop(head('完了前チェック'), { dataTransfer: transfer });
    expect(applied()).toEqual([['s1', { type: 'card-move', listId: 'L1', cardIds: ['c1', 'c3'], toListId: 'L2', before: null }]]);
  });

  it('選んでいないカードを運ぶと、そのカードだけを運ぶ', () => {
    show();
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    fireEvent.click(cardRow('表示を差し替える'), { metaKey: true });
    const transfer = dataTransfer();
    fireEvent.dragStart(cardRow('計算をまとめる'), { dataTransfer: transfer });
    fireEvent.drop(cardRow('税率を読む'), { dataTransfer: transfer });
    expect(applied()).toEqual([['s1', { type: 'card-move', listId: 'L1', cardIds: ['c2'], toListId: 'L1', before: 'c1' }]]);
  });

  it('運んでいるカード自身に落としても何もしない。カード以外（ファイルなど）のドラッグには印を出さない', () => {
    show();
    const outside = dataTransfer();
    outside.setData('Files');
    fireEvent.dragOver(cardRow('税率を読む'), { dataTransfer: outside });
    expect(cardRow('税率を読む').classList.contains('drop')).toBe(false);
    fireEvent.drop(cardRow('税率を読む'), { dataTransfer: outside });
    expect(applied()).toEqual([]);

    const transfer = dataTransfer();
    fireEvent.dragStart(cardRow('税率を読む'), { dataTransfer: transfer });
    fireEvent.dragOver(cardRow('税率を読む'), { dataTransfer: transfer });
    fireEvent.drop(cardRow('税率を読む'), { dataTransfer: transfer });
    expect(applied()).toEqual([]);
  });

  it('外へ出る・ドラッグをやめると、落とす先の印を消す。やめたあとのドロップでは移さない', () => {
    show();
    const transfer = dataTransfer();
    fireEvent.dragStart(cardRow('税率を読む'), { dataTransfer: transfer });
    fireEvent.dragOver(cardRow('表示を差し替える'), { dataTransfer: transfer });
    fireEvent.dragLeave(cardRow('表示を差し替える'));
    expect(cardRow('表示を差し替える').classList.contains('drop')).toBe(false);
    fireEvent.dragOver(head('完了前チェック'), { dataTransfer: transfer });
    fireEvent.dragLeave(head('完了前チェック'));
    expect(head('完了前チェック').classList.contains('drop')).toBe(false);
    fireEvent.dragOver(cardRow('表示を差し替える'), { dataTransfer: transfer });
    fireEvent.dragEnd(cardRow('税率を読む'));
    expect(cardRow('表示を差し替える').classList.contains('drop')).toBe(false);
    fireEvent.drop(cardRow('表示を差し替える'), { dataTransfer: transfer });
    expect(applied()).toEqual([]);
  });
});

describe('ゴミ箱', () => {
  it('ゴミ箱の見出しで開け閉めし、ゴミ箱のリスト・カードを「戻す」で戻す', () => {
    show();
    const toggle = screen.getByText('ゴミ箱', { selector: '.checklist-trash-head', exact: false });
    expect(toggle.textContent).toContain('2');
    expect(screen.queryByText('ゴミ箱を空にする')).toBeNull();
    fireEvent.click(toggle);
    const listRow = screen.getByText('リスト「捨てたリスト」（1 枚）').closest('.checklist-trash-item') as HTMLElement;
    const cardRowInTrash = screen.getByText('やること #4 消したカード').closest('.checklist-trash-item') as HTMLElement;
    fireEvent.click(within(listRow).getByText('戻す'));
    fireEvent.click(within(cardRowInTrash).getByText('戻す'));
    expect(applied()).toEqual([
      ['s1', { type: 'list-restore', listId: 'L3' }],
      ['s1', { type: 'card-restore', listId: 'L1', cardIds: ['c4'] }],
    ]);
    fireEvent.click(toggle);
    expect(screen.queryByText('ゴミ箱を空にする')).toBeNull();
  });

  it('「ゴミ箱を空にする」は、件数を出して確かめてから空にする。やめたら何もしない', () => {
    show();
    fireEvent.click(screen.getByText('ゴミ箱', { selector: '.checklist-trash-head', exact: false }));
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByText('ゴミ箱を空にする'));
    expect(confirmSpy).toHaveBeenCalledWith('ゴミ箱の 2 件を消しますか？\n（もう戻せません）');
    expect(applied()).toEqual([]);
    fireEvent.click(screen.getByText('ゴミ箱を空にする'));
    expect(applied()).toEqual([['s1', { type: 'trash-empty' }]]);
  });
});

describe('別のセッションへコピー（CopyDialog）', () => {
  const openDialog = () => {
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    fireEvent.click(cardRow('表示を差し替える'), { metaKey: true });
    fireEvent.click(within(document.querySelector('.checklist-selection') as HTMLElement).getByLabelText('別のセッションへコピー'));
    return screen.getByRole('dialog', { name: '別のセッションへコピー' });
  };

  it('コピー先・リストの名前・知らせるかを選んで「コピー」すると、選んだカードをそのセッションへコピーして閉じる', async () => {
    show();
    const dialog = openDialog();
    expect(dialog.textContent).toContain('「やること」の #1・#3 を');
    const target = within(dialog).getByRole('combobox') as HTMLSelectElement;
    // 選べるのは、同じフォルダと親子のセッションだけ（自分・アーカイブ・別のフォルダは出さない）
    expect([...target.options].map((o) => o.value)).toEqual(['s2', 's5']);
    expect(target.value).toBe('s2');
    fireEvent.change(target, { target: { value: 's5' } });
    const toList = within(dialog).getByDisplayValue('やること') as HTMLInputElement;
    fireEvent.change(toList, { target: { value: ' 引き継ぎ ' } });
    const notify = within(dialog).getByRole('checkbox') as HTMLInputElement;
    expect(notify.checked).toBe(true);
    fireEvent.click(notify);
    expect(notify.checked).toBe(false);
    fireEvent.click(within(dialog).getByText('コピー'));
    expect(api.argsOf('checklist.copy')).toEqual([[{ fromSession: 's1', listId: 'L1', cardIds: ['c1', 'c3'], toSession: 's5', toList: '引き継ぎ', notify: false }]]);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('リストの名前が空なら「コピー」を押せない', () => {
    show();
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByDisplayValue('やること'), { target: { value: '  ' } });
    expect((within(dialog).getByText('コピー') as HTMLButtonElement).disabled).toBe(true);
  });

  it('コピーしている間は閉じられない。できなかったら理由を出し、もう一度押せるようにする', async () => {
    const copying = deferred();
    api = mockApi({ 'checklist.copy': () => copying.promise });
    api.install();
    show();
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByText('コピー'));
    const button = within(dialog).getByText('コピーしています…') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((within(dialog).getByText('キャンセル') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.mouseDown(document.querySelector('.overlay') as HTMLElement);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeTruthy();
    await act(async () => copying.reject(new Error("Error invoking remote method 'checklist:copy': Error: コピー先のセッションがありません")));
    expect(alertSpy).toHaveBeenCalledWith('コピーできませんでした: コピー先のセッションがありません');
    expect((within(dialog).getByText('コピー') as HTMLButtonElement).disabled).toBe(false);
  });

  it('外側を押す・Esc・「キャンセル」で、コピーせずに閉じる。ダイアログの中を押しても閉じない。変換の確定の Esc では閉じない', () => {
    show();
    let dialog = openDialog();
    fireEvent.mouseDown(dialog);
    fireEvent.mouseDown(within(dialog).getByRole('combobox'));
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.mouseDown(document.querySelector('.overlay') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(within(document.querySelector('.checklist-selection') as HTMLElement).getByLabelText('別のセッションへコピー'));
    dialog = screen.getByRole('dialog');
    fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Escape', isComposing: true });
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(within(document.querySelector('.checklist-selection') as HTMLElement).getByLabelText('別のセッションへコピー'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('キャンセル'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.argsOf('checklist.copy')).toEqual([]);
  });

  it('コピーできるセッションが無ければ、そう出して「コピー」を押せない', () => {
    const view = render(<ChecklistPanel session={S1} lists={LISTS()} sessions={[S1, SESSIONS[2], SESSIONS[3]]} activeCardId={null} onOpen={vi.fn()} />);
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    fireEvent.click(cardRow('表示を差し替える'), { metaKey: true });
    fireEvent.click(within(document.querySelector('.checklist-selection') as HTMLElement).getByLabelText('別のセッションへコピー'));
    const dialog = view.getByRole('dialog');
    expect(dialog.textContent).toContain('コピーできるセッションがありません');
    expect((within(dialog).getByText('コピー') as HTMLButtonElement).disabled).toBe(true);
  });

  // 不具合: コピー先を選ぶ欄（autoFocus）が無いと、フォーカスはダイアログを開いたボタンに残り、Esc がダイアログに届かない。
  // ほかのダイアログ（ExportDialog・BrowserHostsDialog など）は、開いたらダイアログの中にフォーカスを移している
  it('コピーできるセッションが無いときも、Esc で閉じられる', () => {
    render(<ChecklistPanel session={S1} lists={LISTS()} sessions={[S1]} activeCardId={null} onOpen={vi.fn()} />);
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    fireEvent.click(cardRow('表示を差し替える'), { metaKey: true });
    const open = within(document.querySelector('.checklist-selection') as HTMLElement).getByLabelText('別のセッションへコピー');
    // 押したボタンにフォーカスが移る（jsdom の click では移らないので、移しておく）
    open.focus();
    fireEvent.click(open);
    expect(screen.getByRole('dialog').textContent).toContain('コピーできるセッションがありません');
    // キーは、フォーカスのある所に届く
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('セッションを切り替えた直後', () => {
  const other = session('s2');
  const otherLists = () => [list('M1', '別のやること', [card('d1', 1, '別のカード'), card('d2', 2, '別のカード 2')]), list('M2', '別の確認', [])];

  it('選んでいたもの・書きかけを捨て、ボタンは切り替えた先のセッションのリスト・カードに効く', () => {
    const { rerender, props, onOpen } = show();
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    fireEvent.click(cardRow('表示を差し替える'), { metaKey: true });
    fireEvent.click(within(head('やること')).getByLabelText('カードを足す'));
    rerender(<ChecklistPanel {...props} session={other} lists={otherLists()} />);
    expect(document.querySelector('.checklist-selection')).toBeNull();
    expect(screen.queryByPlaceholderText('タイトル（Enter で足す）')).toBeNull();

    fireEvent.click(within(cardRow('別のカード')).getByRole('checkbox'));
    fireEvent.click(cardRow('別のカード 2'));
    fireEvent.click(within(head('別の確認')).getByLabelText('カードを足す'));
    fireEvent.change(screen.getByPlaceholderText('タイトル（Enter で足す）'), { target: { value: '足す' } });
    fireEvent.keyDown(screen.getByPlaceholderText('タイトル（Enter で足す）'), { key: 'Enter' });
    fireEvent.click(within(head('別の確認')).getByLabelText('リストをゴミ箱に入れる'));
    expect(applied()).toEqual([
      ['s2', { type: 'card-check', listId: 'M1', cardIds: ['d1'], checked: true }],
      ['s2', { type: 'card-add', listId: 'M2', title: '足す' }],
      ['s2', { type: 'list-delete', listId: 'M2' }],
    ]);
    expect(onOpen).toHaveBeenCalledWith('M1', 'd2');
  });

  it('切り替えた先で選んだカードのコピー・移動・ドラッグも、切り替えた先のセッションから行う', async () => {
    const { rerender, props } = show();
    fireEvent.click(cardRow('税率を読む'), { metaKey: true });
    rerender(<ChecklistPanel {...props} session={other} lists={otherLists()} />);
    fireEvent.click(cardRow('別のカード'), { metaKey: true });
    fireEvent.click(cardRow('別のカード 2'), { metaKey: true });
    fireEvent.change(screen.getByLabelText('別のリストへ移す'), { target: { value: 'M2' } });
    await settle();
    const transfer = dataTransfer();
    fireEvent.dragStart(cardRow('別のカード 2'), { dataTransfer: transfer });
    fireEvent.drop(cardRow('別のカード'), { dataTransfer: transfer });
    fireEvent.click(cardRow('別のカード'), { metaKey: true });
    fireEvent.click(cardRow('別のカード 2'), { metaKey: true });
    fireEvent.click(within(document.querySelector('.checklist-selection') as HTMLElement).getByLabelText('別のセッションへコピー'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('コピー'));
    expect(applied()).toEqual([
      ['s2', { type: 'card-move', listId: 'M1', cardIds: ['d1', 'd2'], toListId: 'M2' }],
      ['s2', { type: 'card-move', listId: 'M1', cardIds: ['d2'], toListId: 'M1', before: 'd1' }],
    ]);
    // コピー先には、切り替えた先のセッション自身は出さない（s1 が選ばれる）
    expect(api.argsOf('checklist.copy')).toEqual([[{ fromSession: 's2', listId: 'M1', cardIds: ['d1', 'd2'], toSession: 's1', toList: '別のやること', notify: true }]]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
