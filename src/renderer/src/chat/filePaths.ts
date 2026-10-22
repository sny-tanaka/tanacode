import { t } from '@shared/i18n';

// チャットの本文に出てくるファイルのパス（/Users/me/a.md・~/a.md・src/a.ts:12 など）を探して、押すとエディタで開くリンクにする。
// 本文は文章なので、パスの形をしているだけでは足りない（/api/users や and/or も形は同じ）。
// ここでは候補を拾うだけで、リンクにするのは、main に確かめて実在するファイルと分かったものだけ（fileLinks.ts）

// 名前に使う文字。空白・括弧・引用符・句読点（「。」「、」を含む）は入れない
const NAME = String.raw`[\p{L}\p{N}\p{M}_@+%~.-]`;
// 文字列の中のパス: 絶対パス（/ か ~/ で始まる）か、2 つ以上の部分に分かれた相対パス（src/a.ts・./a.ts）。
// 前が名前の文字・: ・/ のときは、パスの途中（URL の https://host/a.md や 2026/10/22 の途中など）なので拾わない。
// あとに :12・:12:3・#L12 を付けると行になる
const RUN = new RegExp(
  String.raw`(?<![A-Za-z0-9_@+%~.:/\\-])((?:~(?=/))?(?:/${NAME}+)+|${NAME}+(?:/${NAME}+)+)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?`,
  'gu',
);
// コードの中は、全体が 1 つの絶対パスのとき（空白を含んでよい）。行の付け方は RUN と同じ
const WHOLE_ABSOLUTE = /^(~?\/[^\n]+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
// 日本語は、パスのすぐ後ろに助詞が続く（/a/b.mdを開く）。名前の文字に日本語も入るので、拡張子の直後で日本語に変わるところを別の候補にする
const BEFORE_NON_ASCII = /^(.*\.[A-Za-z][A-Za-z0-9]{0,9})(?=[^\x00-\x7F])/;

// 本文の中のリンクにしない場所（コードブロック・リンクの中・作ったリンクやボタンの中）。インラインのコードは、全体が 1 つのパスのときだけ別に扱う
const SKIP = 'pre, a, code, button';

export type FileCandidate = {
  path: string;
  // リンクにする文字の終わり（文字列の中の位置。コードの中のときは使わない）
  end: number;
  line?: number;
};

// 1 つのパスらしい並び。長い候補から並べる（実在した最初のものをリンクにする）
export type PathMatch = { start: number; candidates: FileCandidate[] };

function lineOf(m: RegExpExecArray | RegExpMatchArray): number | undefined {
  const line = m[2] ?? m[3];
  return line ? Number(line) : undefined;
}

// /compact や /api のように 1 つの部分だけの絶対パス・拡張子の無い相対パスは、パスと見ない（ファイルは、ふつう拡張子を持つ）
function plausible(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('~/')) return path.split('/').filter(Boolean).length >= 2 || EXTENSION.test(path);
  return EXTENSION.test(path);
}

// 文字列の中のパスらしい並び
export function pathsIn(text: string): PathMatch[] {
  const found: PathMatch[] = [];
  for (const m of text.matchAll(RUN)) {
    let path = m[1];
    let end = m.index + m[0].length;
    // 文末の「.」はパスに入れない（行が付いているときは、行の前の「.」なので、そのまま）
    if (m[0].length === path.length) {
      const trimmed = path.replace(/\.+$/, '');
      end -= path.length - trimmed.length;
      path = trimmed;
    }
    const candidates: FileCandidate[] = [];
    if (path && plausible(path)) candidates.push({ path, end, line: lineOf(m) });
    const head = BEFORE_NON_ASCII.exec(path)?.[1];
    if (head && head !== path && plausible(head)) candidates.push({ path: head, end: m.index + head.length });
    if (candidates.length) found.push({ start: m.index, candidates });
  }
  return found;
}

// インラインのコードの中身が、全体で 1 つのパスのとき
export function pathOfCode(text: string): PathMatch | null {
  const body = text.trim();
  const whole = WHOLE_ABSOLUTE.exec(body);
  const only = [...body.matchAll(RUN)].find((m) => m.index === 0 && m[0].length === body.length);
  const m = whole ?? only;
  if (!m) return null;
  const path = m[1];
  return plausible(path) ? { start: 0, candidates: [{ path, end: body.length, line: lineOf(m) }] } : null;
}

type Spot = { node: Text | HTMLElement; matches: PathMatch[] };

function spotsIn(root: ParentNode): Spot[] {
  const spots: Spot[] = [];
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre, a, button')) continue;
    const match = pathOfCode(code.textContent ?? '');
    if (match) spots.push({ node: code, matches: [match] });
  }
  // 歩いている間に差し替えるので、先に集める
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const node of texts) {
    if (node.parentElement?.closest(SKIP)) continue;
    const matches = pathsIn(node.data);
    if (matches.length) spots.push({ node, matches });
  }
  return spots;
}

// main に実在を確かめるパス（まだリンクになっていないもの）
export function fileCandidates(root: ParentNode): string[] {
  const paths = new Set<string>();
  for (const spot of spotsIn(root)) for (const match of spot.matches) for (const c of match.candidates) paths.add(c.path);
  return [...paths];
}

function linkOf(abs: string, line: number | undefined): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'file-link';
  // href は付けない（付けるとチャットのリンクの処理が、外のページとして開こうとする）。キーボードでも押せるよう、役割と tabindex を付ける
  a.setAttribute('role', 'link');
  a.tabIndex = 0;
  a.dataset.path = abs;
  if (line) a.dataset.line = String(line);
  a.title = t('composer.markdown.openFile', { path: abs });
  return a;
}

// 実在が分かったパス（候補 → 絶対パス）を、押すとエディタで開くリンクにする。何度呼んでもよい（リンクにしたところは、次からは飛ばす）
export function linkFiles(root: ParentNode, files: ReadonlyMap<string, string>): void {
  for (const { node, matches } of spotsIn(root)) {
    if (node instanceof HTMLElement) {
      const c = matches[0].candidates[0];
      const abs = files.get(c.path);
      if (!abs) continue;
      const a = linkOf(abs, c.line);
      node.replaceWith(a);
      a.append(node);
      continue;
    }
    const text = node.data;
    const parts = document.createDocumentFragment();
    let at = 0;
    for (const match of matches) {
      const c = match.candidates.find((candidate) => files.has(candidate.path));
      if (!c) continue;
      const a = linkOf(files.get(c.path)!, c.line);
      a.textContent = text.slice(match.start, c.end);
      parts.append(text.slice(at, match.start), a);
      at = c.end;
    }
    if (!at) continue;
    parts.append(text.slice(at));
    node.replaceWith(parts);
  }
}
