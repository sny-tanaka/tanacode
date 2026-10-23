// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { elicitationFieldsOf, type PendingElicitation } from '@shared/elicitation';
import { ElicitationCard } from '../../src/renderer/src/screen/ElicitationCard';
import { useSessionElicitations } from '../../src/renderer/src/screen/useSessionElicitations';
import { mockApi } from './mock-api';

// MCP サーバーから人への質問のカード。項目の種類ごとの入力欄・入力の確かめ・押したボタンで返す答え
// （フォームは送る・断る・× で答えずに閉じる。URL は開く・断る。開いたあとは、もう一度開く・閉じる）

let api: ReturnType<typeof mockApi>;
let replied: boolean | Error;
beforeEach(() => {
  replied = true;
  api = mockApi({ 'elicitation.reply': () => (replied instanceof Error ? Promise.reject(replied) : Promise.resolve(replied)) });
  api.install();
});
afterEach(cleanup);

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const replies = () => api.argsOf('elicitation.reply').map((args) => args[2]);

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: '名前', description: '画面に出す名前', maxLength: 5 },
    mail: { type: 'string', title: 'メール', format: 'email' },
    replicas: { type: 'integer', title: '台数', minimum: 1, maximum: 3, default: 2 },
    target: { type: 'string', title: '出す先', oneOf: [{ const: 'stg', title: 'ステージング' }, { const: 'prod', title: '本番' }] },
    notify: { type: 'boolean', title: '終わったら知らせる' },
    regions: { type: 'array', title: '地域', items: { anyOf: [{ const: 'jp', title: '日本' }, { const: 'us', title: 'アメリカ' }] } },
    day: { type: 'string', title: '日付', format: 'date' },
  },
  required: ['name', 'target'],
};

const form = (over: Partial<PendingElicitation> = {}): PendingElicitation => ({
  id: 'e1',
  server: 'deploy',
  message: 'どこに出しますか？\n2 行め',
  title: null,
  description: null,
  mode: 'form',
  url: null,
  openable: false,
  ...elicitationFieldsOf(SCHEMA),
  opened: false,
  ...over,
});
const url = (over: Partial<PendingElicitation> = {}): PendingElicitation => ({
  ...form(),
  id: 'u1',
  server: 'auth',
  message: 'ログインしてください',
  mode: 'url',
  url: 'https://github.com@evil.example/login?state=x',
  openable: true,
  fields: [],
  unsupported: [],
  ...over,
});

const field = (container: HTMLElement, title: string) => [...container.querySelectorAll<HTMLElement>('.menu-field')].find((f) => f.textContent?.startsWith(title))!;
const input = (container: HTMLElement, title: string) => field(container, title).querySelector<HTMLInputElement & HTMLSelectElement>('input, select')!;
const errorOf = (container: HTMLElement, title: string) => field(container, title).querySelector('.menu-field-error')?.textContent ?? null;

describe('ElicitationCard（フォームの形）', () => {
  it('どのサーバーからか・見出し・質問の文・説明と、項目ごとの入力欄（名前・説明・必須の印・既定値）を出す', () => {
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={form({ title: '出す先の確認', description: 'あとから変えられます' })} />);
    expect(screen.getByText('MCP サーバーからの質問')).toBeTruthy();
    expect(container.querySelector('.menu-elicitation-server')?.textContent).toBe('MCP サーバー: deploy');
    expect(container.querySelector('.menu-elicitation-heading')?.textContent).toBe('出す先の確認');
    expect(container.querySelector('.menu-title')?.textContent).toBe('どこに出しますか？\n2 行め');
    expect(container.querySelector('.menu-notes')?.textContent).toBe('あとから変えられます');
    expect([...container.querySelectorAll('.menu-field-label')].map((e) => e.textContent)).toEqual(['名前必須', 'メール', '台数', '出す先必須', '終わったら知らせる', '地域', '日付']);
    expect(field(container, '名前').querySelector('.menu-field-desc')?.textContent).toBe('画面に出す名前');
    // 入力欄の種類は、項目の形と format から
    expect(input(container, '名前').type).toBe('text');
    expect(input(container, '名前').maxLength).toBe(5);
    expect(input(container, 'メール').type).toBe('email');
    expect(input(container, '台数')).toMatchObject({ type: 'number', value: '2', min: '1', max: '3', step: '1' });
    expect(input(container, '日付').type).toBe('date');
    expect([...input(container, '出す先').options].map((o) => o.textContent)).toEqual(['選んでください', 'ステージング', '本番']);
    expect(input(container, '終わったら知らせる').type).toBe('checkbox');
    expect([...field(container, '地域').querySelectorAll('.menu-field-check')].map((e) => e.textContent)).toEqual(['日本', 'アメリカ']);
  });

  it('送ろうとしたら、入力の誤りを項目ごとに出して送らない。直すと消え、確かめた中身を accept で送る', async () => {
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={form()} />);
    // 打つ前は、誤りを出さない
    expect(container.querySelector('.menu-field-error')).toBeNull();
    fireEvent.change(input(container, 'メール'), { target: { value: 'メールでない' } });
    fireEvent.change(input(container, '台数'), { target: { value: '9' } });
    fireEvent.click(screen.getByText('送る'));
    expect(errorOf(container, '名前')).toBe('入力してください');
    expect(errorOf(container, 'メール')).toBe('メールアドレスの形で入力してください');
    expect(errorOf(container, '台数')).toBe('3 以下にしてください');
    expect(errorOf(container, '出す先')).toBe('選んでください');
    expect(field(container, '名前').classList.contains('invalid')).toBe(true);
    expect(input(container, '名前').getAttribute('aria-invalid')).toBe('true');
    expect(replies()).toEqual([]);
    fireEvent.change(input(container, '名前'), { target: { value: 'たなか' } });
    fireEvent.change(input(container, 'メール'), { target: { value: '' } });
    fireEvent.change(input(container, '台数'), { target: { value: '3' } });
    fireEvent.change(input(container, '出す先'), { target: { value: 'prod' } });
    fireEvent.click(input(container, '終わったら知らせる'));
    fireEvent.click(screen.getByLabelText('アメリカ'));
    fireEvent.change(input(container, '日付'), { target: { value: '2026-10-20' } });
    expect(container.querySelector('.menu-field-error')).toBeNull();
    fireEvent.click(screen.getByText('送る'));
    await settle();
    expect(api.argsOf('elicitation.reply')).toEqual([['s1', 'e1', { kind: 'accept', content: { name: 'たなか', replicas: 3, target: 'prod', notify: true, regions: ['us'], day: '2026-10-20' } }]]);
  });

  it('文字の欄で Enter を押しても送る（フォームの送信）', async () => {
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={form({ ...elicitationFieldsOf({ type: 'object', properties: { name: { type: 'string', title: '名前' } } }) })} />);
    fireEvent.change(input(container, '名前'), { target: { value: 'a' } });
    fireEvent.submit(container.querySelector('form')!);
    await settle();
    expect(replies()).toEqual([{ kind: 'accept', content: { name: 'a' } }]);
  });

  it('断るは decline、右上の × は答えずに閉じる（cancel）', async () => {
    render(<ElicitationCard sessionId="s1" elicitation={form()} />);
    fireEvent.click(screen.getByText('断る'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await settle();
    expect(replies()).toEqual([{ kind: 'decline' }, { kind: 'cancel' }]);
  });

  it('項目の無い質問は、入力欄を出さずに、送ると空の中身で accept', async () => {
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={form({ fields: [], unsupported: [] })} />);
    expect(container.querySelector('form')).toBeNull();
    fireEvent.click(screen.getByText('送る'));
    await settle();
    expect(replies()).toEqual([{ kind: 'accept', content: {} }]);
  });

  it('出せない形の項目があれば、その名前を出して、断ることだけできる', async () => {
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={form({ ...elicitationFieldsOf({ type: 'object', properties: { address: { type: 'object' }, tags: { type: 'array' } } }) })} />);
    expect(container.querySelector('.menu-elicitation-warning')?.textContent).toBe('この質問には、tanacode では入力できない形の項目があります（address, tags）。断ってください。');
    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByText('送る')).toBeNull();
    fireEvent.click(screen.getByText('断る'));
    await settle();
    expect(replies()).toEqual([{ kind: 'decline' }]);
  });

  it('もう待っていなければ、その旨を出す。送れなければ、もう一度押すよう出す。送っている間は押せない', async () => {
    replied = false;
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={form({ fields: [], unsupported: [] })} />);
    fireEvent.click(screen.getByText('断る'));
    expect((screen.getByText('断る').closest('button') as HTMLButtonElement).disabled).toBe(true);
    await settle();
    expect(container.querySelector('.menu-card-error')?.textContent).toBe('この質問には、もう答えられません（ほかで答えたか、取り下げられました）');
    replied = new Error('切れた');
    fireEvent.click(screen.getByText('断る'));
    await settle();
    expect(container.querySelector('.menu-card-error')?.textContent).toBe('送れませんでした。もう一度押してください');
  });
});

describe('ElicitationCard（URL の形）', () => {
  it('開くページをホストを目立たせて出し、「ページを開く」で open、断るで decline を送る', async () => {
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={url()} />);
    expect(container.querySelector('.menu-elicitation-server')?.textContent).toBe('MCP サーバー: auth');
    expect(container.querySelector('.menu-title')?.textContent).toBe('ログインしてください');
    // user@host の形でも、本当のホストを目立たせる
    expect(container.querySelector('.menu-elicitation-url')?.textContent).toBe('https://github.com@evil.example/login?state=x');
    expect(container.querySelector('.menu-elicitation-url strong')?.textContent).toBe('evil.example');
    expect(container.querySelector('.menu-notes')?.textContent).toBe('ふだんのブラウザで開きます。開いたページで続けてください。');
    fireEvent.click(screen.getByText('ページを開く'));
    await settle();
    fireEvent.click(screen.getByText('断る'));
    await settle();
    expect(replies()).toEqual([{ kind: 'open' }, { kind: 'decline' }]);
  });

  it('開けないページは、開くボタンを出さずに断ることだけできる', () => {
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={url({ url: 'javascript:alert(1)', openable: false })} />);
    expect(container.querySelector('.menu-elicitation-url')?.textContent).toBe('javascript:alert(1)');
    expect(container.querySelector('.menu-elicitation-warning')?.textContent).toBe('このページは開けません（http・https のページではありません）。断ってください。');
    expect(screen.queryByText('ページを開く')).toBeNull();
    expect(screen.getByText('断る')).toBeTruthy();
  });

  it('開いたあとは完了待ちのカード: × は出さず、もう一度開く・閉じるを送る', async () => {
    const { container } = render(<ElicitationCard sessionId="s1" elicitation={url({ id: 'opened:u1', opened: true })} />);
    expect(container.querySelector('.menu-card')?.classList.contains('opened')).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('ページをブラウザで開きました。ページでの操作を終えると、このカードは閉じます。');
    expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
    expect(screen.queryByText('断る')).toBeNull();
    fireEvent.click(screen.getByText('もう一度開く'));
    await settle();
    fireEvent.click(screen.getByText('閉じる'));
    await settle();
    expect(api.argsOf('elicitation.reply')).toEqual([
      ['s1', 'opened:u1', { kind: 'reopen' }],
      ['s1', 'opened:u1', { kind: 'dismiss' }],
    ]);
  });
});

describe('useSessionElicitations', () => {
  it('開いたセッションの質問を読み込み、知らせが来たら入れ替える。読み込みより先に来た知らせは、古い返事で上書きしない', async () => {
    let answerLoad: () => void = () => {};
    api = mockApi({ 'elicitation.get': () => new Promise((resolve) => (answerLoad = () => resolve(form()))) });
    api.install();
    const { result } = renderHook(() => useSessionElicitations('s1', null));
    expect(result.current.elicitationOf('s1')).toBeNull();
    act(() => result.current.load('s1'));
    await act(async () => answerLoad());
    expect(result.current.elicitationOf('s1')?.id).toBe('e1');
    act(() => api.emit('elicitation.onChanged', { sessionId: 's1', elicitation: url() }));
    expect(result.current.elicitationOf('s1')?.id).toBe('u1');
    act(() => result.current.load('s2'));
    act(() => api.emit('elicitation.onChanged', { sessionId: 's2', elicitation: null }));
    await act(async () => answerLoad());
    expect(result.current.elicitationOf('s2')).toBeNull();
  });
});
