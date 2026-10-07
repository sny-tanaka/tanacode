// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_URL, type AppUpdate } from '@shared/app-update';
import type { PullRequestLink } from '@shared/chat';
import { StatusBar } from '../../src/renderer/src/StatusBar';
import { AppUpdateMark, SEEN_KEY } from '../../src/renderer/src/layout/AppUpdate';
import { TitleBar } from '../../src/renderer/src/layout/TitleBar';
import { Toggle } from '../../src/renderer/src/layout/Toggle';
import './dom';
import { mockApi } from './mock-api';

// 上の帯（TitleBar・新しいバージョンの印・通知のスイッチ）と下のバー（StatusBar）のボタンを押して、効いたことを確かめる

let api: ReturnType<typeof mockApi>;
let opened: string[];
beforeEach(() => {
  api = mockApi();
  api.install();
  opened = [];
  vi.spyOn(window, 'open').mockImplementation((url) => (opened.push(String(url)), null));
  vi.stubGlobal('__APP_VERSION__', '1.2.0');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('StatusBar', () => {
  const pr = (number: number): PullRequestLink => ({ number, url: `https://github.com/acme/shop/pull/${number}`, repository: 'acme/shop' });
  const bar = (props: { pr: PullRequestLink | null; onOpenScm?: () => void; branch?: string | null }) => (
    <StatusBar
      status="idle"
      exitCode={null}
      branch={props.branch ?? 'main'}
      onOpenScm={props.onOpenScm ?? (() => {})}
      pr={props.pr}
      showCursor={false}
      language={null}
      claudeVersion={undefined}
    />
  );

  it('PR の番号を押すと、アプリの中で移らずに、そのセッションの PR をふだんのブラウザで開く。PR が変わったら新しい PR を開く', () => {
    const { rerender } = render(bar({ pr: pr(12) }));
    const link = screen.getByText('PR #12');
    // preventDefault していれば、fireEvent は false を返す（アプリの画面が PR のページに移らない）
    expect(fireEvent.click(link)).toBe(false);
    expect(opened).toEqual(['https://github.com/acme/shop/pull/12']);

    rerender(bar({ pr: pr(34) }));
    fireEvent.click(screen.getByText('PR #34'));
    expect(opened).toEqual(['https://github.com/acme/shop/pull/12', 'https://github.com/acme/shop/pull/34']);

    rerender(bar({ pr: null }));
    expect(screen.queryByText(/^PR #/)).toBeNull();
  });

  it('ブランチ名を押すとソース管理を開く', () => {
    const onOpenScm = vi.fn();
    render(bar({ pr: null, onOpenScm, branch: 'feature/cart' }));
    fireEvent.click(screen.getByText('feature/cart'));
    expect(onOpenScm).toHaveBeenCalledTimes(1);
  });
});

describe('TitleBar', () => {
  it('ロゴを押すと、GitHub の tanacode のページを開く', () => {
    render(<TitleBar notifications={null} onNotificationsChange={() => {}} update={null} />);
    fireEvent.click(screen.getByLabelText('GitHub の tanacode のページを開く'));
    expect(opened).toEqual([REPO_URL]);
    expect(screen.getByText('v1.2.0')).toBeTruthy();
  });

  it('通知のスイッチは、今と逆の値で知らせる（設定を読み込むまでは出さない）', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TitleBar notifications={null} onNotificationsChange={onChange} update={null} />);
    expect(screen.queryByRole('switch')).toBeNull();
    rerender(<TitleBar notifications={true} onNotificationsChange={onChange} update={null} />);
    const bell = screen.getByRole('switch', { name: '通知' });
    expect(bell.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(bell);
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<TitleBar notifications={false} onNotificationsChange={onChange} update={null} />);
    fireEvent.click(screen.getByRole('switch', { name: '通知' }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('新しいバージョンの印（AppUpdateMark）', () => {
  const update = (latest: string): AppUpdate => ({ latest, available: true, url: `https://github.com/sny-tanaka/tanacode/releases/tag/v${latest}` });
  const mark = (latest: string) => screen.getByLabelText(`v${latest} があります`);

  it('押すと、そのバージョンの Releases のページを開き、もう動かさない（見たバージョンを覚える）', () => {
    render(<AppUpdateMark update={update('1.3.0')} />);
    expect(mark('1.3.0').className).toContain('calling');
    fireEvent.click(mark('1.3.0'));
    expect(opened).toEqual(['https://github.com/sny-tanaka/tanacode/releases/tag/v1.3.0']);
    expect(mark('1.3.0').className).not.toContain('calling');
    expect(localStorage.getItem(SEEN_KEY)).toBe('1.3.0');
  });

  it('キーボードでフォーカスしただけでも、見たことにして動きを止める', () => {
    render(<AppUpdateMark update={update('1.3.0')} />);
    fireEvent.focus(mark('1.3.0'));
    expect(mark('1.3.0').className).not.toContain('calling');
    expect(localStorage.getItem(SEEN_KEY)).toBe('1.3.0');
    expect(opened).toEqual([]);
  });

  it('さらに新しいバージョンが出たら、また動かし、押すとそのバージョンのページを開く', () => {
    localStorage.setItem(SEEN_KEY, '1.3.0');
    const { rerender } = render(<AppUpdateMark update={update('1.3.0')} />);
    expect(mark('1.3.0').className).not.toContain('calling');
    rerender(<AppUpdateMark update={update('1.4.0')} />);
    expect(mark('1.4.0').className).toContain('calling');
    fireEvent.click(mark('1.4.0'));
    expect(opened).toEqual(['https://github.com/sny-tanaka/tanacode/releases/tag/v1.4.0']);
    expect(localStorage.getItem(SEEN_KEY)).toBe('1.4.0');
  });

  it('最新なら押すものは出さない', () => {
    render(<AppUpdateMark update={{ latest: '1.2.0', available: false, url: '' }} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Toggle', () => {
  it('押すと今と逆の値で知らせる。止めている・切り替えの途中は押せない', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle label="Remote Control" on={false} onChange={onChange} />);
    const toggle = () => screen.getByRole('switch') as HTMLButtonElement;
    fireEvent.click(toggle());
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Toggle label="Remote Control" on={true} onChange={onChange} />);
    fireEvent.click(toggle());
    expect(onChange).toHaveBeenLastCalledWith(false);

    rerender(<Toggle label="Remote Control" on={true} disabled onChange={onChange} />);
    expect(toggle().disabled).toBe(true);
    fireEvent.click(toggle());
    rerender(<Toggle label="Remote Control" on={true} busy onChange={onChange} />);
    expect(toggle().disabled).toBe(true);
    fireEvent.click(toggle());
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
