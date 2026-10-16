// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingPermission } from '@shared/questions';
import { MenuCard } from '../../src/renderer/src/screen/MenuCard';
import { mockApi } from './mock-api';

// Claude Code が答えを待っている、質問でない要求（許可の確認・プランの承認）のカード。押したボタンで、どの答えを返すか
// （許す・今後は聞かない・理由を伝えて断る・× で断って止める。プランは承認・承認して編集を自動で・直してほしいことを伝えて計画を続ける）

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({ 'permission.reply': () => Promise.resolve(true) });
  api.install();
});
afterEach(cleanup);

const permission = (over: Partial<PendingPermission> = {}): PendingPermission => ({
  id: 'req-1',
  tool: 'Bash',
  title: 'Bash',
  description: 'ビルドの成果物を消す',
  input: { command: 'rm -rf build', description: 'ビルドの成果物を消す' },
  reason: null,
  always: null,
  plan: null,
  agent: null,
  ...over,
});
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe('MenuCard（許可の確認）', () => {
  it('見出し・ツールの入力（Bash はコマンド）・説明・確認する理由・サブエージェントの印を出す', () => {
    const { container } = render(<MenuCard sessionId="s1" permission={permission({ reason: 'Bash は毎回確かめる設定です', agent: 'agent-1' })} />);
    expect(screen.getByText('実行の許可')).toBeTruthy();
    expect(container.querySelector('.menu-context')?.textContent).toBe('rm -rf build');
    expect(container.querySelector('.menu-title')?.textContent).toBe('Bash');
    expect(container.querySelector('.menu-notes')?.textContent).toContain('ビルドの成果物を消す');
    expect(container.querySelector('.menu-notes')?.textContent).toContain('確認する理由: Bash は毎回確かめる設定です');
    expect(container.querySelector('.menu-notes')?.textContent).toContain('サブエージェントの中の呼び出しです');
  });

  it('ファイルを書き換えるツールはファイルのパスを、ほかのツールは入力の JSON を出す', () => {
    const { container, rerender } = render(<MenuCard sessionId="s1" permission={permission({ tool: 'Write', input: { file_path: '/repo/hello.txt', content: 'こんにちは' } })} />);
    expect(container.querySelector('.menu-context')?.textContent).toBe('/repo/hello.txt');
    rerender(<MenuCard sessionId="s1" permission={permission({ id: 'req-2', tool: 'mcp__x__y', input: { url: 'https://example.com/' } })} />);
    expect(container.querySelector('.menu-context')?.textContent).toBe(JSON.stringify({ url: 'https://example.com/' }, null, 2));
  });

  it('「許可する」は許す。「今後は聞かない」は、Claude Code が候補を出したときだけ、足す許可の名前と一緒に出す', async () => {
    const { rerender } = render(<MenuCard sessionId="s1" permission={permission()} />);
    expect(screen.queryByText(/今後は聞かない/)).toBeNull();
    fireEvent.click(screen.getByText('許可する'));
    await settle();
    rerender(<MenuCard sessionId="s1" permission={permission({ id: 'req-2', always: ['Bash(rm -rf build)'] })} />);
    fireEvent.click(screen.getByText('許可して、今後は聞かない（Bash(rm -rf build)）'));
    await settle();
    expect(api.argsOf('permission.reply')).toEqual([
      ['s1', 'req-1', { kind: 'allow' }],
      ['s1', 'req-2', { kind: 'allow', always: true }],
    ]);
  });

  it('「断って、理由を伝える」は入力欄を出し、⌘+Enter か送信で理由を添えて断る。空では送らない。やめると閉じて、開き直した欄は空', async () => {
    render(<MenuCard sessionId="s1" permission={permission()} />);
    fireEvent.click(screen.getByText('断って、理由を伝える'));
    const box = () => screen.getByPlaceholderText(/断る理由/) as HTMLTextAreaElement;
    fireEvent.submit(box().closest('form')!);
    expect(api.argsOf('permission.reply')).toEqual([]);
    fireEvent.change(box(), { target: { value: '別の方法で' } });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByPlaceholderText(/断る理由/)).toBeNull();
    fireEvent.click(screen.getByText('断って、理由を伝える'));
    expect(box().value).toBe('');
    fireEvent.change(box(), { target: { value: '  消さずに、\n別のフォルダに出して  ' } });
    // Enter だけでは改行（送らない）
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(api.argsOf('permission.reply')).toEqual([]);
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await settle();
    expect(api.argsOf('permission.reply')).toEqual([['s1', 'req-1', { kind: 'deny', message: '消さずに、\n別のフォルダに出して' }]]);
  });

  it('右上の × は、断って作業を止める', async () => {
    render(<MenuCard sessionId="s1" permission={permission()} />);
    fireEvent.click(screen.getByLabelText('キャンセル'));
    await settle();
    expect(api.argsOf('permission.reply')).toEqual([['s1', 'req-1', { kind: 'stop' }]]);
  });

  it('もう答えられない（ほかで答えた・取り下げられた）・送れないときは、カードにそう出す。送っている間は押せない', async () => {
    let finish!: (ok: boolean) => void;
    api = mockApi({ 'permission.reply': () => new Promise((resolve) => (finish = resolve)) });
    api.install();
    render(<MenuCard sessionId="s1" permission={permission()} />);
    fireEvent.click(screen.getByText('許可する'));
    fireEvent.click(screen.getByLabelText('キャンセル'));
    expect(api.argsOf('permission.reply')).toEqual([['s1', 'req-1', { kind: 'allow' }]]);
    await act(async () => finish(false));
    expect(screen.getByRole('alert').textContent).toContain('この確認には、もう答えられません');
    api = mockApi({ 'permission.reply': () => Promise.reject(new Error('IPC')) });
    api.install();
    fireEvent.click(screen.getByText('許可する'));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('送れませんでした');
  });
});

describe('MenuCard（プランの承認）', () => {
  const plan = (text: string | null = '# 計画\n\n1. 価格を直す') => permission({ tool: 'ExitPlanMode', title: 'ExitPlanMode', description: null, input: {}, plan: text });

  it('プランの本文と、承認する・承認して編集を自動で進める・計画を続けるを出す（コンテキストを消して承認は出さない）', async () => {
    const { container } = render(<MenuCard sessionId="s1" permission={plan()} />);
    expect(screen.getByText('プランの承認')).toBeTruthy();
    expect(container.querySelector('.menu-plan')?.textContent).toBe('# 計画\n\n1. 価格を直す');
    expect(container.querySelector('.menu-title')?.textContent).toBe('このプランで進めますか？');
    expect([...container.querySelectorAll('.menu-option-label')].map((e) => e.textContent)).toEqual([
      '承認する（編集は毎回確かめる）',
      '承認して、編集を自動で進める',
      '計画を続ける（直してほしいことを伝える）',
    ]);
    fireEvent.click(screen.getByText('承認して、編集を自動で進める'));
    await settle();
    expect(api.argsOf('permission.reply')).toEqual([['s1', 'req-1', { kind: 'accept-edits' }]]);
  });

  it('計画を続けるときは、直してほしいことを添えて断る（Claude はプランを直す）', async () => {
    render(<MenuCard sessionId="s1" permission={plan()} />);
    fireEvent.click(screen.getByText('計画を続ける（直してほしいことを伝える）'));
    fireEvent.change(screen.getByPlaceholderText(/プランで直してほしいこと/), { target: { value: 'テストも足して' } });
    fireEvent.click(screen.getByText('送信'));
    await settle();
    expect(api.argsOf('permission.reply')).toEqual([['s1', 'req-1', { kind: 'deny', message: 'テストも足して' }]]);
  });

  it('プランの本文が取れなかったときは、本文の枠を出さない', () => {
    const { container } = render(<MenuCard sessionId="s1" permission={plan('')} />);
    expect(container.querySelector('.menu-plan')).toBeNull();
    expect(container.querySelector('.menu-context')).toBeNull();
    expect(screen.getByText('承認する（編集は毎回確かめる）')).toBeTruthy();
  });
});
