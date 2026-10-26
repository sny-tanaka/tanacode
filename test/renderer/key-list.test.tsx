// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { keyList, keyRow } from '../../src/renderer/src/layout/keyRow';
import './dom';
import { focusByTab, key, pressTab, tabStops } from './keys';

// 一覧（layout/keyRow.ts の keyList）を、キーで動かす仕組みそのもの。各一覧での動きは、それぞれの部品のテストで確かめる

afterEach(cleanup);

// チャットの一覧と同じ形: ツールのカード（行）の間に、質問のカード（選択肢の一覧が入れ子）と入力欄がある
function Chat() {
  return (
    <div className="chat-list" {...keyList('last')}>
      <div {...keyRow} aria-label="カード A" />
      <div className="menu-options" {...keyList()}>
        <button className="menu-option">はい</button>
        <button className="menu-option">いいえ</button>
      </div>
      <textarea aria-label="答え" />
      <div {...keyRow} aria-label="カード B">
        <button>詳細を開く</button>
      </div>
    </div>
  );
}
const row = (name: string) => screen.getByLabelText(name);

describe('一覧（keyList）', () => {
  it('Tab で止まるのは、一覧ごとに 1 か所だけ。チャットは新しい方の端のカード。行の上のボタンは止めない。入れ子の一覧は別に数える', () => {
    render(<Chat />);
    pressTab();
    expect(tabStops()).toEqual([screen.getByText('はい'), row('カード B')]);
    expect(screen.getByText('詳細を開く').tabIndex).toBe(-1);
    // 入力欄は、そのまま止まる
    expect(screen.getByLabelText('答え').tabIndex).toBe(0);
  });

  it('↑↓ は入れ子の一覧（質問のカードの選択肢）を飛ばして、前後のカードへ。端では一覧を動かさず、キーをそのまま渡す（チャットのスクロール）', () => {
    render(<Chat />);
    focusByTab(row('カード B'));
    expect(key('ArrowUp')).toBe(false);
    expect(document.activeElement).toBe(row('カード A'));
    expect(key('ArrowUp')).toBe(true);
    expect(document.activeElement).toBe(row('カード A'));
    key('ArrowDown');
    expect(document.activeElement).toBe(row('カード B'));
    expect(key('ArrowDown')).toBe(true);
  });

  it('修飾キー付きの矢印キー（⌃⌘↑ などのショートカット・⇧ での選択）と、入力欄の矢印キーは、一覧のものにしない', () => {
    render(<Chat />);
    focusByTab(row('カード B'));
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect(key('ArrowUp', init)).toBe(true);
      expect(document.activeElement).toBe(row('カード B'));
    }
    focusByTab(screen.getByLabelText('答え'));
    expect(key('ArrowUp')).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('答え'));
  });

  it('→ で行の上のボタンへ、← で行へ戻る。ボタンにいる間も、行に data-key-focus を付けたまま（ホバーで出るボタンを出す）', () => {
    render(<Chat />);
    focusByTab(row('カード B'));
    key('ArrowRight');
    expect(document.activeElement).toBe(screen.getByText('詳細を開く'));
    expect(row('カード B').hasAttribute('data-key-focus')).toBe(true);
    // ボタンの ↑ も、前のカードへ
    key('ArrowUp');
    expect(document.activeElement).toBe(row('カード A'));
    expect(row('カード B').hasAttribute('data-key-focus')).toBe(false);
    focusByTab(row('カード B'));
    key('ArrowRight');
    key('ArrowLeft');
    expect(document.activeElement).toBe(row('カード B'));
  });

  it('一覧に入っていない行は、それぞれで Tab で止まる', () => {
    render(
      <>
        <div {...keyRow} aria-label="ひとつめ" />
        <div {...keyRow} aria-label="ふたつめ" />
      </>,
    );
    pressTab();
    expect(tabStops()).toEqual([row('ひとつめ'), row('ふたつめ')]);
  });
});
