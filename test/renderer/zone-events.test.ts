// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepZoneEvents } from '../../src/renderer/src/editor/zoneEvents';

// エディタに差し込む領域（行コメントやウォークスルーの吹き出し）が、どの操作をエディタに渡すか。
// エディタは、領域の外側（親）でイベントを受ける。親まで届けばエディタが動き、届かなければ吹き出しの中だけで済む

// jsdom は大きさを計算しない（どれも 0）ので、中身と見えている大きさを決めておく
function sized(el: HTMLElement, size: { scrollHeight?: number; clientHeight?: number; scrollWidth?: number; clientWidth?: number }): void {
  for (const [key, value] of Object.entries(size)) Object.defineProperty(el, key, { value, configurable: true });
}

// 吹き出しの領域と、エディタの側で受ける関数
function zone(html: string): { node: HTMLElement; reached: ReturnType<typeof vi.fn> } {
  const editor = document.createElement('div');
  const node = document.createElement('div');
  node.innerHTML = html;
  editor.appendChild(node);
  document.body.appendChild(editor);
  keepZoneEvents(node);
  const reached = vi.fn();
  for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'wheel']) editor.addEventListener(type, reached);
  return { node, reached };
}

const wheel = (target: Element, delta: { deltaX?: number; deltaY?: number }): boolean => target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...delta }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keepZoneEvents（エディタに差し込む領域のイベント）', () => {
  it('クリックとキー入力は、エディタに渡さない', () => {
    const { node, reached } = zone('<button>次へ</button>');
    const button = node.querySelector('button')!;
    for (const type of ['mousedown', 'mouseup', 'click']) button.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(reached).not.toHaveBeenCalled();
  });

  it('スクロールできるものが無いところのホイールは、エディタに渡す（吹き出しの上でもエディタをスクロールできる）', () => {
    const { node, reached } = zone('<p>説明</p>');
    wheel(node.querySelector('p')!, { deltaY: 40 });
    wheel(node, { deltaY: -40 });
    expect(reached).toHaveBeenCalledTimes(2);
  });

  it('あふれた入力欄の上のホイールは、エディタに渡さない（欄の中がスクロールする）', () => {
    const { node, reached } = zone('<textarea style="overflow-y: auto"></textarea>');
    const input = node.querySelector('textarea')!;
    sized(input, { scrollHeight: 300, clientHeight: 66 });
    wheel(input, { deltaY: 40 });
    expect(reached).not.toHaveBeenCalled();
  });

  it('あふれていない入力欄の上のホイールは、エディタに渡す', () => {
    const { node, reached } = zone('<textarea style="overflow-y: auto"></textarea>');
    const input = node.querySelector('textarea')!;
    sized(input, { scrollHeight: 66, clientHeight: 66 });
    wheel(input, { deltaY: 40 });
    // 1px の差は、大きさを整数に丸めたときのずれ
    sized(input, { scrollHeight: 67, clientHeight: 66 });
    wheel(input, { deltaY: 40 });
    expect(reached).toHaveBeenCalledTimes(2);
  });

  it('横に長いコードの上では、横のホイールだけを止める（縦はエディタに渡す）', () => {
    const { node, reached } = zone('<pre style="overflow-x: auto"><code><span>const a = 1;</span></code></pre>');
    const pre = node.querySelector('pre')!;
    sized(pre, { scrollWidth: 900, clientWidth: 400, scrollHeight: 40, clientHeight: 40 });
    const inside = node.querySelector('span')!;
    wheel(inside, { deltaX: 40 });
    expect(reached).not.toHaveBeenCalled();
    wheel(inside, { deltaY: 40 });
    // 斜めに動かしたときは、大きいほうの向きで決める
    wheel(inside, { deltaX: 5, deltaY: 40 });
    expect(reached).toHaveBeenCalledTimes(2);
    wheel(inside, { deltaX: 40, deltaY: 5 });
    expect(reached).toHaveBeenCalledTimes(2);
  });

  it('止めるときも、既定の動き（欄の中のスクロール）は取り消さない', () => {
    const { node } = zone('<textarea style="overflow-y: auto"></textarea>');
    const input = node.querySelector('textarea')!;
    sized(input, { scrollHeight: 300, clientHeight: 66 });
    expect(wheel(input, { deltaY: 40 })).toBe(true);
  });
});
