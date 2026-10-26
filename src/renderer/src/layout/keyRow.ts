import type { FocusEvent, KeyboardEvent } from 'react';
import { enteredByKey, focusByKey, isHidden } from './shortcuts';

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
// :has(:focus-visible) で出すと、行の中でボタンからボタンへ（→ で）移る一瞬（前のものから外れて、次に入る前）に消え、
// 消えた（display: none の）ボタンには移れない。属性は、行の外へ出たとき・マウスで押したときに外す
// キーで入ったかは、shortcuts.ts の enteredByKey で見る（入力欄は数えない。ショートカット（⌘1 など）で移したときは数える）。
// マウスで行を押して行にフォーカスが入ったとき（キーで入っていない）は、外す。直す前（行に tabIndex が無かった）と同じく、
// フォーカスを body に置くため。行に残すと、押したあとの Enter が行を押し、↑↓・Space が押した場所（ツールの出力欄など）でなく
// 一覧を動かし、ダイアログを閉じてフォーカスを戻したときに枠とボタンが出る。
// 外すのは、マウスを離したとき（ドラッグなら終わったとき）。押している間に外すと、ドラッグで文字を選べなくなる。
// mousedown は止めない（文字の選択・カードのドラッグ・⌘⇧クリック・ダブルクリックを壊さないため）
function keyFocus(e: FocusEvent<HTMLElement>) {
  const row = e.currentTarget;
  if (enteredByKey(e.target)) {
    row.dataset.keyFocus = '';
    return;
  }
  delete row.dataset.keyFocus;
  // 押している最中なら、離したときに外す（pointerDown で待っている）
  if (e.target === row && pressed !== row) row.blur();
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

// 一覧の行に付ける props。一覧（keyList）の中で、Tab で止まるのは 1 行だけ（tabIndex は keyList が付け替える）。Enter でクリックと同じ動きをする。
// フォーカスの枠は、キーで入ったとき（:focus-visible）だけ出す（global.css の [data-key-row]）。
// 行ごとに別のキーを足すときは、onKeyDown を後ろに書いて差し替え、その中で clickOnEnter を呼ぶ。
// 開け閉めする行（押すと開け閉めする）には data-key-open（"true" / "false"）を、ツリーの行には data-key-level（深さ。1 から）を付ける
export const keyRow = {
  tabIndex: -1,
  'data-key-row': '',
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void clickOnEnter(e),
  onFocus: keyFocus,
  onBlur: keyBlur,
  onPointerDown: pointerDown,
} as const;

// ---- 一覧（行を並べたもの）を、キーで動かす ----
// Tab は一覧の間を移るだけにする（ロービングタブインデックス）。一覧の中で Tab で止まるのは、今の行 1 つだけ。
// 今の行は、前にいた行（覚えていれば）、選んでいる行（.active）、最初の行（チャットは最後の行）の順に決める。
// 一覧の中は、↑↓ で行を移り、Home・End で先頭・末尾へ。→ ← で、行の上のボタンへ移る（ボタンにいる間は、keyRow の data-key-focus でボタンを出したまま）。
// 開け閉めする行（data-key-open）は、→ で開き、← で閉じる。開いているときの → は、ボタンがあればボタンへ、無ければ最初の子へ。
// 閉じている（か、開け閉めしない）行の ← は、親の行（data-key-level が小さい、前の行）へ。
// 行は [data-key-row]（keyRow）と、質問・許可のカードの選択肢（.menu-option）。行の中のボタン（button・リンク）は Tab で止めない
const ITEM = '[data-key-row], .menu-option';
const CONTROL = 'button, a[href]';
const TEXT_FIELD = 'input, textarea, select, [contenteditable="true"]';

// 一覧の中で、今の行（Tab で入る行）として覚えている行
const remembered = new WeakMap<Element, HTMLElement>();

const ownList = (el: Element) => el.closest('[data-key-list]');
// 一覧の行（入れ子の一覧の行は入れない。隠しているもの・押せない選択肢は飛ばす）
function itemsOf(list: Element): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(ITEM)].filter((el) => ownList(el) === list && !isHidden(el) && !(el as HTMLButtonElement).disabled);
}
// 行の上のボタン（入れ子の行・一覧のものは入れない）
function controlsOf(item: HTMLElement): HTMLElement[] {
  return [...item.querySelectorAll<HTMLElement>(CONTROL)].filter((el) => el.closest(ITEM) === item && !(el as HTMLButtonElement).disabled);
}
const levelOf = (item: HTMLElement) => Number(item.dataset.keyLevel ?? 0);

// 一覧の、前にいた行か、選んでいる行
export function chosenItem(list: Element): HTMLElement | null {
  const items = itemsOf(list);
  const kept = remembered.get(list);
  if (kept && items.includes(kept)) return kept;
  return items.find((el) => el.classList.contains('active')) ?? items.find((el) => el.classList.contains('active-within')) ?? null;
}
// 一覧の今の行（Tab で入る行）
function currentItem(list: Element): HTMLElement | null {
  const items = itemsOf(list);
  return chosenItem(list) ?? (list.getAttribute('data-key-list') === 'last' ? items.at(-1) : items[0]) ?? null;
}

// 一覧の tabindex を付け替える（今の行だけ 0、ほかの行と、行の上のボタンは -1）。Tab を押したときに、ページの中のすべての一覧で行う
export function syncKeyLists(root: ParentNode = document): void {
  for (const list of root.querySelectorAll('[data-key-list]')) {
    const current = currentItem(list);
    for (const item of list.querySelectorAll<HTMLElement>(ITEM)) {
      if (ownList(item) !== list) continue;
      item.tabIndex = item === current ? 0 : -1;
      for (const control of item.querySelectorAll<HTMLElement>(CONTROL)) if (control.closest(ITEM) === item) control.tabIndex = -1;
    }
  }
  // 一覧に入っていない行は、それぞれで止まる
  for (const row of root.querySelectorAll<HTMLElement>('[data-key-row]')) if (!ownList(row)) row.tabIndex = 0;
}
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Tab') syncKeyLists();
    },
    true,
  );
}

// 一覧の中に入った行を、今の行として覚える
function listFocus(e: FocusEvent<HTMLElement>) {
  const item = e.target.closest<HTMLElement>(ITEM);
  if (item && ownList(item) === e.currentTarget) remembered.set(e.currentTarget, item);
}

function move(to: HTMLElement | null | undefined, e: KeyboardEvent<HTMLElement>) {
  if (!to) return;
  e.preventDefault();
  focusByKey(to);
  to.scrollIntoView?.({ block: 'nearest' });
}

function listKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.defaultPrevented || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const list = e.currentTarget;
  const target = e.target as HTMLElement;
  // マウスで押した選択肢・ボタンの上（キーで入っていない）では動かさない（直す前と同じ）。入力欄の矢印キーは、入力欄のもの
  if (target.matches(TEXT_FIELD) || !enteredByKey(target)) return;
  const item = target.closest<HTMLElement>(ITEM);
  if (!item || ownList(item) !== list) return;
  const items = itemsOf(list);
  const index = items.indexOf(item);
  const controls = controlsOf(item);
  const onItem = target === item;
  const open = item.dataset.keyOpen;
  switch (e.key) {
    case 'ArrowDown':
      return move(items[index + 1], e);
    case 'ArrowUp':
      return move(index > 0 ? items[index - 1] : null, e);
    case 'Home':
      return move(items[0], e);
    case 'End':
      return move(items.at(-1), e);
    case 'ArrowRight':
      if (!onItem) return move(controls[controls.indexOf(target) + 1], e);
      if (open === 'false') {
        e.preventDefault();
        item.click();
        return;
      }
      if (controls.length > 0) return move(controls[0], e);
      if (open === 'true' && levelOf(items[index + 1] ?? item) > levelOf(item)) return move(items[index + 1], e);
      return;
    case 'ArrowLeft':
      if (!onItem) return move(controls[controls.indexOf(target) - 1] ?? item, e);
      if (open === 'true') {
        e.preventDefault();
        item.click();
        return;
      }
      if (levelOf(item) > 1) return move(items.slice(0, index).reverse().find((el) => levelOf(el) < levelOf(item)), e);
      return;
  }
}

// 一覧（行を並べたもの）に付ける props。from: 覚えている行も選んでいる行も無いとき、Tab で入る行（チャットは、新しい方の端）
export function keyList(from: 'first' | 'last' = 'first') {
  return { 'data-key-list': from, onKeyDown: listKeys, onFocus: listFocus } as const;
}
