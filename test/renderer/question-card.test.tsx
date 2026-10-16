// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingQuestion } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';
import { QuestionCard } from '../../src/renderer/src/screen/QuestionCard';
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

  it('Chat about this・右上のキャンセル・回答の確認のキャンセルは、それぞれの返事を送る', async () => {
    render(<QuestionCard sessionId="s1" question={pending(languages)} />);
    fireEvent.click(screen.getByText('この質問について話す（Chat about this）'));
    await sent();
    fireEvent.click(screen.getByLabelText('キャンセル'));
    await sent();
    fireEvent.click(screen.getByText('回答の確認へ →'));
    fireEvent.click(screen.getByText('キャンセル', { selector: '.menu-option-label' }));
    await sent();
    expect(replies().map((args) => args[2])).toEqual([{ kind: 'chat' }, { kind: 'cancel' }, { kind: 'cancel' }]);
  });

  it('もう答えられない（人がターミナルで答えた）・送れなかったときは、カードに知らせる', async () => {
    replied = false;
    render(<QuestionCard sessionId="s1" question={pending(style)} />);
    fireEvent.click(screen.getByText('です・ます'));
    await sent();
    expect(screen.getByRole('alert').textContent).toBe('この質問には、もう答えられません（ターミナルで答えたか、Claude Code が先へ進みました）');
    replied = new Error('ipc');
    fireEvent.click(screen.getByText('だ・である'));
    await sent();
    expect(screen.getByRole('alert').textContent).toBe('送れませんでした。もう一度押してください');
  });

  it('プレビュー付きの選択肢は、ホバー・フォーカスしたもののプレビューを出す。この形には自由記述が無い', () => {
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
    render(<QuestionCard sessionId="s1" question={pending(layout)} />);
    expect(screen.getByText('縦の図')).toBeTruthy();
    expect(screen.queryByText('その他（自由に入力）')).toBeNull();
    fireEvent.mouseEnter(screen.getByText('横'));
    expect(screen.getByText('横の図')).toBeTruthy();
    fireEvent.focus(screen.getByText('無し').closest('button')!);
    expect(screen.getByText('この選択肢にはプレビューがありません')).toBeTruthy();
  });
});
