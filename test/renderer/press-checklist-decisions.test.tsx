// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Checklist } from '@shared/checklist';
import { CardPane } from '../../src/renderer/src/checklist/CardPane';
import { ChecklistPanel } from '../../src/renderer/src/checklist/ChecklistPanel';
import './dom';
import { mockApi } from './mock-api';
import { card, list, NOW, session } from './press-checklist-fixtures';

// 決定事項のリスト（チェックで消えない）の画面。サイドパネルでは、チェック欄の代わりにピン、進み具合の代わりに有効な数を出し、
// 取り消したカードに印を付ける。カードの詳細では、「取り消す」（理由を書ける）と「有効に戻す」を出す。
// リストのフォームで、種類（ふつう・確認事項・決定事項）を選べる

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi();
  api.install();
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const S1 = session('s1');
const kept = () => card('d1', 1, '決済には触らない');
const revoked = () => card('d2', 2, '端数は切り捨て', { revoked: { by: 'claude', at: NOW, reason: '四捨五入に変わった' } });
const decisions = () => list('D1', '決定事項', [kept(), revoked(), card('d3', 3, '消した決定', { deletedAt: NOW })], { kind: 'decisions', description: '決まったこと' });
const review = () => list('R1', '確認事項', [card('r1', 1, '端数は四捨五入にした')], { kind: 'review' });
const todo = () => list('L1', 'やること', [card('c1', 1, '税率を読む', { checked: true, checkedBy: 'human' })]);

const applied = () => api.argsOf('checklist.apply');
const head = (name: string) => screen.getByText(name, { selector: '.checklist-list-name' }).closest('.checklist-list-head') as HTMLElement;
const row = (title: string) => screen.getByText(title, { selector: '.checklist-title' }).closest('.checklist-card') as HTMLElement;

function panel(lists: Checklist[] = [decisions(), review(), todo()]) {
  return render(<ChecklistPanel session={S1} lists={lists} sessions={[S1]} activeCardId={null} onOpen={vi.fn()} />);
}

function pane(l: Checklist, c: Card) {
  return render(<CardPane session={S1} sessions={[S1]} list={l} card={c} onClose={vi.fn()} />);
}

describe('サイドパネル', () => {
  it('決定事項のリストは、進み具合の代わりに有効な数（取り消し・ゴミ箱を除く）を出し、カードにチェック欄を出さない', () => {
    panel();
    const progress = head('決定事項').querySelector('.checklist-progress') as HTMLElement;
    expect(progress.classList.contains('pinned')).toBe(true);
    expect(progress.textContent).toBe('1 件');
    expect(progress.getAttribute('aria-label')).toBe('有効な決定 1 件（取り消したものは数えません）');
    expect(within(row('決済には触らない')).queryByRole('checkbox')).toBeNull();
    expect(row('決済には触らない').querySelector('.checklist-pin')).not.toBeNull();
    // ふつうのリストと確認事項は、これまでどおり
    expect(head('やること').querySelector('.checklist-progress')!.textContent).toBe('1/1');
    expect(within(row('端数は四捨五入にした')).getByRole('checkbox')).toBeDefined();
  });

  it('取り消したカードは残して、印と理由を出す', () => {
    panel();
    const r = row('端数は切り捨て');
    expect(r.classList.contains('revoked')).toBe(true);
    const badge = r.querySelector('.checklist-revoked') as HTMLElement;
    expect(badge.textContent).toBe('取り消し');
    expect(badge.getAttribute('data-tip')).toBe('取り消した決定（有効ではありません）: 四捨五入に変わった');
    expect(row('決済には触らない').classList.contains('revoked')).toBe(false);
    expect(row('決済には触らない').querySelector('.checklist-revoked')).toBeNull();
  });

  it('見出しのツールチップで、種類が分かる', () => {
    panel();
    expect(head('決定事項').getAttribute('data-tip')).toContain('決定事項のリスト。チェックで消えず、有効なカードを Claude にいつも渡します');
    expect(head('確認事項').getAttribute('data-tip')).toContain('チェック（承認）したカードは、決定事項に移ります');
    expect(head('やること').getAttribute('data-tip')).toBe('説明はありません\nダブルクリックで名前と説明を変える');
  });

  it('リストを作るフォームで、種類を選べる（既定はふつう）', () => {
    panel([]);
    fireEvent.click(screen.getByText('リストを作る'));
    const form = document.querySelector('.checklist-form') as HTMLFormElement;
    const kind = within(form).getByLabelText('種類') as HTMLSelectElement;
    expect(kind.value).toBe('normal');
    expect([...kind.options].map((o) => o.textContent)).toEqual(['ふつう（チェックして消していく）', '確認事項（承認したら決定事項に移す）', '決定事項（消えない。チェックなし）', 'いまの状態（Claude が書き換える。チェックなし）']);
    fireEvent.change(within(form).getByPlaceholderText(/^名前/), { target: { value: '決定事項' } });
    fireEvent.change(kind, { target: { value: 'decisions' } });
    fireEvent.click(within(form).getByText('作る'));
    expect(applied()).toEqual([['s1', { type: 'list-create', name: '決定事項', description: '', kind: 'decisions' }]]);
  });

  it('見出しをダブルクリックしたフォームには今の種類が入り、変えて保存できる（古い「確認事項」に印を付ける）', () => {
    panel([decisions(), list('R0', '確認事項', [])]);
    fireEvent.doubleClick(head('決定事項'));
    expect((screen.getByLabelText('種類') as HTMLSelectElement).value).toBe('decisions');
    fireEvent.click(screen.getByText('キャンセル'));
    fireEvent.doubleClick(head('確認事項'));
    const kind = screen.getByLabelText('種類') as HTMLSelectElement;
    expect(kind.value).toBe('normal');
    fireEvent.change(kind, { target: { value: 'review' } });
    fireEvent.click(screen.getByText('保存'));
    expect(applied()).toEqual([['s1', { type: 'list-update', listId: 'R0', name: '確認事項', description: '', kind: 'review' }]]);
  });
});

describe('カードの詳細', () => {
  it('決定事項のカードは、チェック欄の代わりに「有効」と「取り消す」を出す', () => {
    pane(decisions(), kept());
    expect(document.querySelector('.diff-pane-head [role="checkbox"]')).toBeNull();
    expect(document.querySelector('.card-pane-state')!.textContent).toBe('有効');
    expect(screen.getByText('取り消す')).toBeDefined();
    expect(screen.queryByText('有効に戻す')).toBeNull();
    expect(document.querySelector('.card-pane-revoked')).toBeNull();
  });

  it('「取り消す」で理由を書く欄を出し、Enter で理由つきで取り消す', () => {
    pane(decisions(), kept());
    fireEvent.click(screen.getByText('取り消す'));
    const input = screen.getByPlaceholderText(/^取り消す理由/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: ' 決済もこの PR でやることになった ' } });
    // 変換の確定の Enter では取り消さない
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(applied()).toEqual([]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(applied()).toEqual([['s1', { type: 'card-revoke', listId: 'D1', cardIds: ['d1'], reason: '決済もこの PR でやることになった' }]]);
    expect(screen.queryByPlaceholderText(/^取り消す理由/)).toBeNull();
  });

  it('理由を書かずに、ボタンでも取り消せる。Esc・キャンセルでは取り消さない', () => {
    pane(decisions(), kept());
    fireEvent.click(screen.getByText('取り消す'));
    fireEvent.keyDown(screen.getByPlaceholderText(/^取り消す理由/), { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/^取り消す理由/)).toBeNull();
    fireEvent.click(screen.getByText('取り消す'));
    fireEvent.click(screen.getByText('キャンセル'));
    expect(applied()).toEqual([]);
    fireEvent.click(screen.getByText('取り消す'));
    fireEvent.click(within(document.querySelector('.card-pane-revoke') as HTMLElement).getByText('取り消す'));
    expect(applied()).toEqual([['s1', { type: 'card-revoke', listId: 'D1', cardIds: ['d1'], reason: '' }]]);
  });

  it('取り消したカードは、誰がなぜ取り消したかを出し、「有効に戻す」で戻せる', () => {
    pane(decisions(), revoked());
    expect(document.querySelector('.card-pane-state')!.textContent).toBe('取り消し');
    const note = document.querySelector('.card-pane-revoked') as HTMLElement;
    expect(note.textContent).toContain('Claude が取り消し');
    expect(note.textContent).toContain('取り消した理由: 四捨五入に変わった');
    expect(document.querySelector('h2.card-pane-title')!.classList.contains('revoked')).toBe(true);
    expect(screen.queryByText('取り消す')).toBeNull();
    fireEvent.click(screen.getByText('有効に戻す'));
    expect(applied()).toEqual([['s1', { type: 'card-reinstate', listId: 'D1', cardIds: ['d2'] }]]);
  });

  it('人は、決定事項のカードも直せて、ゴミ箱に入れられる', () => {
    pane(decisions(), kept());
    fireEvent.doubleClick(document.querySelector('h2.card-pane-title') as HTMLElement);
    const input = document.querySelector('textarea.card-pane-title-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '決済には、この PR では触らない' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByLabelText('ゴミ箱に入れる'));
    expect(applied()).toEqual([
      ['s1', { type: 'card-update', listId: 'D1', cardId: 'd1', title: '決済には、この PR では触らない' }],
      ['s1', { type: 'card-delete', listId: 'D1', cardIds: ['d1'] }],
    ]);
  });

  it('スレッドに、取り消し（理由つき・理由なし）と戻しの記録を出す', () => {
    const thread: Card['thread'] = [
      { id: 'e1', at: NOW, author: 'claude', kind: 'event', event: { type: 'revoked', reason: '四捨五入に変わった' } },
      { id: 'e2', at: NOW, author: 'human', kind: 'event', event: { type: 'reinstated' } },
      { id: 'e3', at: NOW, author: 'human', kind: 'event', event: { type: 'revoked', reason: '' } },
    ];
    pane(decisions(), { ...revoked(), thread });
    const rows = [...document.querySelectorAll('.card-thread-event')].map((e) => e.textContent!.split(' · ')[0]);
    expect(rows).toEqual(['Claude が取り消しました（理由: 四捨五入に変わった）', 'あなたが有効に戻しました', 'あなたが取り消しました']);
  });

  it('ふつうのリストのカードには、取り消しのボタンを出さない', () => {
    const l = todo();
    pane(l, l.cards[0]);
    expect(screen.queryByText('取り消す')).toBeNull();
    expect(document.querySelector('.card-pane-state')).toBeNull();
    expect(document.querySelector('.diff-pane-head [role="checkbox"]')).not.toBeNull();
  });
});
