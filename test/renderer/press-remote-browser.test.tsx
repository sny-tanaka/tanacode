// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserMirrorFrame, BrowserMirrorTab } from '@shared/ipc';
import { RemoteBrowser } from '../../src/renderer/src/preview/RemoteBrowser';
import { addTraffic, traffic } from '../../src/renderer/src/remote/mode';
import './dom';
import { mockApi } from './mock-api';

// スマホの画面のブラウザ（Mac のアプリ内ブラウザのタブを映す。Issue #464）。開いただけでは映さず、「ミラーリング」を押したときだけ映す

const TABS: BrowserMirrorTab[] = [
  { tabId: 'tab-1', url: 'https://example.com/a', title: 'A', active: false },
  { tabId: 'tab-2', url: 'http://localhost:6006/', title: 'Storybook', active: true },
];

let api: ReturnType<typeof mockApi>;
let started: boolean;
beforeEach(() => {
  started = true;
  api = mockApi({
    'browser.mirrorTabs': () => Promise.resolve(TABS),
    'browser.mirrorStart': () => Promise.resolve(started),
    'browser.mirrorStop': () => Promise.resolve(),
    'browser.mirrorNavigate': () => Promise.resolve(true),
  });
  api.install();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
const frame = (data: string): BrowserMirrorFrame => ({ data, width: 400, height: 800 });
const image = () => document.querySelector('.remote-browser-screen img') as HTMLImageElement;

// 絵の置き場所（jsdom は大きさを測らないので、決める）
function placeImage() {
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
}

describe('RemoteBrowser', () => {
  it('開いただけでは映さず、タブの一覧（Mac で選んでいるタブ）と「ミラーリング」を出す。押したら、そのタブを映し始める', async () => {
    render(<RemoteBrowser sessionId="s1" visible />);
    await settle();
    expect(api.argsOf('browser.mirrorTabs')).toEqual([['s1']]);
    expect((screen.getByRole('combobox', { name: '映すタブ' }) as HTMLSelectElement).value).toBe('tab-2');
    expect(api.argsOf('browser.mirrorStart')).toEqual([]);
    fireEvent.change(screen.getByRole('combobox', { name: '映すタブ' }), { target: { value: 'tab-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'ミラーリング' }));
    await settle();
    expect(api.argsOf('browser.mirrorStart')).toEqual([['s1', 'tab-1', { width: expect.any(Number), height: expect.any(Number), saver: false }]]);
  });

  it('絵を出し、描き終えたら知らせる。押した・なぞった・打ったものを送る。戻る・進む・再読み込み・アドレスで移る', async () => {
    placeImage();
    render(<RemoteBrowser sessionId="s1" visible />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'ミラーリング' }));
    await settle();
    act(() => api.emit('browser.onMirrorFrame', frame('AAAA')));
    expect(image().src).toBe('data:image/jpeg;base64,AAAA');
    fireEvent.load(image());
    expect(api.argsOf('browser.mirrorDone')).toHaveLength(1);
    // 押した（動かさずに離した）
    fireEvent.pointerDown(image(), { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(image(), { clientX: 100, clientY: 100 });
    // なぞった（下へ 40px）。少しの動きは、なぞったことにしない
    fireEvent.pointerDown(image(), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(image(), { clientX: 101, clientY: 102 });
    fireEvent.pointerMove(image(), { clientX: 100, clientY: 140 });
    fireEvent.pointerUp(image(), { clientX: 100, clientY: 140 });
    fireEvent.pointerCancel(image());
    fireEvent.pointerMove(image(), { clientX: 100, clientY: 140 });
    fireEvent.change(screen.getByRole('textbox', { name: 'ページに入れる文字' }), { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getAllByRole('button', { name: '送る' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '送る' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '改行' }));
    expect(api.argsOf('browser.mirrorInput').map((args) => args[0])).toEqual([
      { type: 'tap', x: 0.5, y: 0.25 },
      { type: 'scroll', x: 0.5, y: 0.25, deltaX: -0, deltaY: -0.1 },
      { type: 'text', text: 'こんにちは' },
      { type: 'key', key: 'Enter' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    fireEvent.click(screen.getByRole('button', { name: '進む' }));
    fireEvent.click(screen.getByRole('button', { name: '読み込み直す' }));
    fireEvent.change(screen.getByRole('textbox', { name: '開く URL' }), { target: { value: 'localhost:3000' } });
    fireEvent.submit(screen.getByRole('textbox', { name: '開く URL' }));
    fireEvent.change(screen.getByRole('textbox', { name: '開く URL' }), { target: { value: '  ' } });
    fireEvent.submit(screen.getByRole('textbox', { name: '開く URL' }));
    await settle();
    expect(api.argsOf('browser.mirrorNavigate').map((args) => args[2])).toEqual([{ kind: 'back' }, { kind: 'forward' }, { kind: 'reload' }, { kind: 'open', url: 'http://localhost:3000/' }]);
  });

  it('節約に切り替えると、節約で映し直す。「やめる」・ほかのタブへ移る・裏に回ると止める。Mac の側で止まったら「ミラーリング」に戻す', async () => {
    const view = render(<RemoteBrowser sessionId="s1" visible />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'ミラーリング' }));
    await settle();
    fireEvent.click(screen.getByRole('checkbox', { name: '節約' }));
    await settle();
    expect(api.argsOf('browser.mirrorStart').at(-1)?.[2]).toMatchObject({ saver: true });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await settle();
    expect(api.argsOf('browser.mirrorStop').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'ミラーリング' })).toBeTruthy();
    // 裏に回った
    fireEvent.click(screen.getByRole('button', { name: 'ミラーリング' }));
    await settle();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(screen.getByRole('button', { name: 'ミラーリング' })).toBeTruthy();
    vi.restoreAllMocks();
    // Mac の側で止まった
    fireEvent.click(screen.getByRole('button', { name: 'ミラーリング' }));
    await settle();
    act(() => api.emit('browser.onMirrorFrame', { stopped: true }));
    await settle();
    expect(screen.getByRole('button', { name: 'ミラーリング' })).toBeTruthy();
    // ほかのタブ（ブラウザのタブを離れた）
    fireEvent.click(screen.getByRole('button', { name: 'ミラーリング' }));
    await settle();
    const stops = api.argsOf('browser.mirrorStop').length;
    view.rerender(<RemoteBrowser sessionId="s1" visible={false} />);
    await settle();
    expect(api.argsOf('browser.mirrorStop').length).toBe(stops + 1);
  });

  it('始められなければ、わけを出す。タブが無ければ、Mac で開くよう出す。セッションが無ければ何も出さない', async () => {
    started = false;
    const view = render(<RemoteBrowser sessionId="s1" visible />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'ミラーリング' }));
    await settle();
    expect(screen.getByText('映せませんでした。Mac でタブが閉じていないか確かめてください')).toBeTruthy();
    view.unmount();
    mockApi({ 'browser.mirrorTabs': () => Promise.resolve(undefined) }).install();
    render(<RemoteBrowser sessionId="s1" visible />);
    await settle();
    expect(screen.getByText('Mac のアプリ内ブラウザでタブを開くと、ここで映せます')).toBeTruthy();
    cleanup();
    const none = render(<RemoteBrowser sessionId={null} visible />);
    expect(none.container.innerHTML).toBe('');
  });

  it('使った通信量を、この接続と今日の分で出す（日が変われば今日の分は 0 から）', () => {
    localStorage.clear();
    const day = new Date(2026, 10, 26, 9);
    addTraffic(1024 * 1024, day);
    expect(traffic(day).today).toBe(1024 * 1024);
    expect(traffic(new Date(2026, 10, 27, 9)).today).toBe(0);
    localStorage.setItem('tanacode.remote.traffic', '{broken');
    expect(traffic(day).today).toBe(0);
  });
});
