// global.css の :root に置いたカラートークンを読む（Monaco・xterm など、CSS で色を指定できないところ用）。
// CSS が当たる前は空になるので、モジュールの読み込み時ではなく使うときに呼ぶ
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}
