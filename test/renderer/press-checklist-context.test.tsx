// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextItem } from '@shared/context';
import type { ClaudeAccount } from '@shared/account';
import type { UsageLimits } from '@shared/usage';
import { ContextMeter } from '../../src/renderer/src/knowledge/ContextMeter';
import { ContextPanel, SessionContextPanel } from '../../src/renderer/src/knowledge/ContextPanel';
import { AccountPanel } from '../../src/renderer/src/account/AccountPanel';
import { closeSettingsFilesDialog, useSettingsFilesDialogOpen } from '../../src/renderer/src/chat/settingsFiles';
import './dom';
import { mockApi } from './mock-api';

// サイドパネルの「コンテキスト」（並べ方・圧縮で置き換わったものの開け閉め）と、
// セッション一覧の下のアカウントと利用枠（押すとメニュー）。押したら表示が変わることを確かめる

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi();
  api.install();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SORT_KEY = 'tanacode.contextSort';
const item = (id: string, kind: ContextItem['kind'], label: string, tokens: number, order: number, extra: Partial<ContextItem> = {}): ContextItem => ({
  id,
  kind,
  label,
  tokens,
  order,
  compacted: false,
  ...extra,
});
const ITEMS: ContextItem[] = [
  item('t', 'topic', '税率を可変にして', 5000, 0),
  item('b', 'tool', 'npm test', 9000, 1, { tool: 'Bash' }),
  item('f', 'file', 'src/tax.ts', 3000, 2),
  item('x1', 'topic', '最初の画面を作って', 18000, -2, { compacted: true }),
  item('x2', 'file', 'src/App.tsx', 4000, -1, { compacted: true }),
];

function show(over: { items?: ContextItem[] } = {}) {
  return render(<ContextPanel context={{ items: over.items ?? ITEMS }} tokens={30_000} limit={200_000} />);
}

const labels = () => [...document.querySelectorAll('.context-list .context-label')].map((e) => e.textContent);
const row = (label: string) => screen.getByText(label, { selector: '.context-label' }).closest('.context-row') as HTMLElement;

describe('並べ方', () => {
  it('「時間順」「大きい順」で並べ替え、選んだものを覚える', () => {
    show();
    expect(labels()).toEqual(['npm test', '税率を可変にして', 'src/tax.ts']);
    fireEvent.click(screen.getByRole('tab', { name: '時間順' }));
    expect(labels()).toEqual(['税率を可変にして', 'npm test', 'src/tax.ts']);
    expect(screen.getByRole('tab', { name: '時間順' }).getAttribute('aria-selected')).toBe('true');
    expect(localStorage.getItem(SORT_KEY)).toBe('time');
    cleanup();
    show();
    expect(labels()).toEqual(['税率を可変にして', 'npm test', 'src/tax.ts']);
    fireEvent.click(screen.getByRole('tab', { name: '大きい順' }));
    expect(labels()).toEqual(['npm test', '税率を可変にして', 'src/tax.ts']);
    expect(localStorage.getItem(SORT_KEY)).toBe('size');
  });
});

describe('圧縮で置き換わったもの', () => {
  it('見出しを押すと開け閉めする', () => {
    show();
    const toggle = screen.getByText('圧縮で要約に置き換わったもの（2 件）').closest('button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('最初の画面を作って')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(row('src/App.tsx').classList.contains('compacted')).toBe(true);
    fireEvent.click(toggle);
    expect(screen.queryByText('最初の画面を作って')).toBeNull();
  });
});

describe('セッションのコンテキストを取りに行く入れ物（SessionContextPanel）と、使用量のメーター（ContextMeter）', () => {
  it('見えているときだけ、そのセッションの中身を取りに行く。一覧だけを出し、圧縮の印やボタンは出さない', async () => {
    api = mockApi({ 'context.get': () => Promise.resolve({ items: ITEMS }) });
    api.install();
    const props = { sessionId: 'ctx-session', revision: 0, tokens: 30_000, limit: 200_000 };
    const { rerender } = render(<SessionContextPanel {...props} visible={false} />);
    expect(screen.getByText('読み込み中…')).toBeTruthy();
    rerender(<SessionContextPanel {...props} visible />);
    await screen.findByText('npm test');
    expect(api.argsOf('context.get')).toEqual([['ctx-session']]);
    expect(within(row('npm test')).queryByRole('button')).toBeNull();
    expect(screen.queryByText('この選び方で圧縮…')).toBeNull();
  });

  it('メーターを押すと、中身の一覧を出す（受け手を呼ぶ）。使用量が分からなければ出さない', () => {
    const onClick = vi.fn();
    const { rerender } = render(<ContextMeter tokens={120_000} limit={200_000} onClick={onClick} />);
    fireEvent.click(screen.getByLabelText('コンテキストの中身'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('60% · 120k')).toBeTruthy();
    rerender(<ContextMeter tokens={null} limit={200_000} onClick={onClick} />);
    expect(screen.queryByLabelText('コンテキストの中身')).toBeNull();
  });
});

describe('アカウントと利用枠（AccountPanel）', () => {
  const T = Date.parse('2026-10-07T10:00:00+09:00');
  const usage = (over: Partial<UsageLimits> = {}): UsageLimits => ({
    limits: [
      { label: '5時間', percent: 42, resetsAt: T + 90 * 60_000 },
      { label: '週', percent: 95, resetsAt: T + 3 * 24 * 60 * 60_000 },
    ],
    updatedAt: T,
    source: 'statusline',
    ...over,
  });
  const TEAM: ClaudeAccount = { email: 'taro@corp.example', organization: 'Acme', plan: 'Claude Team' };
  const summary = () => screen.getByRole('button', { name: /5時間/ });
  const gauges = () => [...document.querySelectorAll('.usage-gauge')].map((g) => `${g.className}: ${g.textContent}`);
  // 設定ファイルの管理のダイアログが開いているか（App が出すダイアログの代わり）
  function DialogProbe() {
    return useSettingsFilesDialogOpen() ? <span>ダイアログ</span> : null;
  }

  it('プラン・組織・利用枠を出し、メールアドレスはマウスを乗せたときとメニューの中にだけ出す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    api = mockApi({ 'usage.get': () => Promise.resolve(usage()), 'account.get': () => Promise.resolve(TEAM) });
    api.install();
    render(<AccountPanel />);
    await screen.findByText('Claude Team');
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('あと 1時間30分')).toBeTruthy();
    expect(screen.getByText('あと 3日0時間')).toBeTruthy();
    expect(screen.queryByText('taro@corp.example')).toBeNull();
    expect(summary().title).toMatch(/^taro@corp\.example\nプランの利用枠。/);
    expect(document.querySelector('.account-stale')).toBeNull();

    // 時間がたってから押すと、残り時間と古い値の印を今の時刻で出し直し、メニューを開いてアカウントを読み直す
    vi.setSystemTime(T + 60 * 60_000);
    fireEvent.click(summary());
    expect(screen.getByText('あと 30分')).toBeTruthy();
    expect(document.querySelector('.account-stale')?.textContent).toMatch(/時点$/);
    const menu = screen.getByRole('menu', { name: 'アカウント' });
    expect(within(menu).getByText('taro@corp.example')).toBeTruthy();
    expect(within(menu).getByText('Claude Team · Acme')).toBeTruthy();
    expect(api.argsOf('account.get').length).toBe(2);

    // 読み直すと、取り直しを頼んでメニューを閉じる。届いた値で出し直す
    fireEvent.click(within(menu).getByRole('menuitem', { name: '利用枠とアカウントを読み直す' }));
    expect(api.argsOf('usage.refresh')).toEqual([[]]);
    expect(api.argsOf('account.get').length).toBe(3);
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => api.emit('usage.onChanged', usage({ limits: [{ label: '5時間', percent: 10, resetsAt: T + 61 * 60_000 }], updatedAt: T + 60 * 60_000 })));
    expect(screen.getByText('10%')).toBeTruthy();
    expect(screen.getByText('あと 1分')).toBeTruthy();
    expect(document.querySelector('.account-stale')).toBeNull();
    // 届いた値に無い枠（週）も消さず、灰色の 0% で残す
    expect(gauges()[1]).toBe('usage-gauge unknown: 週0%未取得');
    // 応答（利用枠が届く）をきっかけにアカウントを読み直すのは、前に読んでから 1 分たったときだけ
    expect(api.argsOf('account.get').length).toBe(3);
    vi.setSystemTime(T + 61 * 60_000);
    act(() => api.emit('usage.onChanged', usage({ updatedAt: T + 61 * 60_000 })));
    act(() => api.emit('usage.onChanged', usage({ updatedAt: T + 61 * 60_000 + 1 })));
    expect(api.argsOf('account.get').length).toBe(4);
    await screen.findByText('Claude Team');
  });

  it('値もログインも無くても、2 つのゲージを灰色の 0% で出しておき、押すとメニューに理由を出す', async () => {
    render(<AccountPanel />);
    await screen.findByText('ログインしていません');
    expect(gauges()).toEqual(['usage-gauge unknown: 5時間0%未取得', 'usage-gauge unknown: 週0%未取得']);
    expect(summary().title).toBe('ログインしていません\nプランの利用枠は、セッションが応答すると出ます');
    fireEvent.click(summary());
    expect(within(screen.getByRole('menu')).getByText('「ログイン…」で、このプロファイルの Claude Code にログインできます')).toBeTruthy();
    // もう一度押すと閉じる
    fireEvent.click(summary());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('リセット時刻を過ぎた枠は 0% にし、メールアドレスを含む組織の名前（個人のプラン）は欄に出さない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T + 2 * 60 * 60_000);
    const personal: ClaudeAccount = { email: 'taro@example.com', organization: "taro@example.com's Organization", plan: 'Claude Max' };
    api = mockApi({ 'usage.get': () => Promise.resolve(usage({ updatedAt: T + 2 * 60 * 60_000 })), 'account.get': () => Promise.resolve(personal) });
    api.install();
    render(<AccountPanel />);
    await screen.findByText('リセット済み');
    expect(gauges()[0]).toBe('usage-gauge low: 5時間0%リセット済み');
    expect(gauges()[1]).toBe('usage-gauge high: 週95%あと 2日22時間');
    expect(document.querySelector('.account-org')).toBeNull();
    expect(screen.queryByText(/example\.com/)).toBeNull();
    fireEvent.click(summary());
    expect(within(screen.getByRole('menu')).getByText('Claude Max')).toBeTruthy();
  });

  it('メニューから設定ファイルの管理を開く。Esc や欄の外を押すと閉じる', async () => {
    api = mockApi({ 'account.get': () => Promise.resolve(TEAM) });
    api.install();
    render(
      <>
        <AccountPanel />
        <DialogProbe />
        <p>外</p>
      </>,
    );
    await screen.findByText('Claude Team');
    fireEvent.click(summary());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(summary());
    fireEvent.mouseDown(screen.getByText('外'));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(summary());
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: '設定ファイルの管理…' })));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByText('ダイアログ')).toBeTruthy();
    act(() => closeSettingsFilesDialog());
  });
});
