// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Menu, MenuOption } from '@shared/screen';
import { MenuCard } from '../../src/renderer/src/screen/MenuCard';
import { mockApi } from './mock-api';

// Claude Code の選択メニュー（質問・許可の確認）をボタンで操作するカード。押したボタンで、どのキーを送るか
// （単一選択は Enter・複数選択のチェックは Space・自由記述は打った文字と、単一なら Enter・複数なら何も押さない・キャンセルは Esc）

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi();
  api.install();
});
afterEach(cleanup);

const option = (id: string, label: string, over: Partial<MenuOption> = {}): MenuOption => ({ id, label, description: '', pointed: false, checked: null, textInput: false, ...over });
const menu = (over: Partial<Menu>): Menu => ({ kind: 'question', tabs: [], title: 'どれにしますか？', context: [], options: [], multiSelect: false, hint: '', ...over });

describe('MenuCard', () => {
  it('単一選択の選択肢を押すと、その選択肢を Enter で選ぶ', () => {
    render(<MenuCard sessionId="s1" menu={menu({ options: [option('1', 'はい'), option('2', 'いいえ', { description: '何もしない' })] })} />);
    fireEvent.click(screen.getByText('いいえ'));
    expect(api.argsOf('screen.choose')).toEqual([['s1', { optionId: '2', key: 'enter', text: undefined }]]);
    expect(screen.getByText('何もしない')).toBeTruthy();
  });

  it('複数選択のチェックは Space で付け外しし、確定の行は Enter で次へ進む', () => {
    render(
      <MenuCard
        sessionId="s1"
        menu={menu({ multiSelect: true, options: [option('1', '赤', { checked: true }), option('2', '青', { checked: false }), option('submit', 'Next')] })}
      />,
    );
    fireEvent.click(screen.getByText('青'));
    fireEvent.click(screen.getByText('次の質問へ →'));
    expect(api.argsOf('screen.choose')).toEqual([
      ['s1', { optionId: '2', key: 'space', text: undefined }],
      ['s1', { optionId: 'submit', key: 'enter', text: undefined }],
    ]);
  });

  it('最後の質問の確定の行は「回答の確認へ」と出す', () => {
    render(<MenuCard sessionId="s1" menu={menu({ multiSelect: true, options: [option('1', '赤', { checked: true }), option('submit', 'Submit')] })} />);
    expect(screen.getByText('回答の確認へ →')).toBeTruthy();
  });

  it('自由記述: 押すと入力欄を出し、単一選択では打った文字と Enter で答える。空では送らない', () => {
    render(<MenuCard sessionId="s1" menu={menu({ options: [option('1', 'はい'), option('2', 'Type something.', { textInput: true })] })} />);
    fireEvent.click(screen.getByText('その他（自由に入力）'));
    const input = screen.getByPlaceholderText('回答を入力');
    fireEvent.submit(input.closest('form')!);
    expect(api.argsOf('screen.choose')).toEqual([]);
    fireEvent.change(input, { target: { value: '別の案' } });
    fireEvent.click(screen.getByText('送信'));
    expect(api.argsOf('screen.choose')).toEqual([['s1', { optionId: '2', key: 'enter', text: '別の案' }]]);
  });

  it('自由記述: 複数選択では打つだけ（Enter はチェックを外してしまう）。打ってあった文字は入力欄に戻す', () => {
    render(<MenuCard sessionId="s1" menu={menu({ multiSelect: true, options: [option('1', '赤', { checked: false }), option('3', '黄色', { textInput: true, checked: true })] })} />);
    fireEvent.click(screen.getByText('その他: 黄色'));
    const input = screen.getByPlaceholderText('回答を入力') as HTMLInputElement;
    expect(input.value).toBe('黄色');
    fireEvent.change(input, { target: { value: '金色' } });
    fireEvent.click(screen.getByText('決定'));
    expect(api.argsOf('screen.choose')).toEqual([['s1', { optionId: '3', key: 'none', text: '金色' }]]);
  });

  it('キャンセルは Esc を送る', () => {
    render(<MenuCard sessionId="s1" menu={menu({ kind: 'permission', options: [option('1', 'Yes')] })} />);
    fireEvent.click(screen.getByLabelText('キャンセル'));
    expect(api.argsOf('pty.write')).toEqual([['s1', '\x1b']]);
  });

  it('見出し・質問のタブ（答えたものに印）・補足・質問文を出す', () => {
    const { container } = render(
      <MenuCard
        sessionId="s1"
        menu={menu({
          kind: 'permission',
          title: 'Do you want to proceed?',
          context: ['Bash command', 'rm -rf build'],
          tabs: [
            { label: '色', answered: true },
            { label: '形', answered: false },
          ],
          options: [option('1', 'Yes')],
        })}
      />,
    );
    expect(screen.getByText('実行の許可')).toBeTruthy();
    expect(screen.getByText('Do you want to proceed?')).toBeTruthy();
    expect(container.querySelector('.menu-context')?.textContent).toBe('Bash command\nrm -rf build');
    expect([...container.querySelectorAll('.menu-tab')].map((t) => [t.textContent, t.classList.contains('answered')])).toEqual([
      ['色', true],
      ['形', false],
    ]);
  });

  it('プレビュー: はじめはプレビューのある最初の選択肢、ホバーした選択肢のものに変える', () => {
    const { container } = render(
      <MenuCard
        sessionId="s1"
        menu={menu({ previewLayout: true, options: [option('1', '案 A', { preview: 'A の図' }), option('2', '案 B'), option('3', '案 C', { preview: 'C の図' })] })}
      />,
    );
    const body = () => container.querySelector('.menu-preview')?.textContent;
    expect(body()).toContain('A の図');
    fireEvent.mouseEnter(screen.getByText('案 C'));
    expect(body()).toContain('C の図');
    fireEvent.mouseEnter(screen.getByText('案 B'));
    expect(body()).toContain('この選択肢にはプレビューがありません');
  });
});
