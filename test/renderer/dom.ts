// jsdom に無いもの（画面の部品が使う）を、何もしないものとして補う。テストのファイルの先頭で読み込む
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!window.requestAnimationFrame) window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
if (!window.ResizeObserver)
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

// :focus-visible の見分け。jsdom 31 は :focus-visible を :focus と同じに見る（何の操作で入ったかを見分けない）。
// 本物のブラウザ（Chromium）は、マウスで押して入ったフォーカスは :focus-visible にしない（入力欄は除く）。画面の部品はこの違いを使うので、ブラウザと同じに見分けて補う。
// 見分け方: 最後の操作がマウス（pointerdown・mousedown）か、キー（keydown）かを覚え、フォーカスが入ったときに決める
// （スクリプトの focus() も、直前の操作で決まる。何も操作していなければ、キーと同じに見る）。
// 入ったあとでキーを押しても変えない（Chromium は変えることがあるが、jsdom 30 までと同じく、入ったときだけで決める）
const TEXT_FIELD = 'input:not([type="button"], [type="submit"], [type="reset"], [type="checkbox"], [type="radio"], [type="file"], [type="image"], [type="color"], [type="range"]), textarea, [contenteditable="true"], [contenteditable=""]';
const { matches, closest } = Element.prototype;
let byPointer = false;
// 見分けた要素（decided）と、それが :focus-visible か（visible）
let decided: Element | null = null;
let visible = false;
const decide = (el: Element | null) => {
  decided = el;
  visible = !!el && (!byPointer || matches.call(el, TEXT_FIELD));
};
window.addEventListener('pointerdown', () => (byPointer = true), true);
window.addEventListener('mousedown', () => (byPointer = true), true);
window.addEventListener('keydown', () => (byPointer = false), true);
// フォーカスが入ったときに決める（入ったあとの操作で変えないため）。
// 画面の部品の focusin（このファイルより先に読み込んだもの）は、こちらより先に :focus-visible を調べるので、調べたときにまだ決めていなければ、そこで決める
document.addEventListener('focusin', (e) => decide(e.target instanceof Element ? e.target : null), true);
// 外れたら忘れる（同じ要素にまた入ったときに、前に入ったときの見分けを使わない）
document.addEventListener('focusout', () => decide(null), true);
const isFocusVisible = () => {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (active !== decided) decide(active);
  return visible;
};
// :focus-visible は :focus の一部なので、フォーカスのある要素が :focus-visible なら :focus に、でなければ何にも合わないものに書き換えて調べる
const rewrite = (selectors: string) => (selectors.includes(':focus-visible') ? selectors.replaceAll(':focus-visible', isFocusVisible() ? ':focus' : ':not(*)') : selectors);
const elementQuery = { one: Element.prototype.querySelector, all: Element.prototype.querySelectorAll };
const documentQuery = { one: Document.prototype.querySelector, all: Document.prototype.querySelectorAll };
Element.prototype.matches = function (this: Element, selectors: string) {
  return matches.call(this, rewrite(selectors));
} as typeof Element.prototype.matches;
Element.prototype.closest = function (this: Element, selectors: string) {
  return closest.call(this, rewrite(selectors));
} as typeof Element.prototype.closest;
Element.prototype.querySelector = function (this: Element, selectors: string) {
  return elementQuery.one.call(this, rewrite(selectors));
} as typeof Element.prototype.querySelector;
Element.prototype.querySelectorAll = function (this: Element, selectors: string) {
  return elementQuery.all.call(this, rewrite(selectors));
} as typeof Element.prototype.querySelectorAll;
Document.prototype.querySelector = function (this: Document, selectors: string) {
  return documentQuery.one.call(this, rewrite(selectors));
} as typeof Document.prototype.querySelector;
Document.prototype.querySelectorAll = function (this: Document, selectors: string) {
  return documentQuery.all.call(this, rewrite(selectors));
} as typeof Document.prototype.querySelectorAll;
