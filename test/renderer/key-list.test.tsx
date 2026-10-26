// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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
        {/* 開いたカードの出力欄（スクロールする欄。Tab で止まる） */}
        <pre tabIndex={0} aria-label="出力" />
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

  // 直す前: 行の中のどこで押した矢印キーも受けていたので、ツールのカードの出力欄で押した ↑↓・Home・End で、カードが移っていた（出力をキーで送れない）
  it('行の中の出力欄など（行でも行のボタンでもない所）で押した矢印キーは、ブラウザに渡す', () => {
    render(<Chat />);
    focusByTab(screen.getByLabelText('出力'));
    for (const name of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight']) {
      expect(key(name)).toBe(true);
      expect(document.activeElement).toBe(screen.getByLabelText('出力'));
    }
  });

  // 直す前: マウスで押した行も前にいた行として覚え、あとで Tab で入ったときにそこへ飛んでいた（チャットで昔のカードを押しておくと、上へ飛ぶ）
  it('前にいた行として覚えるのは、キーで入った行だけ。マウスで押した行は覚えない', () => {
    render(<Chat />);
    document.body.matches(':focus-visible');
    fireEvent.pointerDown(row('カード A'));
    fireEvent.mouseDown(row('カード A'));
    row('カード A').focus();
    fireEvent.pointerUp(window);
    expect(document.activeElement).toBe(document.body);
    pressTab();
    expect([row('カード A').tabIndex, row('カード B').tabIndex]).toEqual([-1, 0]);
    // キーで入った行は覚える
    focusByTab(row('カード A'));
    pressTab();
    expect([row('カード A').tabIndex, row('カード B').tabIndex]).toEqual([0, -1]);
  });

  // 直す前: 選んでいる行が変わっても（マウスで選んだ・⌃⌘↓）、前にいた行に止まり、⌘1 の行き先とも違っていた
  it('前にいた行を覚えたあとに選んでいる行が変わったら、選んでいる行に止まる', () => {
    const Rows = ({ selected }: { selected: string }) => (
      <div {...keyList()}>
        {['一', '二', '三'].map((name) => (
          <div key={name} {...keyRow} className={name === selected ? 'active' : ''} aria-label={name} />
        ))}
      </div>
    );
    const view = render(<Rows selected="一" />);
    focusByTab(row('三'));
    pressTab();
    expect(tabStops()).toEqual([row('三')]);
    view.rerender(<Rows selected="二" />);
    pressTab();
    expect(tabStops()).toEqual([row('二')]);
  });

  // 直す前: キーで操作した行が消えたり、別のセクションへ移って作り直されたりすると、フォーカスが body に落ち、矢印キーが効かなくなった
  // （ソース管理で → でステージのボタンへ移って Enter を押すと、ファイルの行がステージ済みへ移る）
  it('キーで操作した行が別のセクションへ移ったら、同じ行（data-key-id）へ、消えたら同じ位置の行へフォーカスを戻す', async () => {
    function Sections() {
      const [staged, setStaged] = useState<string[]>([]);
      const [gone, setGone] = useState<string[]>([]);
      const files = ['a.ts', 'b.ts', 'c.ts'].filter((f) => !gone.includes(f));
      const fileRow = (f: string, section: string) => (
        <div key={`${section}:${f}`} {...keyRow} data-key-id={f} aria-label={`${section} ${f}`}>
          <button onClick={() => setStaged((s) => [...s, f])}>ステージ {f}</button>
          <button onClick={() => setGone((g) => [...g, f])}>消す {f}</button>
        </div>
      );
      return (
        <div {...keyList()}>
          <section>{files.filter((f) => staged.includes(f)).map((f) => fileRow(f, 'ステージ済み'))}</section>
          <section>{files.filter((f) => !staged.includes(f)).map((f) => fileRow(f, '変更'))}</section>
        </div>
      );
    }
    render(<Sections />);
    focusByTab(row('変更 b.ts'));
    key('ArrowRight');
    expect(document.activeElement).toBe(screen.getByText('ステージ b.ts'));
    await act(async () => fireEvent.click(screen.getByText('ステージ b.ts')));
    expect(document.activeElement).toBe(row('ステージ済み b.ts'));
    expect(key('ArrowDown')).toBe(false);
    expect(document.activeElement).toBe(row('変更 a.ts'));
    // 消えたら、同じ位置（2 番目）の行へ
    key('ArrowRight');
    key('ArrowRight');
    await act(async () => fireEvent.click(screen.getByText('消す a.ts')));
    expect(document.activeElement).toBe(row('変更 c.ts'));
  });

  it('マウスで押したあとに行が消えても、フォーカスを動かさない（マウスで使ったときの動きは変えない）', async () => {
    function Gone() {
      const [shown, setShown] = useState(true);
      return (
        <div {...keyList()}>
          {shown && (
            <div {...keyRow} aria-label="消える行">
              <button onClick={() => setShown(false)}>消す</button>
            </div>
          )}
          <div {...keyRow} aria-label="残る行" />
        </div>
      );
    }
    render(<Gone />);
    focusByTab(row('消える行'));
    // マウスで、ボタンを押す
    fireEvent.pointerDown(screen.getByText('消す'));
    await act(async () => fireEvent.click(screen.getByText('消す')));
    expect(document.activeElement).toBe(document.body);
  });
});
