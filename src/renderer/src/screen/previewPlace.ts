// 選択肢のプレビューのポップアップ（QuestionCard の PreviewPopup）を置く場所。枠の位置と大きさだけで決める（画面の部品のテストで確かめる）

// ポップアップと画面の端との間
export const POPUP_MARGIN = 8;
// カードとポップアップの見える枠との間。ポップアップの、カードの側の透明な余白（global.css の .menu-preview-popup の padding と同じ）。
// マウスをカードからポップアップへ移す間に、両方から外れたことにしない
export const POPUP_GAP = 6;

// 画面の上の枠（getBoundingClientRect の形）
export type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number };

// ポップアップの見える枠の、限りを付けないときの大きさ。height: カードの上・下に出すときの高さ（プレビューの本文は高さを限る）/
// fullHeight: プレビューの本文の高さを限らないときの高さ（右に出すとき）
export type Natural = { width: number; height: number; fullHeight: number };

// 置く場所。side: カードのどちらに出すか。right: カードの右（チャット欄の外、エディタの側）/ top・bottom: カードの上・下（右に場所が
// 足りないとき）。ほかは、ポップアップ（透明な余白も含む）の style にそのまま渡す、画面の上の位置と大きさの限り
export type Place =
  | { side: 'right'; left: number; top: number; maxWidth: number; maxHeight: number; minHeight: number }
  | { side: 'top'; left: number; bottom: number; maxHeight: number; minWidth: number }
  | { side: 'bottom'; left: number; top: number; maxHeight: number; minWidth: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

// card: カードの枠 / option: プレビューを出す選択肢の枠 / view: ウインドウの大きさ。
// カードの右に出す。チャット欄はいつもエディタの左にあり、右は広い。プレビューは折り返さない図や表が多いので、横に広く、縦もウインドウの
// 高さまで使える。縦の位置は選択肢にそろえ、ウインドウの中に収める。カードの枠に 1px 重ね、選択肢には重ねない。
// 右に出すのは、プレビューの幅がまるごと入るか、右に出せる幅がカードの幅（上・下に出すときの、いちばん狭い幅）以上あるとき。
// どちらでもなければ（ウインドウが狭い・チャット欄を広げた）、前と同じくカードの上に出し、上に入りきらず下のほうが広ければ下に出す
export function placePreview(card: Box, option: Box, natural: Natural, view: { width: number; height: number }): Place {
  // 右に出せる、見える枠の幅
  const room = view.width - POPUP_MARGIN - (card.right - 1) - POPUP_GAP;
  if (room >= Math.min(natural.width, card.width)) {
    const maxHeight = Math.max(view.height - POPUP_MARGIN * 2, 0);
    // 選択肢の右は、ポップアップでまるごと覆う（真横に動かしたとき、カードからポップアップへ、外れる所なく移れる）
    const height = Math.min(Math.max(natural.fullHeight, option.height), maxHeight);
    return {
      side: 'right',
      left: card.right - 1,
      top: clamp(option.top, POPUP_MARGIN, view.height - POPUP_MARGIN - height),
      maxWidth: room + POPUP_GAP,
      maxHeight,
      minHeight: option.height,
    };
  }
  const above = card.top - POPUP_MARGIN;
  const below = view.height - POPUP_MARGIN - card.bottom;
  const top = natural.height + POPUP_GAP <= above || above >= below;
  const width = Math.min(Math.max(natural.width, card.width), view.width - POPUP_MARGIN * 2);
  const left = clamp(card.left, POPUP_MARGIN, view.width - POPUP_MARGIN - width);
  // カードの枠に 1px 重ねる（間に端数のすき間を作らない）
  const maxHeight = Math.max(top ? above : below, 0) + 1;
  return top
    ? { side: 'top', left, bottom: view.height - card.top - 1, maxHeight, minWidth: card.width }
    : { side: 'bottom', left, top: card.bottom - 1, maxHeight, minWidth: card.width };
}
