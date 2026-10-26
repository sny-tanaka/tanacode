import type { FocusEvent, KeyboardEvent } from 'react';

// 一覧の行（クリックで動く div）の Enter を、クリックと同じ動きにする。
// 行の中のボタン・入力欄で押した Enter は、それぞれのものなので、行の Enter にしない。修飾キー付き（⌃Enter など）も、行ごとの別の操作に残す
export function clickOnEnter(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.target !== e.currentTarget || e.key !== 'Enter' || e.nativeEvent.isComposing) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  e.preventDefault();
  e.currentTarget.click();
  return true;
}

// キーで行（か、行の中の要素）に入っている間、行に data-key-focus を付ける。ホバーで出るボタンを、キーで入ったときも出すため（global.css）。
// :has(:focus-visible) で出すと、行の中でボタンからボタンへ Tab で移る一瞬（前のものから外れて、次に入る前）に消え、
// 消えた（display: none の）ボタンには移れない。属性は、行の外へ出たとき・マウスで押したときに外す
// 入力欄（セッションの名前を変える欄など）は、マウスで入っても :focus-visible になるので数えない。
// マウスで行を押して行にフォーカスが入ったとき（:focus-visible でない）は、外す。直す前（行に tabIndex が無かった）と同じく、
// フォーカスを body に置くため。行に残すと、押したあとの Enter が行を押し、↑↓・Space が押した場所（ツールの出力欄など）でなく
// 一覧を動かし、ダイアログを閉じてフォーカスを戻したときに枠とボタンが出る。
// 外すのは、マウスを離したとき（ドラッグなら終わったとき）。押している間に外すと、ドラッグで文字を選べなくなる。
// mousedown は止めない（文字の選択・カードのドラッグ・⌘⇧クリック・ダブルクリックを壊さないため）
function keyFocus(e: FocusEvent<HTMLElement>) {
  const row = e.currentTarget;
  if (e.target === row && !row.matches(':focus-visible')) {
    delete row.dataset.keyFocus;
    // 押している最中なら、離したときに外す（pointerDown で待っている）
    if (pressed !== row) row.blur();
    return;
  }
  if (e.target.matches(':focus-visible') && !e.target.matches('input, textarea')) row.dataset.keyFocus = '';
  else delete row.dataset.keyFocus;
}
function keyBlur(e: FocusEvent<HTMLElement>) {
  if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) delete e.currentTarget.dataset.keyFocus;
}
// マウスで押している行。離したとき（ドラッグなら終わったとき）に、行にフォーカスが残っていれば外す。
// キーで入った行を押したときも、フォーカスが動かず枠が残るので、離したときに外す
let pressed: HTMLElement | null = null;
const RELEASE = ['pointerup', 'pointercancel', 'dragend'] as const;
function pointerDown(e: { currentTarget: HTMLElement }) {
  const row = e.currentTarget;
  delete row.dataset.keyFocus;
  pressed = row;
  const release = () => {
    for (const type of RELEASE) window.removeEventListener(type, release, true);
    if (pressed === row) pressed = null;
    if (document.activeElement === row) row.blur();
  };
  for (const type of RELEASE) window.addEventListener(type, release, true);
}

// 一覧の行に付ける props。Tab で止まり、Enter でクリックと同じ動きをする。
// フォーカスの枠は、キーで入ったとき（:focus-visible）だけ出す（global.css の [data-key-row]）。
// 行ごとに別のキーを足すときは、onKeyDown を後ろに書いて差し替え、その中で clickOnEnter を呼ぶ
export const keyRow = {
  tabIndex: 0,
  'data-key-row': '',
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void clickOnEnter(e),
  onFocus: keyFocus,
  onBlur: keyBlur,
  onPointerDown: pointerDown,
} as const;
