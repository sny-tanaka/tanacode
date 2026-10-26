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
// 入力欄（セッションの名前を変える欄など）は、マウスで入っても :focus-visible になるので数えない
function keyFocus(e: FocusEvent<HTMLElement>) {
  if (e.target.matches(':focus-visible') && !e.target.matches('input, textarea')) e.currentTarget.dataset.keyFocus = '';
  else delete e.currentTarget.dataset.keyFocus;
}
function keyBlur(e: FocusEvent<HTMLElement>) {
  if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) delete e.currentTarget.dataset.keyFocus;
}
// キーで入った行をマウスで押したときは、フォーカスが動かず枠が残るので、いったん外す（押した続きで、マウスで入り直す）
function pointerDown(e: { currentTarget: HTMLElement }) {
  delete e.currentTarget.dataset.keyFocus;
  if (document.activeElement === e.currentTarget) e.currentTarget.blur();
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
