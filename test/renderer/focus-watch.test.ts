// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FocusLostReport } from '@shared/ipc';
import { markHumanAction, watchChatFocus } from '../../src/renderer/src/chat/focusWatch';

// チャットの入力欄から、人の操作でないのにフォーカスが外れたら知らせる（main が focus.log に書く）。
// 人がマウスで押した・入力欄で変換していないキーを押した直後のものと、ウインドウごと離れたものは知らせない

let reports: FocusLostReport[];
let clock: number;
let windowFocused: boolean;
let stop: () => void;
let input: HTMLTextAreaElement;
let other: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = '<div class="chat-input"><textarea></textarea></div><div class="terminal-panel"><button aria-label="ほか">x</button></div>';
  input = document.querySelector('textarea')!;
  other = document.querySelector('button')!;
  reports = [];
  clock = 10_000;
  windowFocused = true;
  // ショートカットの時刻は、モジュールに 1 つ（前のテストのものを残さない）
  markHumanAction(Number.NEGATIVE_INFINITY);
  stop = watchChatFocus({ report: (r) => reports.push(r), now: () => clock, hasFocus: () => windowFocused, later: (run) => run() });
  input.focus();
});
afterEach(() => {
  stop();
  document.body.innerHTML = '';
});

const key = (target: Element, init: KeyboardEventInit & { keyCode?: number }) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  target.dispatchEvent(event);
};

describe('チャットの入力欄のフォーカスの見張り', () => {
  it('人の操作が無いのに、ほかの要素が focus() で奪ったら、移った先・外した処理のスタックを知らせる', () => {
    clock += 5000;
    other.focus();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: 'focusout', to: 'button[ほか] in .terminal-panel', composing: false, lastPointer: null, lastKey: null });
    expect(reports[0].stack).toContain('focus-watch.test.ts');
  });

  it('日本語を変換している途中に外れたら、変換中だったことと、直前のキーを知らせる', () => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    key(input, { key: 'Tab', code: 'Tab', isComposing: true, keyCode: 229 });
    clock += 20;
    other.focus();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ composing: true, lastKey: { msAgo: 20, key: 'Tab', keyCode: 229, isComposing: true } });
  });

  it('外れる直前に変換が終わった（Chromium は、フォーカスが移るときに focusout より先に変換を終わらせる）ときも、変換中だったとして知らせる', () => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    clock += 5000;
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    other.focus();
    expect(reports.map((r) => r.composing)).toEqual([true]);
  });

  it('マウスで押した直後・入力欄で変換していないキー（Tab など）を押した直後に外れたものは、人の操作なので知らせない', () => {
    other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    clock += 100;
    other.focus();
    input.focus();
    clock += 5000;
    key(input, { key: 'Tab', code: 'Tab', keyCode: 9 });
    clock += 30;
    other.focus();
    expect(reports).toEqual([]);
  });

  it('ショートカットをキー・メニューで動かして外れたものは、人の操作なので知らせない', () => {
    clock += 5000;
    markHumanAction(clock);
    clock += 50;
    other.focus();
    expect(reports).toEqual([]);
  });

  it('個人の情報を残さない: 要素の title（ページの題・URL・シェルの題）は使わず、打った文字のキーは伏せる', () => {
    other.setAttribute('title', 'https://example.com/?token=secret');
    other.removeAttribute('aria-label');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    key(input, { key: 'x', code: 'KeyX', keyCode: 88, isComposing: true });
    clock += 20;
    other.focus();
    // スタック（行番号の数字を含む）を除いた中身に、title と打った文字が入っていない
    const { stack: _, ...rest } = reports[0];
    expect(JSON.stringify(rest)).not.toMatch(/secret|example|KeyX|88/);
    expect(reports[0]).toMatchObject({ to: 'button in .terminal-panel', lastKey: { key: '文字', code: '', keyCode: 0 } });
  });

  it('ウインドウごと離れた（ほかのアプリへ移った）ときは知らせない', () => {
    clock += 5000;
    windowFocused = false;
    input.blur();
    expect(reports).toEqual([]);
  });

  it('入力欄が消えて、外れた知らせが無いままキーが body に届いたら、消えたことを知らせる', () => {
    clock += 5000;
    // jsdom も Chromium と同じく、フォーカスのある要素を消しても focusout を出さない
    input.remove();
    key(document.body, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(reports.map((r) => r.reason)).toEqual(['removed']);
    expect(reports[0].input.connected).toBe(false);
  });
});
