import { createHash } from 'node:crypto';

// スマホの画面の入口（remote.html。Issue #464）が読み込むスクリプトとスタイルに、完全性の検査（integrity）を付ける。
// 入口の HTML はキャッシュさせないので、キャッシュに残った古い・書き換えられたファイルを読まないようにする（設計の決まり）。
// ./assets/ の下で、ビルドの成果物にあるものだけに付ける（ほかのもの・もう付いているものは触らない）。
// 使うときに読み込むもの（Monaco など）は、HTML に名前が出ないので、ここでは付けない
export function addIntegrity(html: string, contentOf: (file: string) => string | Uint8Array | null): string {
  // タグと属性の名前は、大文字・小文字を区別しない（HTML の決まり）
  return html.replace(/<(script|link)\b([^>]*)>/gi, (tag, name: string, attrs: string) => {
    if (/\sintegrity=/i.test(attrs)) return tag;
    const ref = /\s(?:src|href)="\.\/(assets\/[^"]+)"/i.exec(attrs);
    if (!ref) return tag;
    const content = contentOf(ref[1]);
    if (content === null) return tag;
    const digest = createHash('sha384').update(content).digest('base64');
    const crossorigin = /\scrossorigin\b/i.test(attrs) ? '' : ' crossorigin';
    return `<${name}${attrs} integrity="sha384-${digest}"${crossorigin}>`;
  });
}
