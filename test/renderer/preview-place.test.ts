import { describe, expect, it } from 'vitest';
import { placePreview, POPUP_GAP, POPUP_MARGIN, type Box } from '../../src/renderer/src/screen/previewPlace';

// 選択肢のプレビューのポップアップを置く場所（previewPlace.ts）。カードの右に、選択肢の高さにそろえて出す。
// 右に場所が足りなければ、前と同じくカードの上（入りきらず下のほうが広ければ下）に出す

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height, right: left + width, bottom: top + height });
const view = { width: 1600, height: 960 };
// チャット欄の中のカード（幅 360）と、その 2 つめの選択肢
const card = box(200, 500, 360, 300);
const option = box(212, 600, 336, 56);

describe('placePreview', () => {
  it('右に場所があれば、カードの右に出す。カードの枠に 1px 重ね、選択肢の高さにそろえ、右の幅とウインドウの高さまで使う', () => {
    const room = view.width - POPUP_MARGIN - (card.right - 1) - POPUP_GAP;
    expect(placePreview(card, option, { width: 500, height: 200, fullHeight: 200 }, view)).toEqual({
      side: 'right',
      left: card.right - 1,
      top: option.top,
      maxWidth: room + POPUP_GAP,
      maxHeight: view.height - POPUP_MARGIN * 2,
      // 選択肢の右は、まるごと覆う（真横に動かしたとき、カードからポップアップへ、外れる所なく移れる）
      minHeight: option.height,
    });
  });

  it('右に出すとき、ウインドウの下からはみ出す分は上へずらす。ウインドウより高ければ、ウインドウの高さで中をスクロールする', () => {
    // 本文の高さを限らないときの高さ（fullHeight）で決める（上・下に出すときの、本文の高さを限った高さではない）
    expect(placePreview(card, option, { width: 300, height: 340, fullHeight: 700 }, view)).toMatchObject({ side: 'right', top: view.height - POPUP_MARGIN - 700 });
    expect(placePreview(card, option, { width: 300, height: 340, fullHeight: 2000 }, view)).toMatchObject({ side: 'right', top: POPUP_MARGIN, maxHeight: view.height - POPUP_MARGIN * 2 });
    // 上にはみ出す選択肢（一覧をスクロールした）でも、ウインドウの中に出す
    expect(placePreview(card, box(212, -20, 336, 56), { width: 300, height: 100, fullHeight: 100 }, view)).toMatchObject({ side: 'right', top: POPUP_MARGIN });
  });

  it('右に出せる幅が、プレビューの幅にもカードの幅にも足りなければ、カードの上に出す（上に入りきらず、下のほうが広ければ下）', () => {
    // ウインドウが狭い・チャット欄を広げた: カードの右に 200px しか無い
    const narrow = { width: card.right + 200, height: 960 };
    const natural = { width: 500, height: 200, fullHeight: 200 };
    expect(placePreview(card, option, natural, narrow)).toEqual({
      side: 'top',
      left: card.left,
      bottom: narrow.height - card.top - 1,
      maxHeight: card.top - POPUP_MARGIN + 1,
      minWidth: card.width,
    });
    // カードが上のほうにあり、上に入りきらない
    const high = box(200, 100, 360, 300);
    expect(placePreview(high, option, natural, narrow)).toMatchObject({ side: 'bottom', top: high.bottom - 1, maxHeight: narrow.height - POPUP_MARGIN - high.bottom + 1 });
  });

  it('右に出せる幅がカードの幅より狭くても、プレビューがまるごと入れば右に出す', () => {
    const narrow = { width: card.right + 200, height: 960 };
    expect(placePreview(card, option, { width: 180, height: 120, fullHeight: 120 }, narrow)).toMatchObject({ side: 'right' });
    expect(placePreview(card, option, { width: 190, height: 120, fullHeight: 120 }, narrow)).toMatchObject({ side: 'top' });
  });
});
