import { t } from './i18n';
import { neutralizeTags, unwrapWholePaste } from './session-tools';

// プロジェクトに置く、tanacode のセッションのための指示のファイル。置き場所は、セッションのフォルダの直下
// （worktree のセッションでそこに無ければ、元のリポジトリの直下。コミットしていない自分用のファイルも、子に渡るように）。
// TANACODE.md: tanacode で動くすべてのセッション（親にも子にも）に、SessionStart のフックで自動で渡す（main の instructions-hook.ts）。
// tanacode の外の claude には渡らない（CLAUDE.md とは別のもの）
export const INSTRUCTIONS_FILE = 'TANACODE.md';
// TANACODE_PARENT.md: 自動では渡さない。人が「親にする」（新規セッションの画面では「親として始める」）を押したときに 1 回だけ読ませる。
// 親の状態は覚えない（会話を消すと忘れるので、もう一度押す）
export const PARENT_INSTRUCTIONS_FILE = 'TANACODE_PARENT.md';

// TANACODE.md を渡す文の囲み。チャットには出さず、コンテキストの中身・読んだファイルの印では、そのファイルとして数える
export const INSTRUCTIONS_TAG = 'tanacode-instructions';
// TANACODE_PARENT.md を読ませる発言の囲み。チャットでは「親にした」知らせとして、人の発言と見分けて出す
export const PARENT_ROLE_TAG = 'tanacode-parent-role';

// Claude Code が hooks から受け取れる文は 1 万文字まで（超えるとファイルに書いて、先頭の 2,000 文字だけを渡す）。
// チェックリストの知らせと同じく、囲みと前書きまで含めてこれに収める。収まらないファイルは、中身の代わりに Read で読むよう頼む
export const MAX_INSTRUCTIONS_CHARS = 9_000;

// 囲みの中に、囲みを閉じるタグがあっても効かないようにする（ほかの tanacode- のタグは、ファイルの中身のまま渡す。
// TANACODE.md は発言ではなくフックの文なので、発言の行の読み分けに関わらない）
function neutralize(text: string, tag: string): string {
  return text.replace(new RegExp(`<(/?)(${tag})`, 'gi'), '＜$1$2');
}

// 属性に入れるパス（" を含むパスでも囲みを読めるように）
function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function unattribute(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

// SessionStart のフックで Claude に渡す、TANACODE.md の文。Claude だけが読むので英語（中身は書かれたまま）。
// sum: 中身の印（main の instructionsSum）。会話を再開したとき（resume）、最後に渡したものと同じなら渡し直さないのに使う
// 長すぎて中身を入れられないときは、中身の代わりに Read で読むよう頼み、囲みに印（omitted）を付ける（読んだファイルの印を付けない）
export function instructionsContext(path: string, content: string, sum: string): string {
  const head = `<${INSTRUCTIONS_TAG} path="${attribute(path)}" sum="${sum}"`;
  const close = `</${INSTRUCTIONS_TAG}>`;
  const about = `${INSTRUCTIONS_FILE} is the project's instructions for the Claude sessions that tanacode runs, kept at the root of the project next to CLAUDE.md. Follow it as you follow CLAUDE.md. tanacode passes it to every session it runs, and again after /clear and compaction.`;
  const body = neutralize(content.trim(), INSTRUCTIONS_TAG);
  const full = [`${head}>`, about, '', body, close].join('\n');
  if (full.length <= MAX_INSTRUCTIONS_CHARS) return full;
  return [
    `${head} omitted="true">`,
    `${about} It is too long to pass here (${content.length} characters): read the whole file (${path}) with the Read tool before you go on, and follow it.`,
    close,
  ].join('\n');
}

const INSTRUCTIONS_OPEN = new RegExp(`^<${INSTRUCTIONS_TAG} path="([^"]*)" sum="([0-9a-f]+)"( omitted="true")?>`);

// TANACODE.md を渡した文なら、そのファイルのパス・中身の印・中身を入れたか。違えば null
export function parseInstructions(text: string): { path: string; sum: string; full: boolean } | null {
  const m = INSTRUCTIONS_OPEN.exec(text.trimStart());
  return m ? { path: unattribute(m[1]), sum: m[2], full: !m[3] } : null;
}

// 「親にする」で送る発言。前書きは、チャットの知らせを開くと人にも見えるので、画面の言語で書く（見分けるのは囲みだけ）。
// rest: 一緒に送る最初の指示（新規セッションの画面の「親として始める」）。囲みのあとに続ける。
// 中身の tanacode のタグは、親からの指示の本文と同じく、すべて効かなくする（neutralizeTags）。発言の行は、Claude Code が順番待ちの発言を
// まとめた行を tanacode の囲みの切れ目で分けて読む（@shared/chat の mergedParts）ので、中身にタグがあると、途中で分かれてしまうため
export function parentRoleText(path: string, content: string, rest = ''): string {
  const block = [`<${PARENT_ROLE_TAG} path="${attribute(path)}">`, t('chat.parentRole.intro', { file: PARENT_INSTRUCTIONS_FILE }), '', neutralizeTags(content.trim()), `</${PARENT_ROLE_TAG}>`].join('\n');
  return rest.trim() ? `${block}\n\n${rest}` : block;
}

const PARENT_ROLE = new RegExp(`^<${PARENT_ROLE_TAG} path="([^"]*)">\\n?([\\s\\S]*?)\\n?</${PARENT_ROLE_TAG}>`);

// 「親にする」の発言なら、読ませたファイルのパス・囲みの中身（前書きと TANACODE_PARENT.md）・あとに続く最初の指示。違えば null。
// 会話ログでは、全体が貼り付けの囲み（<pasted_content>）に入ることがあるので、先に外す
export function parseParentRole(text: string): { path: string; body: string; rest: string } | null {
  const whole = unwrapWholePaste(text).trimStart();
  const m = PARENT_ROLE.exec(whole);
  return m ? { path: unattribute(m[1]), body: m[2].trim(), rest: whole.slice(m[0].length).replace(/^\s+/, '') } : null;
}
