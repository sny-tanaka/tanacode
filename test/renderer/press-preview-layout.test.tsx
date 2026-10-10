// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_URL, type AppUpdate } from '@shared/app-update';
import type { PullRequestLink } from '@shared/chat';
import { StatusBar } from '../../src/renderer/src/StatusBar';
import { AppUpdateMark, SEEN_KEY } from '../../src/renderer/src/layout/AppUpdate';
import { Resizer, useColumnWidths } from '../../src/renderer/src/layout/columns';
import { TitleBar } from '../../src/renderer/src/layout/TitleBar';
import { Toggle } from '../../src/renderer/src/layout/Toggle';
import { syncSharedPrefs } from '../../src/renderer/src/sharedPrefs';
import './dom';
import { mockApi } from './mock-api';

// 上の帯（TitleBar・新しいバージョンの印・通知のスイッチ）と下のバー（StatusBar）のボタン、カラムの幅のつまみを押して、効いたことを確かめる

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

  it('マウスを乗せただけでも、見たことにして動きを止める', () => {
    render(<AppUpdateMark update={update('1.3.0')} />);
    fireEvent.mouseEnter(mark('1.3.0'));
    expect(mark('1.3.0').className).not.toContain('calling');
    expect(localStorage.getItem(SEEN_KEY)).toBe('1.3.0');
    expect(opened).toEqual([]);
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

  it('Homebrew でダウンロードしている途中は、印のまま（押すと Releases のページ）。ツールチップで知らせる', () => {
    render(<AppUpdateMark update={{ ...update('1.3.0'), homebrew: { status: 'downloading' } }} />);
    expect(mark('1.3.0').dataset.tip).toContain('Homebrew でダウンロードしています');
    fireEvent.click(mark('1.3.0'));
    expect(opened).toEqual(['https://github.com/sny-tanaka/tanacode/releases/tag/v1.3.0']);
    expect(api.argsOf('appUpdate.install')).toEqual([]);
  });

  it('Homebrew でダウンロード済みなら「再起動して更新」を出し、押すと main に入れ替えを頼む', () => {
    render(<AppUpdateMark update={{ ...update('1.3.0'), homebrew: { status: 'ready', version: '1.3.0' } }} />);
    const button = screen.getByRole('button', { name: '再起動して v1.3.0 に更新' });
    expect(button.textContent).toBe('再起動して更新');
    fireEvent.click(button);
    expect(api.argsOf('appUpdate.install')).toEqual([[]]);
    expect(opened).toEqual([]);
  });

  it('最新なら押すものは出さない', () => {
    render(<AppUpdateMark update={{ latest: '1.2.0', available: false, url: '' }} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('カラムの幅のつまみ（Resizer・useColumnWidths）', () => {
  // App と同じつなぎ方（幅の CSS 変数を持つ要素に mainRef を付け、つまみで左のカラムの幅を変える）
  function Columns() {
    const columns = useColumnWidths();
    return (
      <div ref={columns.mainRef} data-testid="main" style={{ '--w-sessions': `${columns.widths.sessions}px` } as CSSProperties}>
        <span data-testid="state">{columns.widths.sessions}</span>
        <Resizer
          width={columns.widths.sessions}
          onResize={(w) => columns.resize('sessions', w)}
          onReset={() => columns.reset('sessions')}
          onEnd={columns.save}
        />
      </div>
    );
  }
  const main = () => screen.getByTestId('main');
  const state = () => Number(screen.getByTestId('state').textContent);
  const saved = () => JSON.parse(localStorage.getItem('tanacode.columns') ?? 'null') as Record<string, number> | null;
  const width = window.innerWidth;
  beforeEach(() => {
    // jsdom は押さえる（pointer capture）を持たない
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    window.innerWidth = 1600;
  });
  afterEach(() => {
    window.innerWidth = width;
  });

  it('ドラッグで幅を変え（離すまでは CSS 変数だけを書き換える）、離すと覚える', () => {
    render(<Columns />);
    const handle = screen.getByRole('separator');
    // 押していないときに動かしても変えない
    fireEvent.pointerMove(handle, { clientX: 400 });
    expect(main().style.getPropertyValue('--w-sessions')).toBe('248px');

    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 1 });
    expect(document.body.classList.contains('resizing')).toBe(true);
    fireEvent.pointerMove(handle, { clientX: 298, pointerId: 1 });
    expect(main().style.getPropertyValue('--w-sessions')).toBe('298px');
    expect(state()).toBe(248);
    expect(saved()).toBeNull();
    // いちばん広くても 440px
    fireEvent.pointerMove(handle, { clientX: 1000, pointerId: 1 });
    expect(main().style.getPropertyValue('--w-sessions')).toBe('440px');
    fireEvent.pointerUp(handle, { clientX: 1000, pointerId: 1 });
    expect(document.body.classList.contains('resizing')).toBe(false);
    expect(state()).toBe(440);
    expect(saved()).toEqual({ sessions: 440, claude: 400, side: 284 });
    // 離したあとに動かしても変えない
    fireEvent.pointerMove(handle, { clientX: 300 });
    expect(state()).toBe(440);
  });

  it('ダブルクリックで元の幅に戻して覚える。次に開いたときは覚えた幅で出す', async () => {
    localStorage.setItem('tanacode.columns', JSON.stringify({ sessions: 400 }));
    const { unmount } = render(<Columns />);
    expect(state()).toBe(400);
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(state()).toBe(248);
    await waitFor(() => expect(saved()?.sessions).toBe(248));
    unmount();
    localStorage.setItem('tanacode.columns', JSON.stringify({ sessions: 300 }));
    render(<Columns />);
    expect(main().style.getPropertyValue('--w-sessions')).toBe('300px');
  });
});

describe('プロファイルをまたいで同じにする表示設定', () => {
  function Sessions() {
    return <span data-testid="sessions">{useColumnWidths().widths.sessions}</span>;
  }
  const sessions = () => Number(screen.getByTestId('sessions').textContent);
  const UPDATE: AppUpdate = { latest: '1.3.0', available: true, url: `${REPO_URL}/releases/tag/v1.3.0` };

  it('起動したときは、この画面の値を main に渡し、main が覚えている値にそろえる（覚えていないものは、この画面の値のまま）', async () => {
    localStorage.setItem('tanacode.columns', JSON.stringify({ sessions: 300 }));
    localStorage.setItem('tanacode.scmView', 'tree');
    // 共有しないものは渡さない
    localStorage.setItem('tanacode.sessionOrderLock', '["A"]');
    api = mockApi({ 'prefs.sync': () => Promise.resolve({ 'tanacode.columns': JSON.stringify({ sessions: 360 }), 'tanacode.terminalHeight': '330' }) });
    api.install();
    await syncSharedPrefs();
    expect(api.argsOf('prefs.sync')).toEqual([[{ 'tanacode.columns': JSON.stringify({ sessions: 300 }), 'tanacode.scmView': 'tree' }]]);
    expect(localStorage.getItem('tanacode.columns')).toBe(JSON.stringify({ sessions: 360 }));
    expect(localStorage.getItem('tanacode.terminalHeight')).toBe('330');
    expect(localStorage.getItem('tanacode.scmView')).toBe('tree');
    render(<Sessions />);
    expect(sessions()).toBe(360);
  });

  it('main に聞けなくても、この画面の値で始める', async () => {
    localStorage.setItem('tanacode.columns', JSON.stringify({ sessions: 300 }));
    api = mockApi({ 'prefs.sync': () => Promise.reject(new Error('応答なし')) });
    api.install();
    await expect(syncSharedPrefs()).resolves.toBeUndefined();
    expect(localStorage.getItem('tanacode.columns')).toBe(JSON.stringify({ sessions: 300 }));
  });

  it('変えると main に渡す。ほかのプロファイルの画面で変わったら、開いたままでもその値にする', async () => {
    await syncSharedPrefs();
    render(<Sessions />);
    render(<AppUpdateMark update={UPDATE} />);
    expect(sessions()).toBe(248);
    const mark = () => document.querySelector('.app-update.available')!;
    expect(mark().classList.contains('calling')).toBe(true);

    act(() => api.emit('prefs.onChanged', { key: 'tanacode.columns', value: JSON.stringify({ sessions: 320 }) }));
    expect(sessions()).toBe(320);
    act(() => api.emit('prefs.onChanged', { key: 'tanacode.app-update.seen', value: '1.3.0' }));
    expect(mark().classList.contains('calling')).toBe(false);
    // 受け取った値は、main に送り返さない
    expect(api.argsOf('prefs.set')).toEqual([]);
    // 知らないキーは入れない
    act(() => api.emit('prefs.onChanged', { key: 'tanacode.sessionOrderLock', value: '["A"]' }));
    expect(localStorage.getItem('tanacode.sessionOrderLock')).toBeNull();
  });

  it('この画面で変えた値は、main に渡す', () => {
    render(<AppUpdateMark update={UPDATE} />);
    fireEvent.mouseEnter(document.querySelector('.app-update.available')!);
    expect(api.argsOf('prefs.set')).toEqual([[SEEN_KEY, '1.3.0']]);
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
