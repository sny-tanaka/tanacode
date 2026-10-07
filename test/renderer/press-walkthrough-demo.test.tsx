// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoSite } from '../../src/renderer/src/demo/site/DemoSite';
import { CHAPTER_INFO } from '../../src/renderer/src/demo/story/chapterInfo';
import './dom';

// デモのサイト（npm run demo:dev）の親のページ。上の帯（目次・一時停止・次の章へ・ツアーを見る）と目次の、ボタンとリンク。
// 押したら、iframe の中のアプリの画面に何を送るか・どの章へ移るかまで確かめる

beforeAll(() => {
  // jsdom に無いもの（帯の高さの変化を見る・タッチの画面かを調べる）を、何もしないものにする
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.matchMedia) window.matchMedia = (query: string) => ({ matches: false, media: query }) as MediaQueryList;
});
beforeEach(() => {
  // ほかのテストで移った章（ハッシュ）を戻す
  history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// iframe の中のアプリの画面に送ったもの
function stageMessages(): ReturnType<typeof vi.fn> {
  const frame = document.querySelector('iframe.demo-stage') as HTMLIFrameElement;
  return vi.spyOn(frame.contentWindow!, 'postMessage') as unknown as ReturnType<typeof vi.fn>;
}
// 章を選んだときに読み込み直したか。jsdom は読み込み直せず、「できない」の知らせ（jsdomError）を出すので、それで見る
// （見ている間は、その知らせをコンソールに出さない）
type Listener = (error: Error) => void;
type VirtualConsole = { listeners(event: 'jsdomError'): Listener[]; on(event: 'jsdomError', listener: Listener): void; off(event: 'jsdomError', listener: Listener): void };
const virtualConsole = (globalThis as unknown as { jsdom: { virtualConsole: VirtualConsole } }).jsdom.virtualConsole;
const stopWatching: (() => void)[] = [];
function watchReload(): () => boolean {
  let reloaded = false;
  const forwarders = virtualConsole.listeners('jsdomError');
  for (const forward of forwarders) virtualConsole.off('jsdomError', forward);
  const listener = (error: Error) => {
    if (error.message.includes('navigation to another Document')) reloaded = true;
    else for (const forward of forwarders) forward(error);
  };
  virtualConsole.on('jsdomError', listener);
  stopWatching.push(() => {
    virtualConsole.off('jsdomError', listener);
    for (const forward of forwarders) virtualConsole.on('jsdomError', forward);
  });
  return () => reloaded;
}
afterEach(() => stopWatching.splice(0).forEach((stop) => stop()));
// リンクで移る先（jsdom はリンクを押したあと、少し置いてからハッシュを変える）
const nextTick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const menu = () => screen.queryByRole('dialog', { name: '目次' });
// iframe の中のアプリの画面からの知らせ（いまの章・早送りが終わった など）
function fromStage(data: unknown): void {
  const frame = document.querySelector('iframe.demo-stage') as HTMLIFrameElement;
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: frame.contentWindow });
  act(() => {
    window.dispatchEvent(event);
  });
}

describe('DemoSite（デモのサイトの帯と目次）', () => {
  it('再生中に「一時停止」を押すとアプリの画面を止め、「再開」で動かす', () => {
    render(<DemoSite start={CHAPTER_INFO[0]} />);
    const post = stageMessages();
    const button = screen.getByText('一時停止');
    fireEvent.click(button);
    expect(post).toHaveBeenLastCalledWith({ type: 'demo:pause', paused: true }, '*');
    expect(button.textContent).toBe('再開');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(post).toHaveBeenLastCalledWith({ type: 'demo:pause', paused: false }, '*');
    expect(button.textContent).toBe('一時停止');
  });

  it('「次の章へ」を押すと、アプリの画面に次の章へ進めさせる。最後の章では出さない', () => {
    const { unmount } = render(<DemoSite start={CHAPTER_INFO[0]} />);
    const post = stageMessages();
    fireEvent.click(screen.getByText('次の章へ'));
    expect(post).toHaveBeenCalledWith({ type: 'demo:next' }, '*');
    unmount();
    const last = CHAPTER_INFO.length - 1;
    render(<DemoSite start={CHAPTER_INFO[last]} />);
    // 最後の章の手前まで早送りし終えたところ
    fromStage({ type: 'demo:chapter', index: last, preparing: false });
    expect(screen.getByText('一時停止')).toBeTruthy();
    expect(screen.queryByText('次の章へ')).toBeNull();
  });

  it('「目次」を押すと目次を出し、出している間はツアーを止める。中を押しても閉じず、幕・Esc・「ツアーに戻る」で閉じて再開する', () => {
    render(<DemoSite start={CHAPTER_INFO[1]} />);
    // 目次から飛んだ章は、手前まで早送りしている間は一時停止のボタンを出さない
    expect(screen.getByText(`「${CHAPTER_INFO[1].title}」の手前まで進めています…`, { selector: '.demo-caption-text' })).toBeTruthy();
    const post = stageMessages();
    expect(menu()).toBeNull();
    fireEvent.click(screen.getByText('目次'));
    expect(menu()).toBeTruthy();
    expect(post).toHaveBeenLastCalledWith({ type: 'demo:pause', paused: true }, '*');
    // いまの章に印
    expect(screen.getByText(CHAPTER_INFO[1].title, { selector: '.demo-tour-name' }).closest('a')!.className).toContain('current');
    fireEvent.click(screen.getByText(/作り物のデータで動くため/));
    fireEvent.click(menu()!);
    expect(menu()).toBeTruthy();
    fireEvent.click(menu()!.parentElement!);
    expect(menu()).toBeNull();
    expect(post).toHaveBeenLastCalledWith({ type: 'demo:pause', paused: false }, '*');
    fireEvent.click(screen.getByText('目次'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(menu()).toBeNull();
    fireEvent.click(screen.getByText('目次'));
    fireEvent.click(screen.getByText('ツアーに戻る'));
    expect(menu()).toBeNull();
  });

  it('ツアーを流さずに開くと目次を出し、「自由に触る」で閉じる', () => {
    render(<DemoSite start={null} />);
    expect(menu()).toBeTruthy();
    fireEvent.click(screen.getByText('自由に触る'));
    expect(menu()).toBeNull();
    expect(screen.getByText('自由に触れます。チャットに送っても、本物の Claude には繋がりません')).toBeTruthy();
  });

  it('目次の章を押すと、その章へ移る（ハッシュを変え、main.tsx が読み込み直す）', async () => {
    render(<DemoSite start={null} />);
    const reloaded = watchReload();
    const link = screen.getByText(CHAPTER_INFO[2].title, { selector: '.demo-tour-name' }).closest('a')!;
    expect(link.getAttribute('href')).toBe(`#${CHAPTER_INFO[2].id}`);
    // 違う章へは、リンクのまま移る
    expect(fireEvent.click(link)).toBe(true);
    await nextTick();
    expect(location.hash).toBe(`#${CHAPTER_INFO[2].id}`);
    expect(reloaded()).toBe(false);
  });

  it('いまと同じ章を目次で押すと、ハッシュが変わらないので、自分で読み込み直す', async () => {
    history.replaceState(null, '', `/#${CHAPTER_INFO[2].id}`);
    render(<DemoSite start={CHAPTER_INFO[2]} />);
    fireEvent.click(screen.getByText('目次'));
    const reloaded = watchReload();
    const link = screen.getByText(CHAPTER_INFO[2].title, { selector: '.demo-tour-name' }).closest('a')!;
    expect(fireEvent.click(link)).toBe(false);
    expect(reloaded()).toBe(true);
    await nextTick();
    expect(location.hash).toBe(`#${CHAPTER_INFO[2].id}`);
  });

  it('目次の「最初から見る」は、最初の章へ移る。最初の章を見ているときは読み込み直す', async () => {
    history.replaceState(null, '', `/#${CHAPTER_INFO[3].id}`);
    const { unmount } = render(<DemoSite start={CHAPTER_INFO[3]} />);
    fireEvent.click(screen.getByText('目次'));
    expect(fireEvent.click(screen.getByText('最初から見る'))).toBe(true);
    await nextTick();
    expect(location.hash).toBe(`#${CHAPTER_INFO[0].id}`);
    unmount();
    render(<DemoSite start={CHAPTER_INFO[0]} />);
    fireEvent.click(screen.getByText('目次'));
    const reloaded = watchReload();
    expect(fireEvent.click(screen.getByText('最初から見る'))).toBe(false);
    expect(reloaded()).toBe(true);
  });

  it('帯の「ツアーを見る」は、最初の章からツアーを始める。最初の章のハッシュのままなら読み込み直す', async () => {
    const { unmount } = render(<DemoSite start={null} />);
    fireEvent.click(screen.getByText('自由に触る'));
    const start = screen.getByText('ツアーを見る');
    expect(start.getAttribute('href')).toBe(`#${CHAPTER_INFO[0].id}`);
    expect(fireEvent.click(start)).toBe(true);
    await nextTick();
    expect(location.hash).toBe(`#${CHAPTER_INFO[0].id}`);
    unmount();
    // 最初の章を見終えたあと（ハッシュは最初の章のまま）に、帯の「もう一度」を押したとき
    render(<DemoSite start={CHAPTER_INFO[0]} />);
    fromStage({ type: 'demo:phase', phase: 'done' });
    const reloaded = watchReload();
    expect(fireEvent.click(screen.getByText('もう一度'))).toBe(false);
    expect(reloaded()).toBe(true);
  });
});
