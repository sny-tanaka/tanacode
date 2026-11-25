// スマホの画面のリンクの守り（Issue #464）。Mac の画面では、main の setWindowOpenHandler と will-navigate が
// 「http(s) だけ・外のブラウザで・画面は移らせない」を守っている。ふつうのブラウザには無いので、ここで補う。
// - window.open は、http(s) だけを、新しいタブに、開いた先から元の画面を触れない形（noopener・noreferrer）で開く
// - 押したリンク（a）は、画面が拾わなかったものも含めて、画面そのものは移らせない（外の http(s) は新しいタブに開く）。
//   画面が作ったファイルのダウンロード（download の付いた blob: のリンク）だけは通す

const external = (href: string, base: string): string | null => {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

export function guardLinks(win: Window): void {
  const open = win.open.bind(win);
  const openSafely = (href: string) => {
    const url = external(href, win.location.href);
    if (url) open(url, '_blank', 'noopener,noreferrer');
  };
  win.open = ((href?: string | URL) => {
    if (href !== undefined) openSafely(String(href));
    return null;
  }) as typeof win.open;
  // 押したリンクは、画面の部品が拾ったあと（泡立ちの終わり）で見る。拾われていても、画面は移らせない
  win.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href');
    if (!href || href.startsWith('#')) return;
    // 画面が作ったファイルのダウンロード（書き出しなど。remote/download.ts）は、そのまま通す（画面は移らない）
    if (anchor.hasAttribute('download') && href.startsWith('blob:')) return;
    const handled = event.defaultPrevented;
    event.preventDefault();
    if (!handled) openSafely(href);
  });
}
