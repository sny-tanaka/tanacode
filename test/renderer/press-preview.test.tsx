// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAskChange } from '@shared/ipc';
import { useInsertInput } from '../../src/renderer/src/chat/insertInput';
import { BrowserHostsDialog } from '../../src/renderer/src/preview/BrowserHostsDialog';
import { PreviewPane } from '../../src/renderer/src/preview/PreviewPane';
import { CANCEL_PICKER_SCRIPT, describePicked, type PickedElement } from '../../src/renderer/src/preview/picker';
import './dom';
import { mockApi } from './mock-api';

// アプリ内ブラウザ（PreviewPane）と、Claude に許す先のダイアログ（BrowserHostsDialog）のボタン・入力を押して、効いたことを確かめる。
// jsdom には Electron の <webview> が無いので、作られた webview の要素に、押したことを控えるだけの操作（戻る・読み込み直すなど）を足す

type FakeWebview = HTMLElement & {
  src: string;
  // 押された操作（goBack・reload など）
  log: string[];
  canBack: boolean;
  canForward: boolean;
  // executeJavaScript に渡されたもの（コードと、ユーザーの操作として動かすか）
  scripts: [string, boolean | undefined][];
  // executeJavaScript の返事（決めていなければ null）
  answer: (code: string) => Promise<unknown>;
  captured: unknown[];
};

let webviews: FakeWebview[];
let api: ReturnType<typeof mockApi>;
// チャットの入力欄に差し込まれたもの（どのセッションの入力欄か）
let inserted: { sessionId: string; text: string; attachments: string[] }[];
const createElement = document.createElement.bind(document);

function fakeWebview(element: HTMLElement): FakeWebview {
  const wv = element as FakeWebview;
  Object.assign(wv, {
    log: [],
    canBack: false,
    canForward: false,
    scripts: [],
    captured: [],
    answer: () => Promise.resolve(null),
    goBack: () => wv.log.push('goBack'),
    goForward: () => wv.log.push('goForward'),
    reload: () => wv.log.push('reload'),
    stop: () => wv.log.push('stop'),
    canGoBack: () => wv.canBack,
    canGoForward: () => wv.canForward,
    getURL: () => wv.src,
    focus: () => wv.log.push('focus'),
    openDevTools: () => wv.log.push('openDevTools'),
    getWebContentsId: () => 1,
    executeJavaScript: (code: string, userGesture?: boolean) => {
      wv.scripts.push([code, userGesture]);
      return wv.answer(code);
    },
    capturePage: (rect: unknown) => {
      wv.captured.push(rect);
      return Promise.resolve({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' });
    },
  });
  return wv;
}

beforeEach(() => {
  webviews = [];
  inserted = [];
  api = mockApi({
    'browser.asks': () => Promise.resolve([]),
    'attachments.save': (name: never) => Promise.resolve(`/tmp/attachments/0123abcd-${name as string}`),
  });
  api.install();
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options);
    if (tag === 'webview') webviews.push(fakeWebview(element));
    return element;
  }) as typeof document.createElement);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// チャットの入力欄の代わり（差し込みを受け取る側のフック。セッションごとに受け取る）
function Inbox({ sessionId }: { sessionId: string }) {
  useInsertInput(sessionId, (text, attachments) => inserted.push({ sessionId, text, attachments }));
  return null;
}

function Pane({ sessionId, visible = true, live = ['s1', 's2'], onClose = () => {} }: { sessionId: string | null; visible?: boolean; live?: string[]; onClose?: () => void }) {
  return (
    <>
      <PreviewPane sessionId={sessionId} visible={visible} liveSessionIds={live} onClose={onClose} />
      <Inbox sessionId="s1" />
      <Inbox sessionId="s2" />
    </>
  );
}

const address = () => screen.getByLabelText('開く URL') as HTMLInputElement;
const button = (label: string) => screen.getByLabelText(label) as HTMLButtonElement;
// アドレス欄に打って Enter
function go(text: string) {
  fireEvent.change(address(), { target: { value: text } });
  fireEvent.submit(address().closest('form')!);
}
// webview の知らせ（did-navigate など）を送る
function fire(wv: FakeWebview, type: string, detail: Record<string, unknown> = {}) {
  act(() => {
    wv.dispatchEvent(Object.assign(new Event(type), detail));
  });
}
// 読み込みが終わったことにする（戻る・進むの可否も読み直す）
const loaded = (wv: FakeWebview) => fire(wv, 'did-stop-loading');
const tabs = () => screen.queryAllByRole('tab');
const activated = () => api.argsOf('browser.activate');

describe('PreviewPane: アドレス欄と表示幅', () => {
  it('URL を打って Enter で、そのセッションのタブを開く。開いたあとは同じタブで移る。書き方の違う URL では開かない', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('ftp://example.test');
    go('   ');
    expect(webviews).toEqual([]);

    go('localhost:3000');
    expect(webviews).toHaveLength(1);
    expect(webviews[0].src).toBe('http://localhost:3000/');
    expect(activated()).toEqual([['s1', expect.stringMatching(/^tab-/)]]);
    expect(tabs().map((t) => t.textContent)).toEqual(['localhost:3000/']);

    go('https://example.test/docs');
    expect(webviews).toHaveLength(1);
    expect(webviews[0].src).toBe('https://example.test/docs');
    loaded(webviews[0]);
    expect(address().value).toBe('https://example.test/docs');
  });

  it('表示幅を選ぶと、そのセッションのページの枠をその幅にする（ほかのセッションは全幅のまま）', async () => {
    const { container, rerender } = render(<Pane sessionId="s1" />);
    await act(async () => {});
    const select = screen.getByTitle('表示幅') as HTMLSelectElement;
    const body = () => container.querySelector('.preview-body') as HTMLElement;
    fireEvent.change(select, { target: { value: '390' } });
    expect(select.value).toBe('390');
    expect(body().className).toContain('framed');
    expect(body().style.getPropertyValue('--preview-width')).toBe('390px');

    rerender(<Pane sessionId="s2" />);
    expect(select.value).toBe('0');
    expect(body().className).not.toContain('framed');
    fireEvent.change(select, { target: { value: '768' } });
    expect(body().style.getPropertyValue('--preview-width')).toBe('768px');

    rerender(<Pane sessionId="s1" />);
    expect(select.value).toBe('390');
  });
});

describe('PreviewPane: ツールバーのボタン', () => {
  it('戻る・進むは、戻れる・進めるときだけ押せて、今のタブのページを戻す・進める', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    const wv = webviews[0];
    loaded(wv);
    expect(button('戻る').disabled).toBe(true);
    expect(button('進む').disabled).toBe(true);

    wv.canBack = true;
    fire(wv, 'did-navigate');
    expect(button('戻る').disabled).toBe(false);
    fireEvent.click(button('戻る'));
    expect(wv.log).toEqual(['goBack']);

    wv.canForward = true;
    fire(wv, 'did-navigate-in-page');
    fireEvent.click(button('進む'));
    expect(wv.log).toEqual(['goBack', 'goForward']);
  });

  it('読み込み中は「読み込みを止める」で止め、読み込んだあとは「読み込み直す」で読み込み直す', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    const wv = webviews[0];
    fireEvent.click(button('読み込みを止める'));
    expect(wv.log).toEqual(['stop']);
    loaded(wv);
    fireEvent.click(button('読み込み直す'));
    expect(wv.log).toEqual(['stop', 'reload']);
    fire(wv, 'did-start-loading');
    expect(button('読み込みを止める')).toBeTruthy();
  });

  it('ふだんのブラウザで開く・開発者ツールは、今のページに効く。何も開いていなければ押せない', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    expect(button('ふだんのブラウザで開く').disabled).toBe(true);
    expect(button('開発者ツール').disabled).toBe(true);
    go('localhost:3000/login');
    const wv = webviews[0];
    loaded(wv);
    fireEvent.click(button('ふだんのブラウザで開く'));
    expect(api.argsOf('browser.openExternal')).toEqual([['http://localhost:3000/login']]);
    fireEvent.click(button('開発者ツール'));
    expect(wv.log).toEqual(['openDevTools']);
  });

  it('読み込めなかったときは理由と「もう一度」を出し、押すと読み込み直す（別のページへ移ったための中断は出さない）', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    const wv = webviews[0];
    fire(wv, 'did-fail-load', { errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true, validatedURL: 'http://localhost:3000/' });
    expect(screen.queryByLabelText('もう一度')).toBeNull();
    fire(wv, 'did-fail-load', { errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', isMainFrame: true, validatedURL: 'http://localhost:3000/' });
    expect(screen.getByText('http://localhost:3000/ を読み込めませんでした（ERR_CONNECTION_REFUSED）')).toBeTruthy();
    fireEvent.click(button('もう一度'));
    expect(wv.log).toEqual(['reload']);
    fire(wv, 'did-start-loading');
    expect(screen.queryByLabelText('もう一度')).toBeNull();
  });

  it('コンソールのエラーの数を出し、押すとエラーをチャットの入力欄に貼って数を消す', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    const wv = webviews[0];
    loaded(wv);
    fire(wv, 'console-message', { level: 1, message: 'ただの記録' });
    expect(screen.queryByLabelText(/^エラー/)).toBeNull();
    fire(wv, 'console-message', { level: 3, message: 'TypeError: x is undefined', sourceId: 'http://localhost:3000/src/app.js', line: 12 });
    fire(wv, 'console-message', { level: 'error', message: '```壊れた```' });
    fireEvent.click(button('エラー 2 件'));
    expect(inserted).toEqual([
      {
        sessionId: 's1',
        text: 'アプリ内ブラウザ（http://localhost:3000/）のコンソールに出たエラー:\n````\nTypeError: x is undefined (/src/app.js:12)\n```壊れた```\n````\n',
        attachments: [],
      },
    ]);
    expect(screen.queryByLabelText(/^エラー/)).toBeNull();
  });

  it('要素を選ぶ: ページで選んだ要素の説明と、まわりの画像をチャットの入力欄に添える', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    const wv = webviews[0];
    loaded(wv);
    const picked: PickedElement = {
      url: 'http://localhost:3000/',
      selector: 'button.buy',
      text: '購入',
      html: '<button class="buy">購入</button>',
      rect: { x: 100, y: 50, width: 200, height: 40 },
      viewport: { width: 1000, height: 800 },
    };
    let choose!: (p: PickedElement | null) => void;
    wv.answer = () => new Promise((resolve) => (choose = resolve));
    fireEvent.click(button('要素を選ぶ'));
    expect(button('選ぶのをやめる').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('ページの要素をクリックしてください（Esc でやめる）')).toBeTruthy();
    expect(wv.log).toEqual(['focus']);
    expect(wv.scripts).toEqual([[expect.stringContaining('__tanacodePickCancel'), true]]);

    await act(async () => choose(picked));
    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(wv.captured).toEqual([{ x: 92, y: 42, width: 216, height: 56 }]);
    expect(api.argsOf('attachments.save').map(([name]) => name)).toEqual(['preview-element.png']);
    expect(inserted).toEqual([{ sessionId: 's1', text: describePicked(picked), attachments: ['/tmp/attachments/0123abcd-preview-element.png'] }]);
    expect(button('要素を選ぶ').getAttribute('aria-pressed')).toBe('false');
  });

  it('要素を選んでいる間にもう一度押すと、選ぶのをやめる（ページの選ぶ仕掛けも止める）', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    const wv = webviews[0];
    loaded(wv);
    let choose!: (p: PickedElement | null) => void;
    wv.answer = (code) => (code === CANCEL_PICKER_SCRIPT ? Promise.resolve(undefined) : new Promise((resolve) => (choose = resolve)));
    fireEvent.click(button('要素を選ぶ'));
    fireEvent.click(button('選ぶのをやめる'));
    expect(wv.scripts.map(([code]) => code).at(-1)).toBe(CANCEL_PICKER_SCRIPT);
    expect(screen.queryByText('ページの要素をクリックしてください（Esc でやめる）')).toBeNull();
    await act(async () => choose(null));
    expect(inserted).toEqual([]);
    expect(button('要素を選ぶ').getAttribute('aria-pressed')).toBe('false');
  });

  it('ブラウザを閉じるボタンで onClose を呼ぶ', async () => {
    const onClose = vi.fn();
    render(<Pane sessionId="s1" onClose={onClose} />);
    await act(async () => {});
    fireEvent.click(button('ブラウザを閉じる'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('PreviewPane: タブ', () => {
  it('タブを押すと今のタブにして main に知らせる（左ボタンだけ）。中ボタンでは閉じる', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    fireEvent.click(button('新しいタブ'));
    expect(webviews).toHaveLength(2);
    expect(webviews[1].src).toBe('about:blank');
    const [first, second] = activated().map(([, id]) => id as string);
    expect(second).not.toBe(first);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    // 空のタブを開いたら、すぐ URL を打てるようにアドレス欄にカーソルを置く
    expect(document.activeElement).toBe(address());

    fireEvent.mouseDown(tabs()[0], { button: 2 });
    expect(activated()).toHaveLength(2);
    fireEvent.mouseDown(tabs()[0], { button: 0 });
    expect(activated().at(-1)).toEqual(['s1', first]);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(address().value).toBe('http://localhost:3000/');
    // 今のタブの webview だけを出す
    expect(webviews.map((w) => w.style.display)).toEqual(['', 'none']);

    fireEvent(tabs()[1], new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(tabs().map((t) => t.textContent)).toEqual(['localhost:3000/']);
    expect(webviews[1].isConnected).toBe(false);
    // 今のタブではないタブを閉じても、今のタブは変えない
    expect(activated().at(-1)).toEqual(['s1', first]);
  });

  it('タブの × は、そのタブを選ばずに閉じる。今のタブを閉じたら右（無ければ左）のタブに移り、最後のタブを閉じたら空に戻る', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    fireEvent.click(button('新しいタブ'));
    go('localhost:4000');
    fireEvent.click(button('新しいタブ'));
    go('localhost:5000');
    // 空のタブで開いたページは、移ったという知らせで、タブの名前になる
    webviews.forEach(loaded);
    const ids = [...new Set(activated().map(([, id]) => id as string))];
    expect(ids).toHaveLength(3);
    // 1 番目のタブを選ぶ
    fireEvent.mouseDown(tabs()[0], { button: 0 });
    const before = activated().length;

    // 2 番目（今のタブではない）の × を押す: そのタブだけ閉じ、今のタブは変えない
    const close = (index: number) => {
      const x = tabs()[index].querySelector('[aria-label="タブを閉じる"]')!;
      fireEvent.mouseDown(x, { button: 0 });
      fireEvent.click(x);
    };
    close(1);
    expect(activated()).toHaveLength(before);
    expect(tabs().map((t) => t.textContent)).toEqual(['localhost:3000/', 'localhost:5000/']);
    expect(webviews[1].isConnected).toBe(false);

    // 今のタブ（1 番目）を閉じると、右のタブに移る
    close(0);
    expect(activated().at(-1)).toEqual(['s1', ids[2]]);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true']);

    close(0);
    expect(activated().at(-1)).toEqual(['s1', null]);
    expect(tabs()).toEqual([]);
    expect(screen.getByText('上のアドレス欄に URL を入れて Enter で開きます')).toBeTruthy();
  });
});

describe('PreviewPane: 見せるセッションを切り替えた直後のボタン', () => {
  it('ツールバー・タブのボタンは、切り替えた先のセッションのページに効く', async () => {
    const { rerender } = render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    const [one] = webviews;
    loaded(one);
    fire(one, 'console-message', { level: 3, message: 's1 のエラー' });

    rerender(<Pane sessionId="s2" />);
    // s2 にはまだタブが無い。s1 のページには効かない
    expect(tabs()).toEqual([]);
    expect(address().value).toBe('');
    expect(button('戻る').disabled).toBe(true);
    expect(button('開発者ツール').disabled).toBe(true);
    expect(screen.queryByLabelText(/^エラー/)).toBeNull();
    go('localhost:4000');
    const two = webviews[1];
    two.canBack = true;
    two.canForward = true;
    loaded(two);
    fire(two, 'console-message', { level: 3, message: 's2 のエラー' });
    expect(webviews.map((w) => w.style.display)).toEqual(['none', '']);

    fireEvent.click(button('戻る'));
    fireEvent.click(button('進む'));
    fireEvent.click(button('読み込み直す'));
    fireEvent.click(button('開発者ツール'));
    fireEvent.click(button('ふだんのブラウザで開く'));
    fireEvent.click(button('エラー 1 件'));
    fireEvent.click(button('要素を選ぶ'));
    await act(async () => {});
    expect(two.log).toEqual(['goBack', 'goForward', 'reload', 'openDevTools', 'focus']);
    expect(two.scripts).toHaveLength(1);
    expect(one.log).toEqual([]);
    expect(one.scripts).toEqual([]);
    expect(api.argsOf('browser.openExternal')).toEqual([['http://localhost:4000/']]);
    expect(inserted.map((i) => i.sessionId)).toEqual(['s2']);
    expect(inserted[0].text).toContain('s2 のエラー');

    // s1 に戻ると、s1 のタブとエラーが出ていて、そちらに効く
    rerender(<Pane sessionId="s1" />);
    expect(address().value).toBe('http://localhost:3000/');
    fireEvent.click(button('エラー 1 件'));
    expect(inserted.map((i) => i.sessionId)).toEqual(['s2', 's1']);
    expect(inserted[1].text).toContain('s1 のエラー');
    fireEvent.click(button('新しいタブ'));
    expect(activated().at(-1)?.[0]).toBe('s1');
    fireEvent.mouseDown(tabs()[0], { button: 0 });
    expect(activated().at(-1)).toEqual(['s1', expect.stringMatching(/^tab-/)]);
    const x = tabs()[0].querySelector('[aria-label="タブを閉じる"]')!;
    fireEvent.click(x);
    expect(one.isConnected).toBe(false);
    expect(two.isConnected).toBe(true);
  });

  it('消えたセッションのタブは閉じる', async () => {
    const { rerender } = render(<Pane sessionId="s1" />);
    await act(async () => {});
    go('localhost:3000');
    rerender(<Pane sessionId="s2" />);
    go('localhost:4000');
    rerender(<Pane sessionId="s2" live={['s2']} />);
    expect(webviews.map((w) => w.isConnected)).toEqual([false, true]);
  });
});

describe('PreviewPane: Claude からの操作の依頼（あなたの番です）', () => {
  const ask = (change: BrowserAskChange) => act(() => api.emit('browser.onAsk', change));

  it('「終わった」を押すと、そのセッションのその依頼に「終わった」と返す', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    ask({ sessionId: 's1', ask: { id: 'a1', message: 'ログインしてください' } });
    expect(screen.getByText('ログインしてください')).toBeTruthy();
    fireEvent.click(screen.getByText('終わった'));
    expect(api.argsOf('browser.answer')).toEqual([['s1', 'a1', { done: true, reason: '' }]]);
    ask({ sessionId: 's1', ask: null });
    expect(screen.queryByText('ログインしてください')).toBeNull();
  });

  it('「できない」で理由の欄を出し、書いた理由（前後の空白を除く）を添えて返す。「戻る」と Esc で元のボタンに戻る', async () => {
    render(<Pane sessionId="s1" />);
    await act(async () => {});
    ask({ sessionId: 's1', ask: { id: 'a1', message: '2 段階認証のコードを入れてください' } });

    fireEvent.click(screen.getByText('できない'));
    expect(screen.queryByText('終わった')).toBeNull();
    fireEvent.click(screen.getByText('戻る'));
    expect(screen.getByText('終わった')).toBeTruthy();

    fireEvent.click(screen.getByText('できない'));
    const reason = screen.getByLabelText('できない理由') as HTMLInputElement;
    expect(document.activeElement).toBe(reason);
    fireEvent.keyDown(reason, { key: 'Escape', isComposing: true });
    expect(screen.getByLabelText('できない理由')).toBeTruthy();
    fireEvent.keyDown(reason, { key: 'a' });
    expect(screen.getByLabelText('できない理由')).toBeTruthy();
    fireEvent.keyDown(reason, { key: 'Escape' });
    expect(screen.queryByLabelText('できない理由')).toBeNull();

    fireEvent.click(screen.getByText('できない'));
    fireEvent.change(screen.getByLabelText('できない理由'), { target: { value: '  手元に端末がない  ' } });
    expect((screen.getByLabelText('できない理由') as HTMLInputElement).value).toBe('  手元に端末がない  ');
    fireEvent.click(screen.getByText('送る'));
    expect(api.argsOf('browser.answer')).toEqual([['s1', 'a1', { done: false, reason: '手元に端末がない' }]]);
  });

  it('画面を作り直したときも頼まれている依頼を出し、切り替えた先のセッションの依頼に返す', async () => {
    api = mockApi({
      'browser.asks': () =>
        Promise.resolve([
          { sessionId: 's1', ask: { id: 'a1', message: 's1 への依頼' } },
          { sessionId: 's2', ask: { id: 'a2', message: 's2 への依頼' } },
        ]),
    });
    api.install();
    const { rerender } = render(<Pane sessionId="s1" />);
    expect(await screen.findByText('s1 への依頼')).toBeTruthy();
    fireEvent.click(screen.getByText('できない'));

    rerender(<Pane sessionId="s2" />);
    expect(screen.getByText('s2 への依頼')).toBeTruthy();
    // 依頼ごとに、理由の欄は閉じた状態から始める
    expect(screen.queryByLabelText('できない理由')).toBeNull();
    fireEvent.click(screen.getByText('終わった'));
    fireEvent.click(screen.getByText('できない'));
    fireEvent.submit(screen.getByLabelText('できない理由').closest('form')!);
    expect(api.argsOf('browser.answer')).toEqual([
      ['s2', 'a2', { done: true, reason: '' }],
      ['s2', 'a2', { done: false, reason: '' }],
    ]);
  });
});

describe('BrowserHostsDialog', () => {
  function open(initial: string[], onClose = vi.fn()) {
    api = mockApi({
      'browser.hosts': () => Promise.resolve(initial),
      'browser.setHosts': (next: never) => Promise.resolve(next),
    });
    api.install();
    render(<BrowserHostsDialog onClose={onClose} />);
    return onClose;
  }
  const input = () => screen.getByLabelText('足す先') as HTMLInputElement;
  const add = (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.submit(input().closest('form')!);
  };

  it('打った先を書き方をそろえて足し、入力欄を空にする。空のあいだは「追加」を押せない', async () => {
    open(['myapp.test']);
    expect(await screen.findByText('myapp.test')).toBeTruthy();
    expect(document.activeElement).toBe(input());
    expect(button('追加').disabled).toBe(true);
    fireEvent.change(input(), { target: { value: 'http://Example.TEST:8080/path' } });
    expect(input().value).toBe('http://Example.TEST:8080/path');
    expect(button('追加').disabled).toBe(false);
    fireEvent.click(button('追加'));
    await waitFor(() => expect(input().value).toBe(''));
    expect(api.argsOf('browser.setHosts')).toEqual([[['myapp.test', 'example.test']]]);
    expect(screen.getByText('example.test')).toBeTruthy();
  });

  it('書き方の違う先は足さずに理由を出す。既定の先・足してある先は保存せずに入力欄を空にする', async () => {
    open(['myapp.test']);
    await screen.findByText('myapp.test');
    add('*');
    expect(screen.getByText('書き方が違います: *（例: example.test・*.example.test・192.168.0.10）')).toBeTruthy();
    expect(input().value).toBe('*');
    add('localhost');
    await waitFor(() => expect(input().value).toBe(''));
    expect(screen.queryByText(/書き方が違います/)).toBeNull();
    add('MyApp.test');
    await waitFor(() => expect(input().value).toBe(''));
    expect(api.argsOf('browser.setHosts')).toEqual([]);
  });

  it('保存に失敗したら理由を出し、打った先は入力欄に残す', async () => {
    api = mockApi({
      'browser.hosts': () => Promise.resolve([]),
      'browser.setHosts': () => Promise.reject(new Error("Error invoking remote method 'browser:hosts-set': Error: 保存できません")),
    });
    api.install();
    render(<BrowserHostsDialog onClose={() => {}} />);
    await act(async () => {});
    add('example.test');
    expect(await screen.findByText('保存できません')).toBeTruthy();
    expect(input().value).toBe('example.test');
  });

  it('削除を押すと、その先だけを除いて保存する', async () => {
    open(['myapp.test', '*.staging.example.test']);
    await screen.findByText('myapp.test');
    const rows = screen.getAllByLabelText('削除');
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]);
    await waitFor(() => expect(screen.queryByText('myapp.test')).toBeNull());
    expect(api.argsOf('browser.setHosts')).toEqual([[['*.staging.example.test']]]);
    expect(screen.getByText('*.staging.example.test')).toBeTruthy();
    // 押したボタンは消えるので、Esc で閉じられるようダイアログにフォーカスを戻す
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('外側を押すか Esc で閉じる。ダイアログの中を押しても、変換中の Esc でも閉じない', async () => {
    const onClose = open([]);
    await act(async () => {});
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.mouseDown(input());
    fireEvent.keyDown(input(), { key: 'Escape', isComposing: true });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(button('閉じる'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
