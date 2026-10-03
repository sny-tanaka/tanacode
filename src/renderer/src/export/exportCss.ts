// 書き出した HTML に入れる CSS。画面の CSS（global.css）の元の文字から、中身に当たる規則だけを抜き出す。
// ブラウザが読み込んだ規則（CSSRule.cssText）を書き戻すと、var() を使った一括指定（background: var(--grad) …）の後ろに
// 個別の指定（background-clip など）があるとき、値が空になって消える。そのため、読み込んだものではなく元の文字を使う

// selectorMatches: その規則のセレクタ（カンマでつながったもの）に当たる要素が、書き出した中身にあるか
export function usedCss(css: string, selectorMatches: (selector: string) => boolean): string {
  return usedBlocks(css.replace(/\/\*[\s\S]*?\*\//g, ''), selectorMatches).join('\n');
}

function usedBlocks(css: string, selectorMatches: (selector: string) => boolean): string[] {
  const out: string[] = [];
  for (const { prelude, body } of cssBlocks(css)) {
    if (/^@(media|supports)\b/.test(prelude)) {
      const inner = usedBlocks(body, selectorMatches);
      if (inner.length > 0) out.push(`${prelude} {\n${inner.join('\n')}\n}`);
    } else if (!prelude.startsWith('@')) {
      if (selectorMatches(prelude)) out.push(`${prelude} {${body}}`);
    }
    // @font-face（フォントのファイルは入れない）・@keyframes（動きは止める）などは入れない
  }
  return out;
}

// いちばん外側の規則ごとに、前置き（セレクタや @media …）と中身に分ける。中の入れ子（@starting-style など）は中身のまま残す
export function cssBlocks(css: string): { prelude: string; body: string }[] {
  const blocks: { prelude: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let open = -1;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        blocks.push({ prelude: css.slice(start, open).trim(), body: css.slice(open + 1, i) });
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      // @import などの 1 行の規則は入れない
      start = i + 1;
    }
  }
  return blocks;
}

// 状態で変わるもの。外しても当たる要素があれば、その状態のときの見た目も入れる
const STATEFUL =
  /::?(?:hover|active|focus-visible|focus-within|focus|visited|link|target|disabled|enabled|checked|placeholder-shown|placeholder|selection|before|after|marker|backdrop|first-letter|first-line|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?|\[open\]/g;

// セレクタ（カンマでつながったもの）のどれかに当たる要素が doc にあるか。ホバー・フォーカス・開いたとき（[open]）などの状態は外して見る
export function matchesIn(doc: ParentNode): (selector: string) => boolean {
  return (selectorText) =>
    splitSelectors(selectorText).some((selector) => {
      const stripped = selector.replace(STATEFUL, '').trim();
      // スクロールバーなど、要素を選ばないもの
      if (!stripped) return true;
      try {
        return doc.querySelector(stripped) !== null;
      } catch {
        // 外した結果が書き方として崩れたもの（:not(:hover) など）は、入れておく
        return true;
      }
    });
}

// カンマで分ける（:is(a, b) や [title="a,b"] の中のカンマでは分けない）
function splitSelectors(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
