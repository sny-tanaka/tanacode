// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPopupTab } from '@shared/ipc';
import { PreviewPane } from '../../src/renderer/src/preview/PreviewPane';
import { cssCursor } from '../../src/renderer/src/preview/PopupCanvas';
import './dom';
import { mockApi } from './mock-api';

// アプリ内ブラウザのポップアップ（ページが開いた別ウインドウを、タブに映すもの。PreviewPane と PopupCanvas）のタブ・ボタン・入力を押して、
// main へ送るもの（映す場所・操作・実物を開く・閉じる）と、画面の変化を確かめる。絵そのものは jsdom では描けないので、届いたら描き終えたと返すことを見る

let api: ReturnType<typeof mockApi>;
const createElement = document.createElement.bind(document);

beforeEach(() => {
  api = mockApi({
    'browser.asks': () => Promise.resolve([]),
    'browser.logins': () => Promise.resolve([]),
    'browser.popups': () => Promise.resolve([]),
    'browser.remembers': () => Promise.resolve([]),
  });
  api.install();
  // jsdom には Electron の <webview> が無いので、使うものだけを足す
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options);
    if (tag === 'webview') {
      Object.assign(element, {
        getURL: () => (element as unknown as { src: string }).src,
        canGoBack: () => false,
        canGoForward: () => false,
        getWebContentsId: () => 1,
        executeJavaScript: () => Promise.resolve(null),
      });
    }
    return element;
  }) as typeof document.createElement);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let POPUP: BrowserPopupTab = { tabId: 'popup-9', openerTabId: 'tab-1', url: 'https://accounts.example.com/signin', title: 'サインイン' };

// 映す場所の大きさ（jsdom では要素の大きさが 0 なので、ポップアップの絵の場所にだけ大きさを持たせる）
const BOX = { left: 900, top: 120, width: 600, height: 700, right: 1500, bottom: 820, x: 900, y: 120, toJSON: () => ({}) };

// セッション s1 に、ページのタブを 1 つ開いて、ポップアップを開かせる（タブの ID の番号はテストをまたいで増えるので、開いたタブの ID を読む）
async function withPopup(options: { claudeActive?: boolean } = {}) {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('preview-popup-box') ? BOX : rect.call(this);
  });
  render(<PreviewPane sessionId="s1" visible liveSessionIds={['s1']} onShow={() => {}} onClose={() => {}} />);
  act(() => api.emit('browser.onOpen', { sessionId: 's1', url: 'http://localhost:3000/' }));
  const openerTabId = api.argsOf('browser.activate').at(-1)![1] as string;
  POPUP = { ...POPUP, openerTabId };
  if (options.claudeActive) act(() => api.emit('browser.onActivity', { sessionId: 's1', active: true, label: null, box: null }));
  act(() => api.emit('browser.onPopups', { sessionId: 's1', popups: [POPUP] }));
  await act(async () => {});
  return { openerTabId };
}

const tabs = () => [...document.querySelectorAll('.preview-tab')].map((tab) => ({ text: tab.textContent, active: tab.classList.contains('active'), popup: tab.classList.contains('popup') }));
const canvas = () => document.querySelector('.preview-popup-canvas') as HTMLCanvasElement;
const input = () => document.querySelector('.preview-popup-input') as HTMLTextAreaElement;
const sentInputs = () => api.argsOf('browser.popupInput').map(([sid, tabId, value]) => ({ sid, tabId, ...(value as object) }));

describe('ポップアップのタブ', () => {
  it('人が開いたポップアップは、タブのあとに印を付けて並び、すぐ今のタブになる。映す場所を main に知らせ、アドレス欄は書き換えられない', async () => {
    await withPopup();
    expect(tabs().at(-1)).toEqual({ text: 'ポップアップサインイン', active: true, popup: true });
    expect(api.argsOf('browser.activate').at(-1)).toEqual(['s1', 'popup-9']);
    expect(api.argsOf('browser.viewPopup').at(-1)).toEqual(['s1', 'popup-9', { x: 900, y: 120, width: 600, height: 700 }]);
    const address = screen.getByLabelText('開く URL') as HTMLInputElement;
    expect([address.value, address.readOnly]).toEqual([POPUP.url, true]);
  });

  it('Claude の操作中に開いたポップアップは、タブを足すだけで今のタブにしない', async () => {
    await withPopup({ claudeActive: true });
    expect(tabs().map((tab) => tab.active)).toEqual([true, false]);
    expect(api.argsOf('browser.viewPopup')).toEqual([]);
  });

  it('× で閉じると main に閉じさせる。閉じたと知らせが来たら、開いたタブに戻り、映すのもやめる', async () => {
    const { openerTabId } = await withPopup();
    fireEvent.click(screen.getByLabelText('ポップアップを閉じる'));
    expect(api.argsOf('browser.closePopup')).toEqual([['s1', 'popup-9']]);
    act(() => api.emit('browser.onPopups', { sessionId: 's1', popups: [] }));
    expect(tabs()).toEqual([{ text: expect.any(String), active: true, popup: false }]);
    expect(api.argsOf('browser.activate').at(-1)).toEqual(['s1', openerTabId]);
    expect(api.argsOf('browser.viewPopup').at(-1)).toEqual(['s1', 'popup-9', null]);
  });

  it('題も URL も無いポップアップは「空のページ」と出す。ほかのタブを選ぶと、映すのをやめる', async () => {
    render(<PreviewPane sessionId="s1" visible liveSessionIds={['s1']} onShow={() => {}} onClose={() => {}} />);
    act(() => api.emit('browser.onOpen', { sessionId: 's1', url: 'http://localhost:3000/' }));
    act(() => api.emit('browser.onPopups', { sessionId: 's1', popups: [{ ...POPUP, url: '', title: '' }] }));
    expect(tabs().at(-1)?.text).toBe('ポップアップ空のページ');
    fireEvent.mouseDown(document.querySelectorAll('.preview-tab')[0]!, { button: 0 });
    expect(api.argsOf('browser.viewPopup').at(-1)).toEqual(['s1', 'popup-9', null]);
  });
});

describe('映したポップアップの操作', () => {
  it('「実物を開く」で、本物の別ウインドウを出させる', async () => {
    await withPopup();
    fireEvent.click(screen.getByRole('button', { name: '実物を開く' }));
    expect(api.argsOf('browser.revealPopup')).toEqual([['s1', 'popup-9']]);
  });

  it('届いた絵は、描いてから描き終えたと返す。ほかのポップアップの絵には返さない。カーソルの形も合わせる', async () => {
    await withPopup();
    act(() => api.emit('browser.onPopupFrame', { sessionId: 's1', tabId: 'popup-8', width: 2, height: 2, scale: 2, data: new Uint8Array(16) }));
    act(() => api.emit('browser.onPopupFrame', { sessionId: 's1', tabId: 'popup-9', width: 2, height: 2, scale: 2, data: new Uint8Array(16) }));
    expect(api.argsOf('browser.popupFrameDone')).toEqual([['s1', 'popup-9']]);
    expect([canvas().width, canvas().style.width]).toEqual([2, '1px']);
    act(() => api.emit('browser.onPopupCursor', { sessionId: 's1', tabId: 'popup-9', cursor: 'hand' }));
    expect(canvas().style.cursor).toBe('pointer');
    expect([cssCursor('nodrop'), cssCursor('custom'), cssCursor('text')]).toEqual(['no-drop', 'default', 'text']);
  });

  it('マウス（押す・離す・動かす・外れる・ホイール）は、絵の左上からの位置で送る。押したら入力欄にフォーカスを置き、ページにもフォーカスを渡す。右クリックのメニューは出さない', async () => {
    await withPopup();
    vi.spyOn(canvas(), 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 400, height: 300, right: 500, bottom: 350, x: 100, y: 50, toJSON: () => ({}) });
    fireEvent.mouseDown(canvas(), { clientX: 130, clientY: 90, button: 0, detail: 2, shiftKey: true });
    expect(document.activeElement).toBe(input());
    fireEvent.mouseUp(canvas(), { clientX: 130, clientY: 90, button: 2, detail: 1 });
    fireEvent.mouseMove(canvas(), { clientX: 140, clientY: 95, metaKey: true });
    fireEvent.wheel(canvas(), { clientX: 140, clientY: 95, deltaX: 0, deltaY: 120 });
    fireEvent.mouseLeave(canvas());
    expect(fireEvent.contextMenu(canvas())).toBe(false);
    expect(sentInputs()).toEqual([
      { sid: 's1', tabId: 'popup-9', type: 'focus' },
      { sid: 's1', tabId: 'popup-9', type: 'mouseDown', x: 30, y: 40, button: 'left', clickCount: 2, modifiers: ['shift'] },
      { sid: 's1', tabId: 'popup-9', type: 'mouseUp', x: 30, y: 40, button: 'right', clickCount: 1, modifiers: [] },
      { sid: 's1', tabId: 'popup-9', type: 'mouseMove', x: 40, y: 45, modifiers: ['meta'] },
      { sid: 's1', tabId: 'popup-9', type: 'mouseWheel', x: 40, y: 45, deltaX: 0, deltaY: 120, modifiers: [] },
      { sid: 's1', tabId: 'popup-9', type: 'mouseLeave' },
    ]);
    // 入力欄は、押した位置に置く（日本語の変換の候補が、押した近くに出るように）
    expect([input().style.left, input().style.top]).toEqual(['30px', '40px']);
  });

  it('キーは keyDown・keyUp で送る。⌘C などは編集の操作にし、ほかの ⌘ の組み合わせはアプリのショートカットに任せる', async () => {
    await withPopup();
    expect(fireEvent.keyDown(input(), { key: 'a' })).toBe(false);
    fireEvent.keyUp(input(), { key: 'a' });
    expect(fireEvent.keyDown(input(), { key: 'v', metaKey: true })).toBe(false);
    fireEvent.keyDown(input(), { key: 'z', metaKey: true, shiftKey: true });
    expect(fireEvent.keyDown(input(), { key: '1', metaKey: true })).toBe(true);
    fireEvent.keyUp(input(), { key: '1', metaKey: true });
    expect(sentInputs()).toEqual([
      { sid: 's1', tabId: 'popup-9', type: 'keyDown', key: 'a', modifiers: [] },
      { sid: 's1', tabId: 'popup-9', type: 'keyUp', key: 'a', modifiers: [] },
      { sid: 's1', tabId: 'popup-9', type: 'edit', command: 'paste' },
      { sid: 's1', tabId: 'popup-9', type: 'edit', command: 'redo' },
    ]);
  });

  it('日本語の変換の間は、キーを送らず、変換中の文字を入力欄に出す。確定した文字を送り、入力欄は空に戻す', async () => {
    await withPopup();
    fireEvent.compositionStart(input());
    expect(input().classList.contains('composing')).toBe(true);
    fireEvent.keyDown(input(), { key: 'Process', keyCode: 229 });
    fireEvent.input(input(), { target: { value: 'にほんご' } });
    input().value = '日本語';
    fireEvent.compositionEnd(input(), { data: '日本語' });
    expect(input().classList.contains('composing')).toBe(false);
    expect(input().value).toBe('');
    // 変換を通らずに入った文字も、入力欄に残さない
    input().value = 'x';
    fireEvent.input(input());
    expect(input().value).toBe('');
    expect(sentInputs()).toEqual([{ sid: 's1', tabId: 'popup-9', type: 'insertText', text: '日本語' }]);
  });
});
