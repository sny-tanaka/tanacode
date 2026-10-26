// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import type { PendingPermission, PendingQuestion } from '@shared/questions';
import { matchShortcut, type PressedKey, type Shortcut } from '@shared/shortcuts';
import { columnShortcut, useShortcutKeys, useShortcuts } from '../../src/renderer/src/layout/shortcuts';
import { MenuCard } from '../../src/renderer/src/screen/MenuCard';
import { QuestionCard } from '../../src/renderer/src/screen/QuestionCard';
import { Sidebar } from '../../src/renderer/src/sessions/Sidebar';
import './dom';
import { pressTab, tabStops } from './keys';
import { mockApi } from './mock-api';

// メニューバーの「移動」のショートカット（layout/shortcuts.ts）を、キーとメニュー（main からの知らせ）の両方から押して確かめる。
// あわせて、マウスで使ったときの動き（押したあとのフォーカス・数字のキー）が変わらないことも確かめる

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  localStorage.clear();
  api = mockApi();
  api.install();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// App と同じく、キーを受けて、カラムの間の移動を受け持つ。ran: どこも受けなかったショートカット
function Keys({ children, ran = [] }: { children?: ReactNode; ran?: Shortcut[] }) {
  useShortcutKeys();
  useShortcuts((shortcut) => {
    if (columnShortcut(shortcut)) return true;
    ran.push(shortcut);
    return true;
  });
  return <>{children}</>;
}

// アプリの画面で押したキー（ウインドウに届く）。fireEvent は、止められたら false を返す
const press = (init: KeyboardEventInit, target: Element = document.activeElement ?? document.body) => fireEvent.keyDown(target, init);
const cmd = (code: string, key: string, extra: KeyboardEventInit = {}) => press({ code, key, metaKey: true, ...extra });
// メニューを押した・アプリ内ブラウザのページで押した（main からの知らせ。画面にはキーが届かない）
const viaMain = (shortcut: Shortcut) => act(() => api.emit('shortcuts.onRun', shortcut));
// マウスで押した（このあとのフォーカスは :focus-visible にならない）。
// jsdom（の :focus-visible の見分け）は、mousedown をマウスの操作と見る。見分けるものは、はじめて :focus-visible を調べたときに
// イベントを聞き始めるので、先に一度調べておく（でないと、ファイルの中でこのテストだけを流したときに、マウスで押したことが伝わらない）
const mouse = () => {
  document.body.matches(':focus-visible');
  fireEvent.pointerDown(document.body);
  fireEvent.mouseDown(document.body);
};

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: `セッション ${id}`,
  cwd: `/work/${id}`,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: false,
  state: null,
  mode: null,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
  parentId: null,
  ...over,
});

describe('キーの見分け方（shared/shortcuts.ts）', () => {
  const key = (over: Partial<PressedKey>): PressedKey => ({ code: '', key: '', meta: false, ctrl: false, shift: false, alt: false, ...over });

  it('修飾キーが過不足なく同じときだけ当てる。⌥ を足したものは当てない', () => {
    expect(matchShortcut(key({ code: 'KeyJ', key: 'j', meta: true }))).toBe('toggleTerminal');
    expect(matchShortcut(key({ code: 'KeyJ', key: 'j', meta: true, shift: true }))).toBeNull();
    expect(matchShortcut(key({ code: 'KeyJ', key: 'j', meta: true, alt: true }))).toBeNull();
    expect(matchShortcut(key({ code: 'KeyJ', key: 'j', ctrl: true }))).toBeNull();
    expect(matchShortcut(key({ key: 'Tab', code: 'Tab', ctrl: true }))).toBe('nextTab');
    expect(matchShortcut(key({ key: 'Tab', code: 'Tab', ctrl: true, shift: true }))).toBe('previousTab');
    expect(matchShortcut(key({ key: 'Tab', code: 'Tab' }))).toBeNull();
    expect(matchShortcut(key({ key: 'ArrowUp', code: 'ArrowUp', meta: true, ctrl: true }))).toBe('previousSession');
    expect(matchShortcut(key({ key: 'ArrowUp', code: 'ArrowUp', meta: true }))).toBeNull();
    expect(matchShortcut(key({ code: 'KeyA', key: 'A', meta: true, shift: true }))).toBe('focusQuestion');
  });

  it('英字・数字は、キーの場所（code）で見る。かな入力で、出る文字が違っても効く', () => {
    expect(matchShortcut(key({ code: 'Digit1', key: 'ぬ', meta: true }))).toBe('focusSessions');
    expect(matchShortcut(key({ code: 'KeyW', key: 'て', meta: true }))).toBe('closeTab');
  });
});

describe('キーの受け方', () => {
  it('ショートカットのキーは、フォーカスのある部品（入力欄・エディタ・ターミナル）に渡さない。ほかのキーは渡す', () => {
    const ran: Shortcut[] = [];
    render(
      <Keys ran={ran}>
        <textarea aria-label="欄" />
      </Keys>,
    );
    const field = screen.getByLabelText('欄');
    const got = vi.fn();
    field.addEventListener('keydown', got);
    field.focus();
    expect(cmd('KeyW', 'w')).toBe(false);
    expect(got).not.toHaveBeenCalled();
    expect(press({ code: 'KeyW', key: 'w' })).toBe(true);
    expect(cmd('KeyC', 'c')).toBe(true);
    expect(got).toHaveBeenCalledTimes(2);
    expect(ran).toEqual(['closeTab']);
  });

  it('メニューを押した・アプリ内ブラウザのページで押した知らせでも動かす', () => {
    const ran: Shortcut[] = [];
    render(<Keys ran={ran} />);
    viaMain('nextTab');
    viaMain('toggleTerminal');
    expect(ran).toEqual(['nextTab', 'toggleTerminal']);
  });

  it('押し続けたとき、タブ・セッションの送りはくり返し、開け閉め・フォーカスの移動・タブを閉じるはくり返さない（続けて閉じない）', () => {
    const ran: Shortcut[] = [];
    render(<Keys ran={ran} />);
    cmd('KeyJ', 'j', { repeat: true });
    cmd('Digit2', '2', { repeat: true });
    press({ key: 'Tab', code: 'Tab', ctrlKey: true, repeat: true });
    cmd('KeyW', 'w', { repeat: true });
    expect(ran).toEqual(['nextTab']);
  });

  it('ダイアログを開いている間は、何もしない（後ろの画面を動かさない）', () => {
    const ran: Shortcut[] = [];
    render(
      <Keys ran={ran}>
        <div className="overlay" />
      </Keys>,
    );
    expect(cmd('KeyW', 'w')).toBe(false);
    viaMain('closeTab');
    expect(ran).toEqual([]);
  });

  it('日本語の変換中のキーは、変換に使う', () => {
    const ran: Shortcut[] = [];
    render(<Keys ran={ran} />);
    expect(press({ key: 'Tab', code: 'Tab', ctrlKey: true, isComposing: true })).toBe(true);
    expect(ran).toEqual([]);
  });
});

describe('⌘1（セッション一覧）・⌃⌘↑↓（前後のセッション）', () => {
  type Props = ComponentProps<typeof Sidebar>;
  const props = (sessions: SessionSummary[], over: Partial<Props> = {}): Props => ({
    sessions,
    selectedId: null,
    statusOf: () => 'idle',
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onImport: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    scheduled: [],
    ...over,
  });
  const row = (title: string) => screen.getByText(title).closest<HTMLElement>('.session-row')!;
  const sessions = [session('A', { title: '一' }), session('B', { title: '二' }), session('C', { title: '三' })];

  it('⌘1 で、選んでいる行へフォーカスを移す。キーで入ったときと同じく、枠とホバーで出るボタンを出す', () => {
    render(
      <Keys>
        <Sidebar {...props(sessions, { selectedId: 'B' })} />
      </Keys>,
    );
    cmd('Digit1', '1');
    expect(document.activeElement).toBe(row('二'));
    expect(row('二').dataset.keyFocus).toBe('');
  });

  it('アプリ内ブラウザのページで押したとき（画面にキーが届かない）も、行にフォーカスを残し、枠を出す', () => {
    render(
      <Keys>
        <Sidebar {...props(sessions, { selectedId: 'C' })} />
      </Keys>,
    );
    mouse();
    viaMain('focusSessions');
    expect(document.activeElement).toBe(row('三'));
    expect(row('三').dataset.keyFocus).toBe('');
    // マウスで押した行には、これまでどおりフォーカスを残さない
    act(() => row('三').blur());
    expect(row('三').dataset.keyFocus).toBeUndefined();
    mouse();
    act(() => row('一').focus());
    expect(document.activeElement).toBe(document.body);
  });

  it('選んでいる子を畳んで隠していれば、その親の行へ。選んでいなければ先頭の行へ。セッションが無ければ何もしない', () => {
    const view = render(
      <Keys>
        <Sidebar {...props([session('P', { title: '親' }), session('K', { title: '子', parentId: 'P' })], { selectedId: 'K' })} />
      </Keys>,
    );
    fireEvent.click(screen.getByRole('button', { name: '子セッションを畳む' }));
    cmd('Digit1', '1');
    expect(document.activeElement).toBe(row('親'));
    view.rerender(
      <Keys>
        <Sidebar {...props(sessions)} />
      </Keys>,
    );
    act(() => (document.activeElement as HTMLElement).blur());
    cmd('Digit1', '1');
    expect(document.activeElement).toBe(row('一'));
    view.rerender(
      <Keys>
        <Sidebar {...props([])} />
      </Keys>,
    );
    act(() => (document.activeElement as HTMLElement).blur());
    cmd('Digit1', '1');
    expect(document.activeElement).toBe(document.body);
  });

  it('⌃⌘↓・⌃⌘↑ で、一覧の並びの次・前の行を選ぶ。端では止まり、選んでいなければ先頭を選ぶ', () => {
    const p = props(sessions, { selectedId: 'B' });
    const view = render(
      <Keys>
        <Sidebar {...p} />
      </Keys>,
    );
    const down = () => press({ key: 'ArrowDown', code: 'ArrowDown', metaKey: true, ctrlKey: true });
    const up = () => press({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true, ctrlKey: true });
    down();
    up();
    expect(vi.mocked(p.onSelect).mock.calls).toEqual([['C'], ['A']]);
    view.rerender(
      <Keys>
        <Sidebar {...props(sessions, { selectedId: 'C', onSelect: p.onSelect })} />
      </Keys>,
    );
    down();
    expect(p.onSelect).toHaveBeenCalledTimes(2);
    view.rerender(
      <Keys>
        <Sidebar {...props(sessions, { onSelect: p.onSelect })} />
      </Keys>,
    );
    viaMain('previousSession');
    expect(vi.mocked(p.onSelect).mock.calls.at(-1)).toEqual(['A']);
  });
});

describe('⌘2（チャット）・⌘3（サイドパネル）', () => {
  it('⌘2 で、チャットの入力欄へ。ターミナルモード（入力欄を隠している）なら、Claude Code の画面へ', () => {
    const view = render(
      <Keys>
        <div className="main">
          <section className="claude">
            <div className="chat-input-wrap">
              <div className="chat-input-row">
                <textarea aria-label="入力欄" />
              </div>
            </div>
          </section>
        </div>
      </Keys>,
    );
    cmd('Digit2', '2');
    expect(document.activeElement).toBe(screen.getByLabelText('入力欄'));
    view.rerender(
      <Keys>
        <div className="main">
          <section className="claude">
            <div className="claude-screen">
              <textarea className="xterm-helper-textarea" aria-label="画面" />
            </div>
            <div className="chat-input-wrap" hidden>
              <div className="chat-input-row">
                <textarea aria-label="入力欄" />
              </div>
            </div>
          </section>
        </div>
      </Keys>,
    );
    viaMain('focusChat');
    expect(document.activeElement).toBe(screen.getByLabelText('画面'));
  });

  it('⌘3 で、開いているパネルの選んでいる行へ。無ければ最初に止まれるところへ。パネルが無ければ何もしない', () => {
    const view = render(
      <Keys>
        <aside className="explorer">
          <div className="side-body" hidden>
            <button>隠れたパネル</button>
          </div>
          <div className="side-body">
            <div className="tree" data-key-list="first">
              <div className="tree-row" tabIndex={-1} data-key-row="" aria-label="README.md" />
              <div className="tree-row active" tabIndex={-1} data-key-row="" aria-label="main.ts" />
            </div>
          </div>
        </aside>
      </Keys>,
    );
    cmd('Digit3', '3');
    expect(document.activeElement).toBe(screen.getByLabelText('main.ts'));
    view.rerender(
      <Keys>
        <aside className="explorer">
          <div className="side-body">
            <button disabled>押せない</button>
            <input aria-label="検索" />
          </div>
        </aside>
      </Keys>,
    );
    cmd('Digit3', '3');
    expect(document.activeElement).toBe(screen.getByLabelText('検索'));
    view.rerender(<Keys />);
    cmd('Digit3', '3');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('⌘⇧A（待っている質問・許可のカード）と 1〜9', () => {
  const question: PendingQuestion = {
    id: 'q1',
    answered: {},
    questions: [{ question: '書き方は？', header: '書き方', multiSelect: false, options: [{ label: 'です・ます', description: '' }, { label: 'だ・である', description: '' }] }],
  };
  const inChat = (card: ReactNode) => (
    <Keys>
      <div className="main">
        <section className="claude">{card}</section>
      </div>
    </Keys>
  );
  const card = () => document.querySelector<HTMLElement>('[data-answer-card]')!;
  const option = (label: string) => screen.getByText(label).closest<HTMLButtonElement>('button')!;
  const focusCard = () => cmd('KeyA', 'a', { shiftKey: true });
  // 頭に出している番号（data-key-number）
  const numbers = () => [...document.querySelectorAll<HTMLElement>('[data-key-number]')].map((el) => el.dataset.keyNumber);

  it('⌘⇧A で、カードそのものへフォーカスを移す。続けて Enter を押しても答えにならない', async () => {
    render(inChat(<QuestionCard sessionId="s1" question={question} />));
    expect(card().hasAttribute('tabindex')).toBe(false);
    focusCard();
    // 枠を出す（:focus-visible にならないときは data-key-focus で。global.css）
    expect(document.activeElement).toBe(card());
    expect(card().matches(':focus-visible, [data-key-focus]')).toBe(true);
    press({ key: 'Enter', code: 'Enter' });
    await act(async () => {});
    expect(api.argsOf('question.reply')).toEqual([]);
  });

  it('カードに入っている間、数字でその番号の選択肢へフォーカスを移すだけ（答えない）。選択肢の無い番号では何もしない', async () => {
    render(inChat(<QuestionCard sessionId="s1" question={question} />));
    focusCard();
    // キーで入っている間は、選択肢の頭に番号を出す（選択肢の data-key-number。global.css）
    expect(numbers()).toEqual(['1', '2']);
    expect(press({ key: '2', code: 'Digit2' })).toBe(false);
    expect(document.activeElement).toBe(option('だ・である'));
    expect(numbers()).toEqual(['1', '2']);
    press({ key: '1', code: 'Digit1' });
    expect(document.activeElement).toBe(option('です・ます'));
    press({ key: '9', code: 'Digit9' });
    expect(document.activeElement).toBe(option('です・ます'));
    await act(async () => {});
    expect(api.argsOf('question.reply')).toEqual([]);
    // カードから外れたら、フォーカスのために付けた tabindex を外す（マウスで押してもカードにフォーカスが入らないまま）
    expect(card().hasAttribute('tabindex')).toBe(false);
  });

  it('カードの中の入力欄で打った数字は、文字として入れる', () => {
    render(inChat(<QuestionCard sessionId="s1" question={question} />));
    focusCard();
    const field = screen.getByRole('textbox');
    act(() => field.focus());
    expect(press({ key: '2', code: 'Digit2' })).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  // 直す前: 入力欄はマウスで押しても :focus-visible になるので、キーで入ったと見て、選択肢に番号を出していた
  it('マウスでカードの入力欄を押しても、番号を出さない（質問のカードの自由に書ける欄・許可のカードの理由の欄）', () => {
    const permission: PendingPermission = { id: 'p1', tool: 'Bash', title: 'Bash', description: '', input: { command: 'ls' }, reason: null, always: null, plan: null, agent: null };
    const view = render(inChat(<QuestionCard sessionId="s1" question={question} />));
    mouse();
    act(() => screen.getByRole('textbox').focus());
    expect(screen.getByRole('textbox').matches(':focus-visible')).toBe(true);
    expect(numbers()).toEqual([]);
    expect(press({ key: '2', code: 'Digit2' })).toBe(true);
    // 許可のカードの「断って、理由を伝える」は、理由の欄（autoFocus）を開く
    view.rerender(inChat(<MenuCard sessionId="s1" permission={permission} />));
    mouse();
    fireEvent.click(screen.getByText(/^断って、理由を伝える/));
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    expect(numbers()).toEqual([]);
  });

  it('選択肢で Tab で止まるのは 1 つだけ。↑↓・Home・End で選択肢を移り（答えない）、数字のキーも効く。Enter で答える', async () => {
    render(inChat(<QuestionCard sessionId="s1" question={question} />));
    pressTab();
    expect(tabStops()).toEqual([option('です・ます')]);
    focusCard();
    press({ key: '1', code: 'Digit1' });
    expect(press({ key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(option('だ・である'));
    // 番号は出したまま
    expect(numbers()).toEqual(['1', '2']);
    press({ key: 'Home', code: 'Home' });
    expect(document.activeElement).toBe(option('です・ます'));
    press({ key: 'End', code: 'End' });
    expect(document.activeElement).toBe(option('だ・である'));
    press({ key: '1', code: 'Digit1' });
    expect(document.activeElement).toBe(option('です・ます'));
    await act(async () => {});
    expect(api.argsOf('question.reply')).toEqual([]);
    // 一覧から出て戻ると、前にいた選択肢に止まる
    pressTab();
    expect(tabStops()).toEqual([option('です・ます')]);
  });

  it('マウスで選択肢を押したあと（キーで入っていない）は、↑↓ で移らない（直す前と同じ）', () => {
    render(inChat(<QuestionCard sessionId="s1" question={{ ...question, questions: [{ ...question.questions[0], multiSelect: true }] }} />));
    mouse();
    act(() => option('です・ます').focus());
    fireEvent.click(option('です・ます'));
    expect(press({ key: 'ArrowDown', code: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(option('です・ます'));
  });

  it('マウスで選択肢を押したあと（キーで入っていない）は、数字で移らない（直す前と同じ）', () => {
    render(inChat(<QuestionCard sessionId="s1" question={{ ...question, questions: [{ ...question.questions[0], multiSelect: true }] }} />));
    mouse();
    act(() => option('です・ます').focus());
    fireEvent.click(option('です・ます'));
    expect(press({ key: '2', code: 'Digit2' })).toBe(true);
    expect(document.activeElement).toBe(option('です・ます'));
    expect(numbers()).toEqual([]);
  });

  it('アプリ内ブラウザのページで押したとき（画面にキーが届かない）も、カードに入り、数字で選択肢へ移れる', () => {
    render(inChat(<QuestionCard sessionId="s1" question={question} />));
    mouse();
    viaMain('focusQuestion');
    expect(document.activeElement).toBe(card());
    expect(card().dataset.keyFocus).toBe('');
    press({ key: '2', code: 'Digit2' });
    expect(document.activeElement).toBe(option('だ・である'));
    expect(card().dataset.keyFocus).toBeUndefined();
  });

  it('許可のカードにも入れる。カードが無い・隠れている（ターミナルモード）ときは何もしない', () => {
    const permission: PendingPermission = { id: 'p1', tool: 'Bash', title: 'Bash', description: '', input: { command: 'ls' }, reason: null, always: null, plan: null, agent: null };
    const view = render(inChat(<MenuCard sessionId="s1" permission={permission} />));
    focusCard();
    expect(document.activeElement).toBe(card());
    press({ key: '1', code: 'Digit1' });
    expect(document.activeElement).toBe(document.querySelectorAll('.menu-options > .menu-option')[0]);
    view.rerender(inChat(<div hidden><QuestionCard sessionId="s1" question={question} /></div>));
    act(() => (document.activeElement as HTMLElement).blur());
    focusCard();
    expect(document.activeElement).toBe(document.body);
  });
});
