// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { App } from '../../src/renderer/src/App';
import { setRemoteMode } from '../../src/renderer/src/remote/mode';
import './dom';
import { mockApi } from './mock-api';

// スマホの画面の配置（App。スマホの画面で、幅が狭いとき）を押して、効いたことを確かめる。Monaco と API は作り物

vi.mock('../../src/renderer/src/editor/monaco', () => {
  const disposable = () => ({ dispose() {} });
  // 偽物に無いもの（知らせの受け手など）は、何もせず、外せるものを返す
  const lenient = <T extends object>(base: T): T =>
    new Proxy(base, {
      get: (target, key) => (key in target ? target[key as keyof T] : typeof key !== 'string' || key === 'then' ? undefined : () => disposable()),
    });
  const model = (value: string) => lenient({ getValue: () => value, getLineCount: () => value.split('\n').length, dispose() {} });
  return {
    monaco: {
      editor: {
        create: () => lenient({ createDecorationsCollection: () => ({ set() {}, clear() {} }), getModel: () => null, setModel() {}, getPosition: () => ({ lineNumber: 1, column: 1 }), getLayoutInfo: () => ({ contentWidth: 800 }) }),
        createDiffEditor: () => lenient({}),
        createModel: (text: string) => model(text),
        setTheme() {},
        colorize: (text: string) => Promise.resolve(text),
        ScrollType: { Smooth: 0, Immediate: 1 },
        OverviewRulerLane: { Left: 1 },
        MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
        ContentWidgetPositionPreference: { EXACT: 0, ABOVE: 1, BELOW: 2 },
      },
      Range: class {},
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyS: 49 },
      languages: { getLanguages: () => [] },
    },
    editorTheme: () => 'tanacode-test',
    languageFor: () => 'typescript',
    languageLabel: (id: string) => id,
  };
});

// 数える部品（モジュールごとに、名前の書き出しを包む）

const base: SessionSummary = {
  id: 's1',
  title: 'パンの話',
  cwd: '/repo',
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: true,
  state: 'working',
  mode: 'manual',
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
};
const S1 = base;
const S2: SessionSummary = { ...base, id: 's2', title: '米の話', attention: 'question' };
const S3: SessionSummary = { ...base, id: 's3', title: '塩の話', cwd: '/elsewhere', running: false, state: 'idle' };

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    'sessions.list': () => Promise.resolve([S1, S2, S3]),
    'workspace.addRecentFolder': (_id: string, folder: string) => Promise.resolve([folder]),
    'sessions.snapshot': () => Promise.resolve({ sessionId: 's1', fromSeq: 0, events: [] }),
    'workspace.info': () => Promise.resolve({ root: '/repo', name: 'repo', branch: 'main' }),
    'workspace.watchOpenFiles': () => () => {},
    'workspace.claudeSettings': () => Promise.resolve([]),
    'walkthrough.viewing': () => () => {},
    'walkthrough.list': () => Promise.resolve([]),
    'browser.asks': () => Promise.resolve([]),
    'browser.logins': () => Promise.resolve([]),
    'browser.popups': () => Promise.resolve([]),
    'browser.remembers': () => Promise.resolve([]),
    'workflows.get': () => Promise.resolve([]),
    'subagents.get': () => Promise.resolve([]),
    'tasks.bash': () => Promise.resolve([]),
    'checklist.get': () => Promise.resolve([]),
    'checklist.unread': () => Promise.resolve({}),
  });
  api.install();
  vi.stubGlobal('__APP_VERSION__', '1.0.0');
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  setRemoteMode(true);
});

afterEach(() => {
  cleanup();
  setRemoteMode(false);
  vi.unstubAllGlobals();
});

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
const app = () => document.querySelector('.app') as HTMLElement;

describe('スマホの画面の配置（App）', () => {
  it('上の帯のボタンでセッションの引き出しを開き、外を押すと閉じる。引き出しで選んだら閉じて、そのセッションを出す', async () => {
    render(<App />);
    await flush();
    expect(app().classList.contains('mobile')).toBe(true);
    expect(document.querySelector('.titlebar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    expect(app().dataset.sessionDrawer).toBe('open');
    fireEvent.click(document.querySelector('.mobile-backdrop')!);
    expect(app().dataset.sessionDrawer).toBeUndefined();
    // ボタンを押すたびに開け閉めする
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    expect(screen.getByRole('button', { name: 'セッション一覧' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    expect(app().dataset.sessionDrawer).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    fireEvent.click(screen.getAllByText('米の話')[0]);
    await flush();
    expect(app().dataset.sessionDrawer).toBeUndefined();
    expect(document.querySelector('.mobile-bar-title')!.textContent).toBe('米の話');
  });

  it('チャットの見出しのスイッチとボタンは「…」の中にまとめ、押したら閉じる。外を押しても閉じる', async () => {
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    fireEvent.click(screen.getAllByText('パンの話')[0]);
    await flush();
    const header = document.querySelector('.claude-header') as HTMLElement;
    expect(header.querySelector('.claude-header-tools')).toBeNull();
    const more = () => header.querySelector('button[aria-label="その他の操作"]') as HTMLButtonElement;
    fireEvent.click(more());
    expect(more().getAttribute('aria-expanded')).toBe('true');
    const tools = header.querySelector('.claude-header-tools') as HTMLElement;
    expect([...tools.querySelectorAll('.claude-header-tool')].map((row) => row.textContent?.trim())).toEqual(
      expect.arrayContaining(['Remote Control', '離席モード', '作業を書き出す…']),
    );
    // 中のスイッチは、Mac の見出しと同じに効く
    fireEvent.click(within(tools).getByRole('switch', { name: 'Remote Control' }));
    fireEvent.click(within(tools).getByRole('switch', { name: '離席モード' }));
    await flush();
    expect(api.argsOf('sessions.setRemoteControl')).toEqual([['s1', true]]);
    expect(api.argsOf('sessions.setAway')).toEqual([['s1', true]]);
    fireEvent.click(screen.getByRole('button', { name: '作業を書き出す…' }));
    expect(header.querySelector('.claude-header-tools')).toBeNull();
    fireEvent.click(more());
    // 中を押しても閉じない。外（チャットの所）を押すと閉じる
    fireEvent.pointerDown(header.querySelector('.claude-header-tools')!);
    expect(header.querySelector('.claude-header-tools')).not.toBeNull();
    // 外を押したら閉じるだけで、押した先（下のタブ）は押さない
    const tab = screen.getByRole('tab', { name: 'パネル' });
    fireEvent.pointerDown(tab);
    expect(header.querySelector('.claude-header-tools')).toBeNull();
    fireEvent.click(tab);
    expect(app().dataset.mobileTab).toBe('chat');
    fireEvent.click(more());
    fireEvent.click(more());
    expect(header.querySelector('.claude-header-tools')).toBeNull();
  });

  it('ワークスペースにフォルダを足すときは、Mac のダイアログの代わりに、最近使ったフォルダ（今のフォルダのほか）の一覧から選ぶ', async () => {
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    fireEvent.click(screen.getAllByText('パンの話')[0]);
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'パネル' }));
    fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }));
    const items = [...document.querySelectorAll('.context-menu button')].map((b) => b.textContent);
    expect(items).toEqual(['/elsewhere']);
    fireEvent.click([...document.querySelectorAll('.context-menu button')].find((b) => b.textContent === '/elsewhere')!);
    await flush();
    expect(api.argsOf('workspace.addRecentFolder')).toEqual([['s1', '/elsewhere']]);
    expect(api.argsOf('workspace.addFolder')).toEqual([]);
  });

  it('ほかのセッションの答え待ちは、上の帯に数を出し、チャットのタブの帯を押すとそのセッションへ移る', async () => {
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    fireEvent.click(screen.getAllByText('パンの話')[0]);
    await flush();
    expect(document.querySelector('.mobile-bar-badge')!.textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'ほかの 1 件が答えを待っています' }));
    await flush();
    expect(document.querySelector('.mobile-bar-title')!.textContent).toBe('米の話');
  });

  it('下のタブで切り替える。ターミナルのタブではターミナルを開く。新規セッションは引き出しから始め、チャットのタブに戻る', async () => {
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    fireEvent.click(screen.getAllByText('パンの話')[0]);
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'ターミナル' }));
    await flush();
    expect(app().dataset.mobileTab).toBe('terminal');
    expect((document.querySelector('.terminal-panel') as HTMLElement).hidden).toBe(false);
    // ブラウザのタブでは、真ん中の列にブラウザを出す。エディタのタブでは、ブラウザを閉じてエディタを出す
    fireEvent.click(screen.getByRole('tab', { name: 'ブラウザ' }));
    await flush();
    expect(app().dataset.mobileTab).toBe('browser');
    // スマホの画面では、Mac のアプリ内ブラウザを映す部品（開いただけでは映さない）
    expect(document.querySelector('.center .remote-browser')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'エディタ' }));
    await flush();
    expect(app().dataset.mobileTab).toBe('editor');
    // パネルの切り替えの列のブラウザで開いたら、ブラウザのタブへ移る。ブラウザを閉じたら、エディタのタブへ移る
    fireEvent.click(screen.getByRole('tab', { name: 'パネル' }));
    fireEvent.click(screen.getByRole('button', { name: 'ブラウザ' }));
    await flush();
    expect(app().dataset.mobileTab).toBe('browser');
    // ブラウザを閉じた（パネルの列のブラウザを押し直した）ら、エディタのタブへ移る
    fireEvent.click(screen.getByRole('button', { name: 'ブラウザ' }));
    await flush();
    expect(app().dataset.mobileTab).toBe('editor');
    fireEvent.click(screen.getByRole('tab', { name: 'パネル' }));
    expect(app().dataset.mobileTab).toBe('panel');
    fireEvent.click(screen.getByRole('button', { name: 'セッション一覧' }));
    fireEvent.click(screen.getAllByText('新規セッション')[0]);
    await flush();
    expect(app().dataset.mobileTab).toBe('chat');
    expect(app().dataset.sessionDrawer).toBeUndefined();
  });
});
