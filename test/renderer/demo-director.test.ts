// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Director } from '../../src/renderer/src/demo/director';
import './dom';

// デモのツアーの操作係（src/renderer/src/demo/director.ts）。
// 待ち時間 0 で流すとき（CI の tour・tour-sp）や遅い端末では、画面が押せる状態になる前に台本が押しに来ることがある。
// 無効のボタンを押しても何も起きず、台本は押したあとの知らせ（書き出し・送信など）を待ち続けて止まってしまう

beforeAll(() => {
  // jsdom に無い。押す場所にある要素は、押そうとしている要素そのものとする
  document.elementFromPoint = () => document.querySelector('[data-target]');
  // jsdom のマウスの出来事は、テストの環境の window を view に渡すと作れないので、view を見ない出来事にする
  // （押したことは、ボタンの click() が起こす本物の click で確かめる）
  class PlainMouseEvent extends Event {}
  vi.stubGlobal('MouseEvent', PlainMouseEvent);
  vi.stubGlobal('PointerEvent', PlainMouseEvent);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function button(disabled: boolean): { el: HTMLButtonElement; onClick: ReturnType<typeof vi.fn> } {
  const el = document.createElement('button');
  el.dataset.target = '';
  el.disabled = disabled;
  const onClick = vi.fn();
  el.addEventListener('click', onClick);
  document.body.append(el);
  return { el, onClick };
}

describe('Director.click（台本がボタンを押す）', () => {
  it('無効のボタンは、押せるようになるまで待ってから押す', async () => {
    const { el, onClick } = button(true);
    const d = new Director({ x: 0, y: 0 });
    setTimeout(() => (el.disabled = false), 300);
    await d.click(el, { ms: 0 });
    expect(onClick).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it('押せるボタンは、そのまま押す', async () => {
    const { el, onClick } = button(false);
    const d = new Director({ x: 0, y: 0 });
    await d.click(el, { ms: 0 });
    expect(onClick).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it('いつまでも押せないボタンは、押さずに止める（押したつもりで先へ進まない）', async () => {
    vi.useFakeTimers();
    try {
      const { el, onClick } = button(true);
      const d = new Director({ x: 0, y: 0 });
      const clicked = d.click(el, { ms: 0 });
      const failed = expect(clicked).rejects.toThrow('押せるようになりません');
      await vi.advanceTimersByTimeAsync(20_000);
      await failed;
      expect(onClick).not.toHaveBeenCalled();
      d.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
