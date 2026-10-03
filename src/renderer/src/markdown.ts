import { marked } from 'marked';
import markedCjkFriendly from 'marked-cjk-friendly';

// CommonMark では「）**に」「」**です」のように、閉じる ** の前が記号で後ろが文字だと強調にならない。
// 日本語は単語の間に空白を入れないので、隣が日本語・中国語・韓国語の文字のときだけこの決まりを緩める
marked.use(markedCjkFriendly());

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
      note.title = '既定のブラウザで開く';
    }
    note.textContent = alt ? `外部の画像（${alt}）: ${url}` : `外部の画像: ${url}`;
    img.replaceWith(note);
  }
}
