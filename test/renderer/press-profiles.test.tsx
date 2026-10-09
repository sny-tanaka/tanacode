// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '@shared/account';
import type { ProfilesState } from '@shared/profile';
import { AccountPanel } from '../../src/renderer/src/account/AccountPanel';
import { ProfilesDialog } from '../../src/renderer/src/account/ProfilesDialog';
import { closeProfilesDialog, defaultClaudeDir, useProfilesDialog } from '../../src/renderer/src/account/profiles';
import './dom';
import { mockApi } from './mock-api';

// プロファイル（Claude Code のアカウントごとの環境）。アカウント欄の切り替え・ログイン・追加と管理の入口と、管理のダイアログ

const TWO: ProfilesState = {
  profiles: [
    { id: 'default', name: '会社', color: '#6d9ccf', claudeDir: null },
    { id: 'p2', name: '個人', color: '#d4835c', claudeDir: '/Users/me/.claude-me' },
  ],
  current: 'default',
  othersAttention: false,
};
const TEAM: ClaudeAccount = { email: 'taro@corp.example', organization: 'Acme', plan: 'Claude Team' };

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({ 'profiles.get': () => Promise.resolve(TWO), 'account.get': () => Promise.resolve(TEAM) });
  api.install();
});
afterEach(() => {
  cleanup();
  act(() => closeProfilesDialog());
  vi.restoreAllMocks();
});

// 開いているプロファイルの管理ダイアログ（App が出すものの代わり）
function DialogProbe() {
  const mode = useProfilesDialog();
  return mode ? <span>ダイアログ:{mode}</span> : null;
}

const summary = () => screen.getByRole('button', { name: /5時間/ });

describe('アカウント欄のプロファイル', () => {
  it('2 つ以上あれば、名前と色・ほかのアカウントの通知の点を出し、メニューから切り替える', async () => {
    render(<AccountPanel />);
    await screen.findByText('会社');
    expect(screen.getByText('Claude Team')).toBeTruthy();
    const panel = document.querySelector<HTMLElement>('.account-panel')!;
    expect(panel.classList.contains('tinted')).toBe(true);
    expect(panel.style.getPropertyValue('--profile-color')).toBe('#6d9ccf');
    expect(summary().title).toMatch(/^プロファイル: 会社\n/);
    expect(screen.queryByLabelText('別のアカウントに通知あり')).toBeNull();
    act(() => api.emit('profiles.onChanged', { ...TWO, othersAttention: true }));
    expect(screen.getByLabelText('別のアカウントに通知あり')).toBeTruthy();

    fireEvent.click(summary());
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: /会社/ }).getAttribute('aria-checked')).toBe('true');
    // 見ているプロファイルを押しても、閉じるだけ
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /会社/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(api.argsOf('profiles.switch')).toEqual([]);
    fireEvent.click(summary());
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /個人/ }));
    expect(api.argsOf('profiles.switch')).toEqual([['p2']]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('1 つだけなら、色も切り替えも出さない（今までどおりの見た目）', async () => {
    api = mockApi({ 'profiles.get': () => Promise.resolve({ ...TWO, profiles: [TWO.profiles[0]!] }), 'account.get': () => Promise.resolve(TEAM) });
    api.install();
    render(<AccountPanel />);
    await screen.findByText('Acme');
    expect(document.querySelector('.account-panel.tinted')).toBeNull();
    fireEvent.click(summary());
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'プロファイルの管理…' })).toBeNull();
  });

  it('ログイン: 今見ているもののターミナルで claude auth login を動かす。ターミナルを開けなければ理由を出す。終わったらアカウントを読み直す', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const commands: string[] = [];
    let accept = true;
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string | null; command: string; handled: boolean }>).detail;
      commands.push(`${detail.sessionId}:${detail.command}`);
      detail.handled = accept;
    };
    window.addEventListener('tanacode:run-in-terminal', listener);
    try {
      render(<AccountPanel />);
      await screen.findByText('会社');
      fireEvent.click(summary());
      fireEvent.click(screen.getByRole('menuitem', { name: 'ログインし直す…' }));
      expect(commands).toEqual(['null:claude auth login']);
      expect(alert).not.toHaveBeenCalled();
      accept = false;
      fireEvent.click(summary());
      fireEvent.click(screen.getByRole('menuitem', { name: 'ログインし直す…' }));
      expect(alert.mock.calls[0]![0]).toMatch(/ターミナルを開けるところがありません/);
      const reads = api.argsOf('account.get').length;
      act(() => api.emit('shell.onExit', { id: 'shell-1', exitCode: 0 }));
      expect(api.argsOf('account.get').length).toBe(reads + 1);
    } finally {
      window.removeEventListener('tanacode:run-in-terminal', listener);
    }
  });

  it('メニューからプロファイルの追加・管理のダイアログを開く', async () => {
    render(
      <>
        <AccountPanel />
        <DialogProbe />
      </>,
    );
    await screen.findByText('会社');
    fireEvent.click(summary());
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: 'プロファイルを追加…' })));
    expect(screen.getByText('ダイアログ:add')).toBeTruthy();
    act(() => closeProfilesDialog());
    fireEvent.click(summary());
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: 'プロファイルの管理…' })));
    expect(screen.getByText('ダイアログ:manage')).toBeTruthy();
  });
});

describe('プロファイルの管理ダイアログ', () => {
  it('名前（Enter で確定・Esc で戻す）と色を変える。標準のプロファイルは外せない', async () => {
    api = mockApi({ 'profiles.get': () => Promise.resolve(TWO), 'profiles.update': () => Promise.resolve(TWO.profiles[1]) });
    api.install();
    const onClose = vi.fn();
    render(<ProfilesDialog mode="manage" onClose={onClose} />);
    const names = await screen.findAllByLabelText('名前');
    expect(names).toHaveLength(2);
    expect(screen.getByText('~/.claude（標準）')).toBeTruthy();
    expect(screen.getByText('~/.claude-me')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '削除' })).toHaveLength(1);

    const personal = names[1] as HTMLInputElement;
    fireEvent.change(personal, { target: { value: '自分' } });
    fireEvent.keyDown(personal, { key: 'Enter' });
    fireEvent.blur(personal);
    expect(api.argsOf('profiles.update')).toEqual([['p2', { name: '自分' }]]);
    // Esc は名前を戻すだけ（ダイアログは閉じない）
    fireEvent.change(personal, { target: { value: 'やめる' } });
    fireEvent.keyDown(personal, { key: 'Escape' });
    fireEvent.blur(personal);
    expect(personal.value).toBe('個人');
    expect(onClose).not.toHaveBeenCalled();
    expect(api.argsOf('profiles.update')).toHaveLength(1);
    // 変えていなければ送らない
    fireEvent.blur(personal);
    expect(api.argsOf('profiles.update')).toHaveLength(1);

    const colors = within(screen.getAllByRole('radiogroup', { name: '色' })[1]!).getAllByRole('radio');
    fireEvent.click(colors[2]!);
    expect(api.argsOf('profiles.update')[1]).toEqual(['p2', { color: '#5fb98a' }]);
  });

  it('変えられなければ、名前を戻して理由を出す', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    api = mockApi({ 'profiles.get': () => Promise.resolve(TWO), 'profiles.update': () => Promise.reject(new Error('名前を入れてください')) });
    api.install();
    render(<ProfilesDialog mode="manage" onClose={() => {}} />);
    const personal = (await screen.findAllByLabelText('名前'))[1] as HTMLInputElement;
    fireEvent.change(personal, { target: { value: ' ' } });
    fireEvent.blur(personal);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('変えられませんでした: 名前を入れてください'));
    expect(personal.value).toBe('個人');
  });

  it('外す: 確かめてから外す。外せなければ理由を出す', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    let fail = false;
    api = mockApi({ 'profiles.get': () => Promise.resolve(TWO), 'profiles.remove': () => (fail ? Promise.reject(new Error('動いています')) : Promise.resolve()) });
    api.install();
    render(<ProfilesDialog mode="manage" onClose={() => {}} />);
    await screen.findAllByLabelText('名前');
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(confirm.mock.calls[0]![0]).toMatch(/「個人」を登録から外します。\nClaude Code の設定のフォルダ（~\/\.claude-me）/);
    expect(api.argsOf('profiles.remove')).toEqual([]);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    await vi.waitFor(() => expect(api.argsOf('profiles.remove')).toEqual([['p2']]));
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('外せませんでした: 動いています'));
  });

  it('足す: 名前からフォルダを決め、まだ使っていない色を選んでおく。足したら切り替えて閉じる', async () => {
    const onClose = vi.fn();
    api = mockApi({
      'profiles.get': () => Promise.resolve(TWO),
      'profiles.add': () => Promise.resolve({ id: 'p3', name: 'Work', color: '#5fb98a', claudeDir: '/Users/me/.claude-work' }),
      'profiles.pickDir': () => Promise.resolve('/Users/me/.claude-old'),
    });
    api.install();
    render(<ProfilesDialog mode="manage" onClose={onClose} />);
    await screen.findAllByLabelText('名前');
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    const form = document.querySelector('.profile-new') as HTMLFormElement;
    const add = within(form).getByRole('button', { name: '追加' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    // キャンセルで欄を閉じ、もう一度開く
    fireEvent.click(within(form).getByRole('button', { name: 'キャンセル' }));
    expect(document.querySelector('.profile-new')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    const name = screen.getByPlaceholderText('例: 個人');
    fireEvent.change(name, { target: { value: 'Work' } });
    const dir = screen.getByLabelText('Claude Code の設定のフォルダ') as HTMLInputElement;
    expect(dir.value).toBe('~/.claude-work');
    const formColors = within(document.querySelector('.profile-new')!).getAllByRole('radio');
    expect(formColors.find((c) => c.getAttribute('aria-checked') === 'true')?.getAttribute('aria-label')).toBe('#5fb98a');
    fireEvent.click(formColors[3]!);
    // 既にあるフォルダを選ぶ
    fireEvent.click(screen.getByRole('button', { name: '選ぶ…' }));
    await vi.waitFor(() => expect(dir.value).toBe('/Users/me/.claude-old'));
    fireEvent.change(dir, { target: { value: '~/.claude-work' } });
    fireEvent.submit(document.querySelector('.profile-new')!);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.argsOf('profiles.add')).toEqual([[{ name: 'Work', color: '#9083cf', claudeDir: '~/.claude-work' }]]);
    expect(api.argsOf('profiles.switch')).toEqual([['p3']]);
  });

  it('足せなければ理由を出して、欄はそのまま。選ぶのをやめたら、フォルダは変えない', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    api = mockApi({
      'profiles.get': () => Promise.resolve(TWO),
      'profiles.add': () => Promise.reject(new Error('ほかのプロファイルと同じフォルダです')),
      'profiles.pickDir': () => Promise.resolve(null),
    });
    api.install();
    const onClose = vi.fn();
    render(<ProfilesDialog mode="add" onClose={onClose} />);
    await screen.findAllByLabelText('名前');
    fireEvent.change(screen.getByPlaceholderText('例: 個人'), { target: { value: '検証' } });
    expect((screen.getByLabelText('Claude Code の設定のフォルダ') as HTMLInputElement).value).toBe('~/.claude-profile-2');
    fireEvent.click(screen.getByRole('button', { name: '選ぶ…' }));
    await vi.waitFor(() => expect(api.argsOf('profiles.pickDir')).toHaveLength(1));
    expect((screen.getByLabelText('Claude Code の設定のフォルダ') as HTMLInputElement).value).toBe('~/.claude-profile-2');
    fireEvent.click(within(document.querySelector('.profile-new')!).getByRole('button', { name: '追加' }));
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('追加できませんでした: ほかのプロファイルと同じフォルダです'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc・ダイアログの外を押すと閉じる（日本語の変換中の Esc では閉じない）', async () => {
    const onClose = vi.fn();
    render(<ProfilesDialog mode="manage" onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'プロファイル' });
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('足すときのフォルダの既定', () => {
  it('英数字の名前なら ~/.claude-<名前>。使っていれば・英数字でなければ ~/.claude-profile-<番号>', () => {
    expect(defaultClaudeDir('My Work', [null])).toBe('~/.claude-my-work');
    expect(defaultClaudeDir('個人', [null])).toBe('~/.claude-profile-2');
    expect(defaultClaudeDir('work', [null, '/Users/me/.claude-work', '/Users/me/.claude-profile-2'])).toBe('~/.claude-profile-3');
  });
});
