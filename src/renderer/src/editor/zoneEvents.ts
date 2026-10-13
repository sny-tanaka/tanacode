// エディタに差し込む領域（行コメントやウォークスルーの吹き出し）で、クリックやキー入力をエディタに取られないようにする。
// ホイールは、ポインタの下にその向きへスクロールできるもの（あふれた入力欄・横に長いコード）があるときだけ止める。
// それ以外はエディタに渡すので、吹き出しの上でもエディタをスクロールできる
export function keepZoneEvents(node: HTMLElement): void {
  for (const type of ['mousedown', 'mouseup', 'click', 'keydown'] as const) node.addEventListener(type, (e) => e.stopPropagation());
  node.addEventListener('wheel', (e) => {
    if (scrollsInside(node, e)) e.stopPropagation();
  });
}

// ポインタの下の要素から領域までの間に、ホイールの向き（縦と横の大きいほう）へスクロールできるものがあるか
function scrollsInside(node: HTMLElement, e: WheelEvent): boolean {
  const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
  for (let el = e.target as Element | null; el && el !== node; el = el.parentElement) {
    const overflow = getComputedStyle(el)[vertical ? 'overflowY' : 'overflowX'];
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    // 1px の差は、大きさを整数に丸めたときのずれ（あふれてはいない）
    if ((vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth) > 1) return true;
  }
  return false;
}
