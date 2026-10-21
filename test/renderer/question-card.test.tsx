// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingQuestion } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';
import { QuestionCard } from '../../src/renderer/src/screen/QuestionCard';
import './dom';
import { mockApi } from './mock-api';

// フックが答えを待っている AskUserQuestion の質問のカード（ターミナルの画面を読まずに描く）。
// ページの送り方は Claude Code の画面と同じ（1 問ずつ・タブ・単一選択は選ぶと次へ・複数選択はチェックして次へ・最後に回答の確認）。
// 答えは、全部そろってから、まとめて返す（question.reply）

let api: ReturnType<typeof mockApi>;
let replied: boolean | Error;
beforeEach(() => {
  replied = true;
  api = mockApi({ 'question.reply': () => (replied instanceof Error ? Promise.reject(replied) : Promise.resolve(replied)) });
  api.install();
});
afterEach(cleanup);

const style: AskQuestion = { question: '書き方は？', header: '書き方', multiSelect: false, options: [{ label: 'です・ます', description: '丁寧' }, { label: 'だ・である', description: '' }] };
const languages: AskQuestion = { question: '言語は？', header: '言語', multiSelect: true, options: [{ label: 'TypeScript', description: '' }, { label: 'Go', description: '' }] };
const color: AskQuestion = { question: '色は？', header: '', multiSelect: false, options: [{ label: '明るい', description: '' }, { label: '暗い', description: '' }] };
const withPreview: AskQuestion = { question: '並べ方は？', header: '並べ方', multiSelect: false, options: [{ label: '縦', description: '', preview: '縦の図' }, { label: '無し', description: '' }] };
const pending = (...questions: AskQuestion[]): PendingQuestion => ({ id: 'q1', questions, answered: {} });
const replies = () => api.argsOf('question.reply');
// 送り終えるのを待つ
const sent = () => act(async () => {});

describe('QuestionCard', () => {
  it('質問が 1 つで単一選択なら、選んだらすぐ送る', async () => {
    render(<QuestionCard sessionId="s1" question={pending(style)} />);
    expect(screen.getByText('丁寧')).toBeTruthy();
    // タブは、質問が複数あるときだけ
    expect(document.querySelector('.menu-tabs')).toBeNull();
    fireEvent.click(screen.getByText('だ・である'));
    await sent();
    expect(replies()).toEqual([['s1', 'q1', { kind: 'answer', answers: { '書き方は？': 'だ・である' } }]]);
  });

  it('質問が複数あれば 1 問ずつ出し、答えると次へ進み、最後に回答の確認を出してから、まとめて送る', async () => {
    render(<QuestionCard sessionId="s1" question={pending(style, languages, color)} />);
    const tabs = () => [...document.querySelectorAll('.menu-tab')].map((t) => `${t.textContent}${t.classList.contains('answered') ? '✓' : ''}${t.classList.contains('current') ? '*' : ''}`);
    // 見出しの無い質問は「n 問め」
    expect(tabs()).toEqual(['書き方*', '言語', '3 問め']);
    fireEvent.click(screen.getByText('です・ます'));
    expect(screen.getByText('言語は？')).toBeTruthy();
    expect(tabs()).toEqual(['書き方✓', '言語*', '3 問め']);
    // 複数選択: チェックを付け外しし、自由記述も足して、次の質問へ
    fireEvent.click(screen.getByText('Go'));
    fireEvent.click(screen.getByText('TypeScript'));
    fireEvent.click(screen.getByText('TypeScript'));
    fireEvent.click(screen.getByText('その他（自由に入力）'));
    fireEvent.change(screen.getByPlaceholderText('回答を入力（Enter で改行、⌘+Enter で決定）'), { target: { value: 'Zig\nと Rust' } });
    fireEvent.click(screen.getByText('決定'));
    expect(screen.getByText('その他: Zig\nと Rust', { normalizer: (s) => s })).toBeTruthy();
    fireEvent.click(screen.getByText('次の質問へ →'));
    fireEvent.click(screen.getByText('暗い'));
    // 回答の確認。画面で答えたときと同じ形（複数選択は選択肢の順に「, 」、自由記述は最後）
    expect(screen.getByText('回答の確認')).toBeTruthy();
    expect([...document.querySelectorAll('.menu-review dd')].map((d) => d.textContent)).toEqual(['です・ます', 'Go, Zig\nと Rust', '暗い']);
    expect(replies()).toEqual([]);
    fireEvent.click(screen.getByText('回答を送る'));
    await sent();
    expect(replies()).toEqual([['s1', 'q1', { kind: 'answer', answers: { '書き方は？': 'です・ます', '言語は？': 'Go, Zig\nと Rust', '色は？': '暗い' } }]]);
  });

  it('タブで前の質問に戻れ、選んだ答えが残っている。まだ答えていない質問があれば、確認で送れない', () => {
    render(<QuestionCard sessionId="s1" question={pending(style, languages, color)} />);
    // 先に 3 問めに答える
    fireEvent.click(screen.getByText('3 問め'));
    fireEvent.click(screen.getByText('明るい'));
    expect([...document.querySelectorAll('.menu-review dd')].map((d) => `${d.textContent}${d.classList.contains('unanswered') ? '!' : ''}`)).toEqual(['（未回答）!', '（未回答）!', '明るい']);
    expect((screen.getByText('回答を送る') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('3 問め'));
    expect(screen.getByText('明るい').closest('button')!.classList.contains('chosen')).toBe(true);
  });

  it('複数選択だけの質問も、回答の確認を出してから送る', async () => {
    render(<QuestionCard sessionId="s1" question={pending(languages)} />);
    fireEvent.click(screen.getByText('TypeScript'));
    fireEvent.click(screen.getByText('回答の確認へ →'));
    fireEvent.click(screen.getByText('回答を送る'));
    await sent();
    expect(replies()).toEqual([['s1', 'q1', { kind: 'answer', answers: { '言語は？': 'TypeScript' } }]]);
  });

  it('自由記述: 質問が 1 つで単一選択なら「送信」で送る。⌘+Enter で決め、Enter だけ・変換中・空では決めない。やめると入力欄を閉じる', async () => {
    render(<QuestionCard sessionId="s1" question={pending(style)} />);
    fireEvent.click(screen.getByText('その他（自由に入力）'));
    const input = screen.getByPlaceholderText('回答を入力（Enter で改行、⌘+Enter で決定）');
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    fireEvent.change(input, { target: { value: '1 行目\n2 行目' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(replies()).toEqual([]);
    expect(screen.getByText('送信')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('やめる'));
    expect(screen.queryByPlaceholderText('回答を入力（Enter で改行、⌘+Enter で決定）')).toBeNull();
    // もう一度開くと、打ちかけの文は残らない（決めていないので）。打って ⌘+Enter で送る
    fireEvent.click(screen.getByText('その他（自由に入力）'));
    fireEvent.change(screen.getByPlaceholderText('回答を入力（Enter で改行、⌘+Enter で決定）'), { target: { value: '  別の案\nです  ' } });
    fireEvent.keyDown(screen.getByPlaceholderText('回答を入力（Enter で改行、⌘+Enter で決定）'), { key: 'Enter', ctrlKey: true });
    await sent();
    expect(replies()).toEqual([['s1', 'q1', { kind: 'answer', answers: { '書き方は？': '別の案\nです' } }]]);
  });

  it('質問が複数あるときの単一選択の自由記述は「決定」で次の質問へ進む（フォームの送信でも）', () => {
    render(<QuestionCard sessionId="s1" question={pending(style, color)} />);
    fireEvent.click(screen.getByText('その他（自由に入力）'));
    const input = screen.getByPlaceholderText('回答を入力（Enter で改行、⌘+Enter で決定）');
    fireEvent.change(input, { target: { value: '常体と敬体を混ぜる' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByText('色は？')).toBeTruthy();
    fireEvent.click(screen.getByText('書き方'));
    expect(screen.getByText('その他: 常体と敬体を混ぜる').closest('button')!.classList.contains('chosen')).toBe(true);
  });

  it('右上のキャンセル・回答の確認のキャンセルは、キャンセルを送る', async () => {
    render(<QuestionCard sessionId="s1" question={pending(languages)} />);
    // Esc の受け口は無い（画面全体で Esc を受けると、エディタやダイアログを閉じるつもりの Esc で答えてしまう）ので、ツールチップにも出さない
    expect(screen.getByLabelText('キャンセル').getAttribute('data-tip')).toBe('キャンセル');
    fireEvent.click(screen.getByLabelText('キャンセル'));
    await sent();
    fireEvent.click(screen.getByText('回答の確認へ →'));
    fireEvent.click(screen.getByText('キャンセル', { selector: '.menu-option-label' }));
    await sent();
    expect(replies().map((args) => args[2])).toEqual([{ kind: 'cancel' }, { kind: 'cancel' }]);
  });

  it('もう答えられない（ほかで答えた・取り下げられた）・送れなかったときは、カードに知らせる', async () => {
    replied = false;
    render(<QuestionCard sessionId="s1" question={pending(style)} />);
    fireEvent.click(screen.getByText('です・ます'));
    await sent();
    expect(screen.getByRole('alert').textContent).toBe('この質問には、もう答えられません（ほかで答えたか、Claude Code が取り下げました）');
    replied = new Error('ipc');
    fireEvent.click(screen.getByText('だ・である'));
    await sent();
    expect(screen.getByRole('alert').textContent).toBe('送れませんでした。もう一度押してください');
  });

  describe('プレビューのポップアップ', () => {
    const layout: AskQuestion = {
      question: '並べ方は？',
      header: '並べ方',
      multiSelect: false,
      options: [
        { label: '縦', description: '', preview: '縦の図' },
        { label: '横', description: '', preview: '横の図' },
        { label: '無し', description: '' },
      ],
    };
    const option = (label: string) => screen.getByText(label).closest('button')!;
    const card = () => document.querySelector('.menu-card')!;
    const popup = () => document.querySelector<HTMLElement>('.menu-preview-popup');
    const shown = () => popup()?.querySelector('.menu-preview-body')?.textContent ?? null;
    afterEach(() => vi.useRealTimers());

    it('ホバーした選択肢のプレビューを、カードの外（body）のポップアップに出す。プレビューの無い選択肢では出さない', () => {
      render(<QuestionCard sessionId="s1" question={pending(layout)} />);
      expect(popup()).toBeNull();
      fireEvent.mouseEnter(option('縦'));
      expect(shown()).toBe('縦の図');
      expect(popup()!.querySelector('.menu-preview-label')!.textContent).toBe('プレビュー: 縦');
      // チャットの一覧のスクロールの枠で切れないよう body に出す（カードの中には出さないので、カードの高さが変わらない）
      expect(popup()!.parentElement).toBe(document.body);
      expect(card().contains(popup())).toBe(false);
      expect(option('縦').classList.contains('previewed')).toBe(true);
      expect(option('縦').getAttribute('aria-describedby')).toBe(popup()!.id);
      fireEvent.mouseEnter(option('横'));
      expect(shown()).toBe('横の図');
      expect(option('縦').classList.contains('previewed')).toBe(false);
      fireEvent.mouseEnter(option('無し'));
      expect(popup()).toBeNull();
    });

    it('マウスをカードからポップアップへ移しても消さず、両方から外れたら消す', () => {
      render(<QuestionCard sessionId="s1" question={pending(layout)} />);
      fireEvent.mouseEnter(option('横'));
      const element = popup()!;
      fireEvent.mouseOut(option('横'), { relatedTarget: element });
      expect(shown()).toBe('横の図');
      // ポップアップの中を動かしても替わらない
      fireEvent.mouseMove(element, { clientY: 5 });
      expect(shown()).toBe('横の図');
      fireEvent.mouseOut(element, { relatedTarget: document.body });
      expect(popup()).toBeNull();
      // カードから直接外れても消す
      fireEvent.mouseEnter(option('縦'));
      fireEvent.mouseLeave(card());
      expect(popup()).toBeNull();
    });

    it('Tab で選択肢に移ったときにも出す。カードからマウスが外れたら、フォーカスした選択肢のものに戻し、フォーカスが外れたら消す', () => {
      render(<QuestionCard sessionId="s1" question={pending(layout)} />);
      // キーボードで移ったフォーカス（:focus-visible）。jsdom も、直前がマウスの操作なら、そう見なさない
      fireEvent.keyDown(document.body, { key: 'Tab' });
      act(() => option('横').focus());
      expect(shown()).toBe('横の図');
      fireEvent.mouseEnter(option('縦'));
      expect(shown()).toBe('縦の図');
      fireEvent.mouseLeave(card());
      expect(shown()).toBe('横の図');
      act(() => option('横').blur());
      expect(popup()).toBeNull();
    });

    // 直す前（カードの上に出すだけ）: 下の選択肢からポップアップへマウスを動かす途中で、またいだ選択肢のプレビューに替わり、
    // 読みたいプレビューに乗れなかった。jsdom では大きさが 0 なので、ポップアップは画面の一番上（y=0）にあることになる
    it('ポップアップの向きへマウスを動かしている間は、乗った選択肢のプレビューに切り替えず、止まってから切り替える。逆の向きでは、すぐ切り替える', () => {
      vi.useFakeTimers();
      render(<QuestionCard sessionId="s1" question={pending(layout)} />);
      fireEvent.mouseMove(option('横'), { clientY: 100 });
      expect(shown()).toBe('横の図');
      // 上へ動かして「縦」に乗る。動かし続けている間は替えない
      fireEvent.mouseOver(option('縦'), { relatedTarget: option('横'), clientY: 60 });
      fireEvent.mouseMove(option('縦'), { clientY: 60 });
      act(() => vi.advanceTimersByTime(100));
      fireEvent.mouseMove(option('縦'), { clientY: 50 });
      act(() => vi.advanceTimersByTime(100));
      expect(shown()).toBe('横の図');
      // 止まったら替える
      act(() => vi.advanceTimersByTime(50));
      expect(shown()).toBe('縦の図');
      // 下へ動かすと、すぐ替える
      fireEvent.mouseMove(option('横'), { clientY: 120 });
      expect(shown()).toBe('横の図');
      // 上へ動かして「縦」をまたぎ、止まる前に抜けたら替えない
      fireEvent.mouseMove(option('縦'), { clientY: 40 });
      fireEvent.mouseOut(option('縦'), { relatedTarget: popup() });
      act(() => vi.advanceTimersByTime(500));
      expect(shown()).toBe('横の図');
    });
  });

  // 前は Claude Code の画面に合わせ、プレビュー付きの質問には自由記述を出さず、代わりにメモ欄を出していた。tanacode ではそろえた（決めたこと）
  it('プレビュー付きの質問も、プレビューの無い質問と同じ形（「その他（自由に入力）」があり、メモ欄・Chat about this は無い）', () => {
    // 選択肢の下の行（選択肢の名前を除いたもの）
    const rest = () => [...document.querySelectorAll('.menu-options > *')].slice(withPreview.options.length).map((e) => e.textContent);
    render(<QuestionCard sessionId="s1" question={pending(style)} />);
    const plain = rest();
    cleanup();
    render(<QuestionCard sessionId="s1" question={pending(withPreview)} />);
    expect(rest()).toEqual(plain);
    expect(rest()).toEqual(['その他（自由に入力）']);
    expect(document.querySelector('.menu-card textarea')).toBeNull();
    expect(screen.queryByText('この質問について話す（Chat about this）')).toBeNull();
  });

  it('プレビュー付きの質問: 選んだ案にプレビューがあれば添え書き（annotations）で渡す。プレビューの無い案・自由記述の答えには付けない', async () => {
    const { unmount } = render(<QuestionCard sessionId="s1" question={pending(withPreview)} />);
    fireEvent.click(screen.getByText('縦'));
    await sent();
    expect(replies()).toEqual([['s1', 'q1', { kind: 'answer', answers: { '並べ方は？': '縦' }, annotations: { '並べ方は？': { preview: '縦の図' } } }]]);
    unmount();
    render(<QuestionCard sessionId="s1" question={{ ...pending(withPreview), id: 'q2' }} />);
    fireEvent.click(screen.getByText('無し'));
    await sent();
    expect(replies()[1]).toEqual(['s1', 'q2', { kind: 'answer', answers: { '並べ方は？': '無し' } }]);
    cleanup();
    render(<QuestionCard sessionId="s1" question={{ ...pending(withPreview), id: 'q3' }} />);
    fireEvent.click(screen.getByText('その他（自由に入力）'));
    fireEvent.change(screen.getByPlaceholderText('回答を入力（Enter で改行、⌘+Enter で決定）'), { target: { value: '格子に並べる\n2 列で' } });
    fireEvent.click(screen.getByText('送信'));
    await sent();
    expect(replies()[2]).toEqual(['s1', 'q3', { kind: 'answer', answers: { '並べ方は？': '格子に並べる\n2 列で' } }]);
  });
});
