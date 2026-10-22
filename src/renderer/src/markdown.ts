import { marked, Tokenizer } from 'marked';
import markedCjkFriendly from 'marked-cjk-friendly';
import { t } from '@shared/i18n';

// CommonMark では「）**に」「」**です」のように、閉じる ** の前が記号で後ろが文字だと強調にならない。
// 日本語は単語の間に空白を入れないので、隣が日本語・中国語・韓国語の文字のときだけこの決まりを緩める
marked.use(markedCjkFriendly());

// 全角の記号（CJK の記号と句読点 U+3000〜303F・全角形 U+FF00〜FFEF。（）「」、。など）。URL には入らない
const NOT_IN_URL = /[　-〿＀-￯]/;

// 文中の URL の自動リンク。GFM は、空白か < までを URL とみなす。日本語は URL の前後を括弧や句読点で囲み（（https://…）・https://…。）、
// 空白を入れないので、そのままでは閉じ括弧や句読点、その後ろの文字までリンクになり、リンク先も壊れる。全角の記号の手前で切る
// （漢字・かな・英数字は URL に入りうる（https://ja.wikipedia.org/wiki/日本語）ので、切らない）
marked.use({
  tokenizer: {
    url(src) {
      const end = src.search(NOT_IN_URL);
      // 切る所が無ければ、標準の処理に任せる
      return end === -1 ? false : Tokenizer.prototype.url.call(this, src.slice(0, end));
    },
  },
});

export { marked };

// 外の画像（http(s) の src）。// で始まるものも、https:example.com のように // の無いものも、ブラウザは外へ読みにいく
const EXTERNAL_IMAGE = /^(?:https?:|\/\/)/i;

// 外の画像を、画像の代わりに「外部の画像: <URL>」のリンクにする（押すと、外部リンクと同じく既定のブラウザで開く）。
// 返答に ![](https://…/?q=<秘密>) が混ざると、描いた時点で秘密が外へ送られるため、外の画像は読み込まない（CSP でも止めている）。
// 文書に入れる前（DocumentFragment や template の中）で呼ぶ。入れてからでは読みにいってしまう
export function replaceExternalImages(root: ParentNode): void {
  for (const img of root.querySelectorAll('img')) {
    // srcset は src と別に読みにいくので、外かどうかにかかわらず外す（Markdown からは作られない）
    img.removeAttribute('srcset');
    const src = img.getAttribute('src')?.trim() ?? '';
    if (!EXTERNAL_IMAGE.test(src)) continue;
    const url = src.startsWith('//') ? `https:${src}` : src;
    const alt = img.getAttribute('alt')?.trim();
    // リンクの中の画像（[![バッジ](…)](…) など）は、リンクを入れ子にしないよう文字だけにする（押すと外側のリンクが開く）
    const inLink = !!img.closest('a');
    const note = img.ownerDocument.createElement(inLink ? 'span' : 'a');
    note.className = 'markdown-external-image';
    if (!inLink) {
      note.setAttribute('href', url);
      note.title = t('composer.markdown.openInBrowser');
    }
    note.textContent = alt ? t('composer.markdown.externalImageAlt', { alt, url }) : t('composer.markdown.externalImage', { url });
    img.replaceWith(note);
  }
}
