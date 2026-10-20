import { t } from './i18n';
import { neutralizeTags, unwrapWholePaste } from './session-tools';

// tanacode のセッションのための指示のファイル。置き場所は、Claude Code のプロファイルのフォルダ（そのセッションの CLAUDE_CONFIG_DIR。
// ~/.claude など。そのプロファイルで動くすべてのセッションに）と、セッションのフォルダの直下。両方あれば、両方を渡す（CLAUDE.md と同じく
// プロファイル → フォルダの順）。セッションのフォルダの直下
// （worktree のセッションでそこに無ければ、元のリポジトリの直下。コミットしていない自分用のファイルも、子に渡るように。
// worktree にファイルがあれば、使えなくても元には戻らない。main の readInstructions）。
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

// 属性に入れるパス（" を含むパスでも囲みを読めるように）
function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function unattribute(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

// SessionStart のフックで Claude に渡す、TANACODE.md の文（files はプロファイル → フォルダの順。CLAUDE.md と同じ）。ファイルごとに 1 つの囲み。
// Claude だけが読むので英語（中身は書かれたまま。ただし tanacode のタグは、「親にする」の発言と同じく、どれも効かなくする
// （neutralizeTags。囲みを閉じさせない・tanacode からの知らせに見せない））。
// sum: 中身の印（main の instructionsSum）。会話を再開したとき（resume）、最後に渡したものと同じなら渡し直さないのに使う。
// 全部で上限（MAX_INSTRUCTIONS_CHARS）に収まらないときは、大きいものから、中身の代わりに Read で読むよう頼む形にし、囲みに印（omitted）を
// 付ける（読んだファイルの印を付けない）
export function instructionsContext(files: readonly { path: string; content: string; sum: string }[]): string {
  const blocks = files.map((file) => ({ file, full: instructionsBlock(file, true), short: instructionsBlock(file, false), omitted: false }));
  const total = () => blocks.map((b) => (b.omitted ? b.short : b.full)).join('\n\n');
  for (const block of [...blocks].sort((a, b) => b.full.length - a.full.length)) {
    if (total().length <= MAX_INSTRUCTIONS_CHARS) break;
    block.omitted = true;
  }
  return total();
}

// 1 つのファイルの囲み。full: 中身を入れる（false なら、Read で読むよう頼む）
function instructionsBlock({ path, content, sum }: { path: string; content: string; sum: string }, full: boolean): string {
  const head = `<${INSTRUCTIONS_TAG} path="${attribute(path)}" sum="${sum}"`;
  const close = `</${INSTRUCTIONS_TAG}>`;
  const about = `${INSTRUCTIONS_FILE} is the instructions for the Claude sessions that tanacode runs, kept in the Claude Code profile's folder (for every session of the profile) or in the session's folder (for a worktree session, it can come from the original repository). Follow it as you follow CLAUDE.md. tanacode passes it to every session it runs, and again after /clear and compaction.`;
  if (full) return [`${head}>`, about, '', neutralizeTags(content.trim()), close].join('\n');
  return [`${head} omitted="true">`, `${about} It is too long to pass here (${content.length} characters): read the whole file (${path}) with the Read tool before you go on, and follow it.`, close].join('\n');
}

const INSTRUCTIONS_BLOCK = new RegExp(`<${INSTRUCTIONS_TAG} path="([^"]*)" sum="([0-9a-f]+)"( omitted="true")?>[\\s\\S]*?</${INSTRUCTIONS_TAG}>`, 'g');

// TANACODE.md を渡した文なら、渡したファイルごとに、パス・中身の印・中身を入れたか・その囲みの文。違えば空（頭が囲みでないもの）
export function parseInstructions(text: string): { path: string; sum: string; full: boolean; text: string }[] {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(`<${INSTRUCTIONS_TAG} `)) return [];
  return [...trimmed.matchAll(INSTRUCTIONS_BLOCK)].map((m) => ({ path: unattribute(m[1]), sum: m[2], full: !m[3], text: m[0] }));
}

// 「親にする」で送る発言（files はプロファイル → フォルダの順）。1 つの囲みの中に、前書きと、ファイルごとの中身（FILE_TAG で囲む）を入れる。
// 前書きは、チャットの知らせを開くと人にも見えるので、画面の言語で書く（見分けるのは囲みだけ）。
// rest: 一緒に送る最初の指示（新規セッションの画面の「親として始める」）。囲みのあとに続ける。
// 中身の tanacode のタグは、親からの指示の本文と同じく、すべて効かなくする（neutralizeTags）。発言の行は、Claude Code が順番待ちの発言を
// まとめた行を tanacode の囲みの切れ目で分けて読む（@shared/chat の mergedParts）ので、中身にタグがあると、途中で分かれてしまうため。
// ファイルごとの囲みも、同じ理由で tanacode- の名前にしない（中身の閉じタグは効かなくする）
export function parentRoleText(files: readonly { path: string; content: string }[], rest = ''): string {
  const sections = files.map(({ path, content }) => [`<${FILE_TAG} path="${attribute(path)}">`, neutralizeFileTag(neutralizeTags(content.trim())), `</${FILE_TAG}>`].join('\n'));
  const block = [`<${PARENT_ROLE_TAG}>`, t('chat.parentRole.intro', { file: PARENT_INSTRUCTIONS_FILE }), '', sections.join('\n\n'), `</${PARENT_ROLE_TAG}>`].join('\n');
  return rest.trim() ? `${block}\n\n${rest}` : block;
}

// 「親にする」の発言の中の、ファイルごとの囲み
const FILE_TAG = 'instructions-file';

function neutralizeFileTag(text: string): string {
  return text.replace(new RegExp(`<(/?)(${FILE_TAG})`, 'gi'), '＜$1$2');
}

const PARENT_ROLE = new RegExp(`^<${PARENT_ROLE_TAG}>\\n?([\\s\\S]*?)\\n?</${PARENT_ROLE_TAG}>`);
const FILE_SECTION = new RegExp(`<${FILE_TAG} path="([^"]*)">\\n?([\\s\\S]*?)\\n?</${FILE_TAG}>`, 'g');

// 「親にする」の発言なら、読ませたファイル（パスと、囲みの中のその部分）・囲みの中身（前書きと TANACODE_PARENT.md）・あとに続く最初の指示。
// 違えば null。会話ログでは、全体が貼り付けの囲み（<pasted_content>）に入ることがあるので、先に外す
export function parseParentRole(text: string): { files: { path: string; text: string }[]; body: string; rest: string } | null {
  const whole = unwrapWholePaste(text).trimStart();
  const m = PARENT_ROLE.exec(whole);
  if (!m) return null;
  const files = [...m[1].matchAll(FILE_SECTION)].map((f) => ({ path: unattribute(f[1]), text: f[0] }));
  return { files, body: m[1].trim(), rest: whole.slice(m[0].length).replace(/^\s+/, '') };
}
