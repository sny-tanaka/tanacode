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

  // 差分の行（印と色の種類）
  const diffOf = (container: HTMLElement) => [...container.querySelectorAll('.menu-diff > span')].map((e) => [e.className, e.textContent]);
  const restOf = (container: HTMLElement) => [...container.querySelectorAll('.menu-input-rest > div')].map((e) => e.textContent);

  it('Edit は、ファイルのパスと、置き換える前と後の差分を出す。ほかの入力（replace_all）も出す', () => {
    const input = { file_path: '/repo/a.ts', old_string: 'const a = 1;\nconst b = 2;\n', new_string: 'const a = 1;\nconst b = 3;\n', replace_all: true };
    const { container } = render(<MenuCard sessionId="s1" permission={permission({ tool: 'Edit', description: null, input })} />);
    expect(container.querySelector('.menu-input-path')?.textContent).toBe('/repo/a.ts');
    expect(diffOf(container)).toEqual([
      ['same', ' const a = 1;\n'],
      ['del', '-const b = 2;\n'],
      ['add', '+const b = 3;\n'],
    ]);
    expect(restOf(container)).toEqual(['replace_all: true']);
  });

  it('MultiEdit は、編集ごとに何個めかと、その編集のほかの入力を区切りに出してから差分を出す', () => {
    const input = {
      file_path: '/repo/price.ts',
      edits: [
        { old_string: 'TAX = 0.08', new_string: 'TAX = 0.1' },
        { old_string: 'old()', new_string: 'next()', replace_all: true },
      ],
    };
    const { container } = render(<MenuCard sessionId="s1" permission={permission({ tool: 'MultiEdit', description: null, input })} />);
    expect(container.querySelector('.menu-input-path')?.textContent).toBe('/repo/price.ts');
    expect(diffOf(container)).toEqual([
      ['edit', '1/2 個めの編集\n'],
      ['del', '-TAX = 0.08\n'],
      ['add', '+TAX = 0.1\n'],
      ['edit', '2/2 個めの編集\n'],
      ['note', 'replace_all: true\n'],
      ['del', '-old()\n'],
      ['add', '+next()\n'],
    ]);
    expect(container.querySelector('.menu-input-rest')).toBeNull();
  });

  it('Write は書く中身を、NotebookEdit はセルの新しい中身を足す行として出し、ほかの入力（セルの ID など）も出す', () => {
    const { container, rerender } = render(<MenuCard sessionId="s1" permission={permission({ tool: 'Write', description: null, input: { file_path: '/repo/hello.txt', content: 'こんにちは\n世界\n' } })} />);
    expect(container.querySelector('.menu-input-path')?.textContent).toBe('/repo/hello.txt');
    expect(diffOf(container)).toEqual([
      ['add', '+こんにちは\n'],
      ['add', '+世界\n'],
    ]);
    const notebook = { notebook_path: '/repo/a.ipynb', cell_id: 'c1', new_source: 'print(1)', cell_type: 'code', edit_mode: 'replace' };
    rerender(<MenuCard sessionId="s1" permission={permission({ id: 'req-2', tool: 'NotebookEdit', description: null, input: notebook })} />);
    expect(container.querySelector('.menu-input-path')?.textContent).toBe('/repo/a.ipynb');
    expect(diffOf(container)).toEqual([['add', '+print(1)\n']]);
    expect(restOf(container)).toEqual(['cell_id: c1', 'cell_type: code', 'edit_mode: replace']);
    // セルを消すときは新しい中身が無いので、差分の枠を出さない
    rerender(<MenuCard sessionId="s1" permission={permission({ id: 'req-3', tool: 'NotebookEdit', description: null, input: { notebook_path: '/repo/a.ipynb', cell_id: 'c1', edit_mode: 'delete' } })} />);
    expect(container.querySelector('.menu-diff')).toBeNull();
    expect(restOf(container)).toEqual(['cell_id: c1', 'edit_mode: delete']);
  });

  it('Bash は、コマンドのほかの入力も出す（サンドボックスを外す入力は目立たせる）。説明がカードの説明と同じなら二度は出さない', () => {
    const input = { command: 'npm run e2e', description: 'E2E を流す', run_in_background: true, timeout: 600000, dangerouslyDisableSandbox: true };
    const { container, rerender } = render(<MenuCard sessionId="s1" permission={permission({ description: 'E2E を流す', input })} />);
    expect(container.querySelector('.menu-context')?.textContent).toBe('npm run e2e');
    expect(restOf(container)).toEqual(['run_in_background: true', 'timeout: 600000', 'dangerouslyDisableSandbox: true']);
    expect(container.querySelector('.menu-input-rest .danger')?.textContent).toBe('dangerouslyDisableSandbox: true');
    rerender(<MenuCard sessionId="s1" permission={permission({ id: 'req-2', description: '別の説明', input: { ...input, dangerouslyDisableSandbox: false } })} />);
    expect(restOf(container)).toEqual(['description: E2E を流す', 'run_in_background: true', 'timeout: 600000', 'dangerouslyDisableSandbox: false']);
    expect(container.querySelector('.menu-input-rest .danger')).toBeNull();
  });

  it('ほかのツールと、形の違う入力は、入力の JSON を全部出す', () => {
    const { container, rerender } = render(<MenuCard sessionId="s1" permission={permission({ tool: 'mcp__x__y', input: { url: 'https://example.com/' } })} />);
    expect(container.querySelector('.menu-context')?.textContent).toBe(JSON.stringify({ url: 'https://example.com/' }, null, 2));
    // new_string が無い Edit
    const odd = { file_path: '/repo/a.ts', old_string: 'a' };
    rerender(<MenuCard sessionId="s1" permission={permission({ id: 'req-2', tool: 'Edit', input: odd })} />);
    expect(container.querySelector('.menu-context')?.textContent).toBe(JSON.stringify(odd, null, 2));
    expect(container.querySelector('.menu-diff')).toBeNull();
  });

  it('長い中身は、ひとまとまりごとに 4000 文字までにして、省いた文字の数を出す', () => {
    const { container, rerender } = render(<MenuCard sessionId="s1" permission={permission({ input: { command: 'x'.repeat(4100) } })} />);
    expect(container.querySelector('.menu-context')?.textContent).toBe(`${'x'.repeat(4000)}\n…（残りの 100 文字は省きました）`);
    // 差分は行の区切りも 1 文字に数える（99 文字 + 改行を 50 行で 5000 文字）
    const content = Array.from({ length: 50 }, () => 'y'.repeat(99)).join('\n');
    rerender(<MenuCard sessionId="s1" permission={permission({ id: 'req-2', tool: 'Write', description: null, input: { file_path: '/repo/big.txt', content } })} />);
    const lines = diffOf(container);
    expect(lines).toHaveLength(41);
    expect(lines.slice(0, 40).every(([kind, text]) => kind === 'add' && text === `+${'y'.repeat(99)}\n`)).toBe(true);
    expect(lines[40]).toEqual(['note', '…（残りの 1000 文字は省きました）\n']);
  });

  it('確認する理由・説明・ツールの入力は、制御文字（ANSI のエスケープ・双方向の制御文字）を除いて出す', () => {
    const { container } = render(
      <MenuCard
        sessionId="s1"
        permission={permission({
          title: '\x1b[1mBash\x1b[0m',
          description: '消す‮',
          input: { command: 'rm -rf build ‮# txt.gnp' },
          reason: '\x1b[31mフックが確かめるよう求めました\x1b[0m‮',
        })}
      />,
    );
    expect(container.querySelector('.menu-title')?.textContent).toBe('[1mBash[0m');
    expect(container.querySelector('.menu-context')?.textContent).toBe('rm -rf build # txt.gnp');
    expect(container.querySelector('.menu-notes')?.textContent).toBe('消す確認する理由: [31mフックが確かめるよう求めました[0m');
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

  it('右上の × は、断って作業を止める。キーの Esc は割り当てないので、ツールチップにも出さない', async () => {
    render(<MenuCard sessionId="s1" permission={permission()} />);
    expect(screen.getByLabelText('キャンセル').getAttribute('data-tip')).toBe('断って、作業を止める');
    // ほかの場所（エディタ・入力欄の候補など）で押した Esc で、作業を止めない
    fireEvent.keyDown(screen.getByText('許可する'), { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(api.argsOf('permission.reply')).toEqual([]);
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

  it('プランの本文を読めなかった（空の文字列）ときは、そう出して承認の 2 つを押せなくする。計画を続ける・× は使える', async () => {
    const { container } = render(<MenuCard sessionId="s1" permission={plan('')} />);
    expect(container.querySelector('.menu-plan')).toBeNull();
    expect(container.querySelector('.menu-context')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('プランを読めませんでした');
    const button = (label: string) => screen.getByText(label).closest('button')!;
    expect(button('承認する（編集は毎回確かめる）').disabled).toBe(true);
    expect(button('承認して、編集を自動で進める').disabled).toBe(true);
    expect(button('計画を続ける（直してほしいことを伝える）').disabled).toBe(false);
    fireEvent.click(button('承認する（編集は毎回確かめる）'));
    fireEvent.click(button('承認して、編集を自動で進める'));
    await settle();
    expect(api.argsOf('permission.reply')).toEqual([]);
    fireEvent.click(button('計画を続ける（直してほしいことを伝える）'));
    fireEvent.change(screen.getByPlaceholderText(/プランで直してほしいこと/), { target: { value: 'プランを見せて' } });
    fireEvent.click(screen.getByText('送信'));
    await settle();
    fireEvent.click(screen.getByLabelText('キャンセル'));
    await settle();
    expect(api.argsOf('permission.reply')).toEqual([
      ['s1', 'req-1', { kind: 'deny', message: 'プランを見せて' }],
      ['s1', 'req-1', { kind: 'stop' }],
    ]);
  });

  it('読めたプランでは、承認の 2 つを押せる（読めない知らせは出さない）', () => {
    render(<MenuCard sessionId="s1" permission={plan()} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('承認する（編集は毎回確かめる）').closest('button')!.disabled).toBe(false);
  });
});
