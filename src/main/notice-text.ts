import type { Menu } from '@shared/screen';

// 通知の本文に出す長さ（これを超えたら切る）
const MAX_LENGTH = 100;

// 通知に出す短い文にする。改行と Markdown の印（`・*・#）を外して 1 行にし、長ければ切る
export function snippet(text: string): string {
  const flat = text.replace(/[`*#]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH)}…` : flat;
}

// 確認待ちの通知の本文。質問は質問文、許可は実行しようとしている内容（チャットの確認カードの上の補足）、
// それ以外は画面の見出し。読み取れなかったときは、種類だけを伝える
export function menuNotice(menu: Menu): string {
  if (menu.kind === 'question') return snippet(menu.title) || '質問しています';
  if (menu.kind === 'permission') {
    const detail = snippet(menu.context.join(' '));
    return detail ? `実行の許可: ${detail}` : '実行の許可を求めています';
  }
  const title = snippet(menu.title);
  return title ? `確認: ${title}` : '確認を求めています';
}
