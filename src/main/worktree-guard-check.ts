import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git } from './git';
import { branchesSafeToDelete, WORKTREES_DIR, worktreeSafeToRemove } from './worktree';

// worktree-guard（worktree-guard.ts）の awk が「確認を出させる」と決めたコマンドを、もう一度読み直して確かめる。
// awk はクォートや文字列の中も区切りとしてざっと見るので、文字列の中に「git branch -D」が入っているだけのものや、パスに
// worktrees を含むだけの rm -rf でも確認を出させてしまう。ここでは、シェルの文法でコマンドを読み、
// - すべてを読めて（読めない書き方・変数で決まるコマンドが無い）
// - どのコマンドも許す形（下の READONLY・git と gh の決まったサブコマンド・worktree でない rm など）で
// - 消す操作（git branch -D・git worktree remove --force）より前に、読むだけと言い切れないもの（書き込みのリダイレクト・git の書き換え
//   など）が無く（確かめたあとで、同じコマンドのほかの部分が状態を変えないように）
// - 消す操作のどれもが、消して失うものが無いと git で確かめられた
// ときだけ 'pass' と答える。どれか 1 つでも外れれば 'ask'（知らないものは ask。歯止めなので、確認が出なくなる穴を作らない側に倒す）。
// - git branch -D（--delete --force も）: 手元にしか無いコミットが無い（worktree の片付けと同じ判定。worktree.ts の branchesSafeToDelete）
// - git worktree remove --force: tanacode が作った worktree（.claude/worktrees/ の下）で、失うものが無い（worktreeSafeToRemove）
// 'pass' でも、フックは何も決めない（Claude Code のふだんの許可の決まりに任せる。allow は返さない。コマンドのほかの部分の確認まで
// 飛ばしてしまうため）

export type GuardVerdict = 'pass' | 'ask';

// 確かめを待つ上限（ミリ秒）。過ぎたら ask。gh の問い合わせ（github.ts。10 秒で打ち切る）を待てる長さにする
export const GUARD_DEADLINE_MS = 20_000;

// 単語。text: クォートを外した文字（変数などは書いたまま）/ literal: 変数・コマンド置換・グロブ・中括弧の無い、書いたとおりの文字か
// quoted: クォートやエスケープを使ったか
type Word = { text: string; literal: boolean; quoted: boolean };
// リダイレクト。out: 書き込み / dup: ファイル記述子の複製（2>&1 など。先は target）/ target: 先（ヒアストリングは null）
type Redirect = { out: boolean; dup: boolean; target: Word | null };
// 単純なコマンド。before・after: 前と後ろの区切り（'' は並びのはじめ・終わり、';'・'\n'・'&&'・'||'・'|'・'&'）
type Simple = { words: Word[]; redirects: Redirect[]; before: string; after: string };
// コマンドの並び。sub: サブシェル・コマンド置換の中の並び（中の cd は外に効かない）
type Item = { kind: 'cmd'; cmd: Simple } | { kind: 'sub'; items: Item[] };

class ParseError extends Error {}
// 許す形でないものを見つけた
class Ask extends Error {}

// シェルのコマンドの文字列を、コマンドの並びにする。読めない（クォートが閉じていない・括弧が合わない・関数の定義・算術展開・
// 中にコマンド置換のある ${…} など）ときは ParseError
export function parseCommand(source: string): Item[] {
  return new Parser(source).list(false);
}

class Parser {
  i = 0;
  constructor(private readonly s: string) {}

  // stop: 対になる ) で止まる（サブシェル・コマンド置換の中）
  list(stop: boolean): Item[] {
    const s = this.s;
    const items: Item[] = [];
    let op = '';
    let cur: Simple = { words: [], redirects: [], before: op, after: '' };
    let word: Word | null = null;
    // 先を待っているリダイレクト（次の単語が先。引数ではない）
    let redirect: Omit<Redirect, 'target'> | null = null;
    // 読み終えていないヒアドキュメント（次の改行のあとに中身がある）
    let pending: { delim: string; strip: boolean; quoted: boolean }[] = [];

    const add = (text: string, literal: boolean, quoted = false) => {
      word ??= { text: '', literal: true, quoted: false };
      word.text += text;
      if (!literal) word.literal = false;
      if (quoted) word.quoted = true;
    };
    const endWord = () => {
      const w = word as Word | null;
      word = null;
      if (!w) return;
      // { } [ [[ ]] だけの単語は、文法の言葉・test のコマンド（中括弧の展開・グロブではない）
      if (!w.quoted && ['{', '}', '[', '[[', ']]'].includes(w.text)) w.literal = true;
      if (redirect) {
        cur.redirects.push({ ...redirect, target: w });
        redirect = null;
      } else cur.words.push(w);
    };
    const endCmd = (next: string) => {
      endWord();
      if (redirect) throw new ParseError('redirect without target');
      cur.after = next;
      if (cur.words.length > 0 || cur.redirects.length > 0) items.push({ kind: 'cmd', cmd: cur });
      op = next;
      cur = { words: [], redirects: [], before: op, after: '' };
    };

    while (this.i < s.length) {
      const c = s[this.i];
      const two = s.slice(this.i, this.i + 2);
      if (word === null && c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === ' ' || c === '\t') {
        endWord();
        this.i++;
      } else if (c === '\n') {
        endCmd('\n');
        this.i++;
        for (const doc of pending) this.heredoc(doc.delim, doc.strip, doc.quoted, items);
        pending = [];
      } else if (two === '&>') {
        endWord();
        redirect = { out: true, dup: false };
        this.i += s[this.i + 2] === '>' ? 3 : 2;
      } else if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
        if (two === ';;') throw new ParseError('case');
        endCmd(two === '|&' ? '|' : two);
        this.i += 2;
      } else if (c === ';' || c === '&' || c === '|') {
        endCmd(c);
        this.i++;
      } else if (c === '(') {
        // 関数の定義（f() …）や、単語の途中の ( は読まない
        if (word !== null || cur.words.length > 0) throw new ParseError('function definition');
        this.i++;
        items.push({ kind: 'sub', items: this.list(true) });
      } else if (c === ')') {
        if (!stop) throw new ParseError('unbalanced )');
        endCmd('');
        this.i++;
        return items;
      } else if (s.startsWith('<<<', this.i)) {
        // ヒアストリング（標準入力に渡す文字。引数ではない）
        endWord();
        redirect = { out: false, dup: false };
        this.i += 3;
      } else if (two === '<<') {
        endWord();
        this.i += 2;
        const strip = s[this.i] === '-';
        if (strip) this.i++;
        while (s[this.i] === ' ' || s[this.i] === '\t') this.i++;
        const delim = this.delimiter();
        cur.redirects.push({ out: false, dup: false, target: null });
        pending.push({ ...delim, strip });
      } else if (two === '<(' || two === '>(') {
        // プロセス置換
        endWord();
        this.i += 2;
        items.push({ kind: 'sub', items: this.list(true) });
      } else if (c === '<' || c === '>') {
        // 2>&1 の 2 のような、ファイル記述子の番号は引数ではない（add が word を書き換えるので、TypeScript には null に見える）
        const fd = word as Word | null;
        if (fd && fd.literal && !fd.quoted && /^\d+$/.test(fd.text)) word = null;
        endWord();
        let ops = '';
        while ('<>&|'.includes(s[this.i] ?? 'x')) ops += s[this.i++];
        redirect = { out: ops.includes('>'), dup: ops.endsWith('&') };
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) throw new ParseError('unterminated quote');
        add(s.slice(this.i + 1, end), true, true);
        this.i = end + 1;
      } else if (c === '"') {
        add('', true, true);
        this.i++;
        for (;;) {
          if (this.i >= s.length) throw new ParseError('unterminated quote');
          const d = s[this.i];
          if (d === '"') break;
          if (d === '\\') {
            const next = s[this.i + 1] ?? '';
            if (next === '\n') this.i += 2;
            else if (next !== '' && '$`"\\'.includes(next)) {
              add(next, true);
              this.i += 2;
            } else {
              add('\\', true);
              this.i++;
            }
          } else if (d === '$') this.dollar(add, items);
          else if (d === '`') this.backtick(add, items);
          else {
            add(d, true);
            this.i++;
          }
        }
        this.i++;
      } else if (c === '\\') {
        if (s[this.i + 1] !== '\n') add(s[this.i + 1] ?? '', true, true);
        this.i += 2;
      } else if (c === '$') {
        this.dollar(add, items);
      } else if (c === '`') {
        this.backtick(add, items);
      } else {
        add(c, !'*?[]{}'.includes(c));
        this.i++;
      }
    }
    if (stop) throw new ParseError('unbalanced (');
    if (pending.length > 0) throw new ParseError('unterminated heredoc');
    endCmd('');
    return items;
  }

  // $ で始まるもの（コマンド置換・変数）。どれも、書いたとおりの文字ではない
  private dollar(add: (text: string, literal: boolean) => void, items: Item[]): void {
    const s = this.s;
    const next = s[this.i + 1] ?? '';
    if (next === '(') {
      if (s[this.i + 2] === '(') throw new ParseError('arithmetic');
      this.i += 2;
      items.push({ kind: 'sub', items: this.list(true) });
      add('$(…)', false);
    } else if (next === '{') {
      const end = s.indexOf('}', this.i + 2);
      if (end < 0) throw new ParseError('unterminated ${');
      const inner = s.slice(this.i + 2, end);
      // 中にコマンド置換・入れ子の展開があるもの（${x:-$(…)} など）は読まない
      if (/[$`{]/.test(inner)) throw new ParseError('expansion in ${}');
      add(s.slice(this.i, end + 1), false);
      this.i = end + 1;
    } else if (/[A-Za-z0-9_@*#?$!-]/.test(next)) {
      let end = this.i + 2;
      if (/[A-Za-z_]/.test(next)) while (end < s.length && /[A-Za-z0-9_]/.test(s[end])) end++;
      add(s.slice(this.i, end), false);
      this.i = end;
    } else {
      // $'…' $"…" も、書いたとおりの文字ではない
      add('$', next !== "'" && next !== '"');
      this.i++;
    }
  }

  // `...` のコマンド置換
  private backtick(add: (text: string, literal: boolean) => void, items: Item[]): void {
    const s = this.s;
    let end = this.i + 1;
    while (end < s.length && s[end] !== '`') end += s[end] === '\\' ? 2 : 1;
    if (end >= s.length) throw new ParseError('unterminated `');
    items.push({ kind: 'sub', items: parseCommand(s.slice(this.i + 1, end).replace(/\\([`\\$])/g, '$1')) });
    add('`…`', false);
    this.i = end + 1;
  }

  // ヒアドキュメントの終わりの印。クォートしてあれば、中身を展開しない
  private delimiter(): { delim: string; quoted: boolean } {
    const s = this.s;
    let delim = '';
    let quoted = false;
    while (this.i < s.length && !' \t\n;&|<>()'.includes(s[this.i])) {
      const c = s[this.i];
      if (c === "'" || c === '"') {
        const end = s.indexOf(c, this.i + 1);
        if (end < 0) throw new ParseError('unterminated quote');
        delim += s.slice(this.i + 1, end);
        quoted = true;
        this.i = end + 1;
      } else if (c === '\\') {
        delim += s[this.i + 1] ?? '';
        quoted = true;
        this.i += 2;
      } else {
        delim += c;
        this.i++;
      }
    }
    if (delim === '') throw new ParseError('heredoc without delimiter');
    return { delim, quoted };
  }

  // ヒアドキュメントの中身を読み飛ばす（コマンドに渡す文字。シェルに渡すものは、-c の無いシェルとして ask になる）。
  // 展開するもの（印をクォートしていない）は、中のコマンド置換を items に足す
  private heredoc(delim: string, strip: boolean, quoted: boolean, items: Item[]): void {
    const s = this.s;
    const lines: string[] = [];
    let closed = false;
    while (this.i < s.length) {
      const nl = s.indexOf('\n', this.i);
      const line = s.slice(this.i, nl < 0 ? s.length : nl);
      this.i = nl < 0 ? s.length : nl + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === delim) {
        closed = true;
        break;
      }
      lines.push(line);
    }
    if (!closed) throw new ParseError('unterminated heredoc');
    if (quoted) return;
    const text = lines.join('\n');
    const body = new Parser(text);
    const ignore = () => {};
    while (body.i < text.length) {
      const c = text[body.i];
      if (c === '\\') body.i += 2;
      else if (c === '$') body.dollar(ignore, items);
      else if (c === '`') body.backtick(ignore, items);
      else body.i++;
    }
  }
}

// 消す操作。cwd: そのコマンドを動かすフォルダ
type Delete = { kind: 'branch'; cwd: string; names: string[] } | { kind: 'worktree'; cwd: string; path: string; forces: number };
// 読んでいる間の状態。cwd: 今のフォルダ（cd の先が分からなければ null）/ mutated: 読むだけと言い切れないものがあった
type State = { cwd: string | null; mutated: boolean; deletes: Delete[] };

// 読むだけのコマンド（書き込みのリダイレクトが無ければ、何も変えない。コマンドを動かす機能の無いもの）
const READONLY = new Set([
  'echo', 'printf', 'true', 'false', ':', 'test', '[', '[[', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg',
  'sort', 'uniq', 'jq', 'date', 'sleep', 'which', 'basename', 'dirname', 'realpath', 'diff', 'cut', 'tr', 'exit',
]);
// 文法の言葉。コマンドの前に付くものは飛ばす（for・case・function・coproc などは知らないものとして ask）
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', ']]']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// コマンドの場所として受け付けるフォルダ（./git のような、そのフォルダのスクリプトは知らないものとして ask）
const BIN_DIRS = new Set(['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']);
// 代入すると、git・gh・シェルの動きが変わる変数
const PROTECTED_VARS = /^(GIT_.*|GH_.*|PATH|HOME|XDG_CONFIG_HOME|BASH_ENV|ENV|ZDOTDIR|IFS|CDPATH|PWD|OLDPWD|SHELLOPTS|BASHOPTS)$/;
// 読むだけの git のサブコマンド
const GIT_READONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-remote', 'for-each-ref', 'merge-base', 'rev-list', 'cat-file', 'show-ref',
  'describe', 'shortlog', 'blame', 'grep', 'whatchanged', 'help', 'version',
]);
// 書き換えるが、ブランチや worktree を消さず、コマンドを動かす機能も無い git のサブコマンド（消す操作のあとにだけ許す）
const GIT_MUTATING = new Set([
  'pull', 'push', 'fetch', 'switch', 'checkout', 'commit', 'add', 'merge', 'restore', 'cherry-pick', 'revert', 'tag', 'reset', 'clean',
  'gc', 'prune', 'mv', 'rm', 'apply', 'am', 'update-ref', 'notes',
]);
// git のサブコマンドの前に付けてよいオプション（-c・--git-dir・--work-tree・--exec-path などは、別のものを動かせるので ask）
const GIT_GLOBAL = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects']);
// gh のサブコマンド（読むだけのもの: 動作 → 許す）。ほかの知っているものは書き換え（消す操作のあとにだけ許す）。知らないもの（別名・拡張）は ask
const GH_READONLY: Record<string, string[]> = {
  pr: ['view', 'list', 'status', 'checks', 'diff'],
  issue: ['view', 'list', 'status'],
  run: ['view', 'list', 'watch'],
  repo: ['view'],
  release: ['view', 'list'],
  workflow: ['view', 'list'],
  auth: ['status'],
};
const GH_KNOWN = new Set([...Object.keys(GH_READONLY), 'api', 'label', 'gist', 'search']);
// git branch -D で読む名前。refs/heads/<名前> として読めて、git branch -D がそれを消すと言い切れるものだけ（@{-1}・- などは読まない）
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/+-]+$/;

const tilde = (text: string) => (text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text);
const isFlag = (w: Word | undefined): boolean => !!w && w.literal && w.text.startsWith('-') && w.text !== '-';
const ask = (): never => {
  throw new Ask();
};

// cwd から見た path。cwd が分からず、path が相対なら null
function resolveFrom(cwd: string | null, text: string): string | null {
  const path = tilde(text);
  if (isAbsolute(path)) return resolve(path);
  return cwd === null ? null : resolve(cwd, path);
}

// コマンドの並びを読み、消す操作を取り出す。許す形でないものがあれば null
export function guardDeletes(command: string, cwd: string): Delete[] | null {
  const state: State = { cwd, mutated: false, deletes: [] };
  try {
    walk(parseCommand(command), state);
  } catch {
    return null;
  }
  return state.deletes;
}

function walk(items: Item[], state: State): void {
  for (const item of items) {
    if (item.kind === 'sub') {
      const saved = state.cwd;
      walk(item.items, state);
      state.cwd = saved;
    } else simple(item.cmd, state);
  }
}

function mutate(state: State): void {
  state.mutated = true;
}

function addDelete(state: State, del: Delete): void {
  // 確かめたあとで、同じコマンドの前の部分が状態を変えているかもしれない
  if (state.mutated) ask();
  state.deletes.push(del);
}

// 単純なコマンドを 1 つ見る
function simple(cmd: Simple, state: State): void {
  // 書き込みのリダイレクト。/dev/null とファイル記述子の複製のほかは、書き換えとして数える（worktree の中・グロブ・変数の先は ask）
  let writes = false;
  for (const r of cmd.redirects) {
    if (!r.out || !r.target) continue;
    const { target } = r;
    if (r.dup && target.literal && /^(\d+|-)$/.test(target.text)) continue;
    if (target.literal && target.text === '/dev/null') continue;
    if (!target.literal) ask();
    const path = resolveFrom(state.cwd, target.text);
    if (path === null || inWorktrees(path) || target.text.split('/').includes('worktrees')) ask();
    writes = true;
  }
  const words = [...cmd.words];
  for (;;) {
    const first = words[0];
    if (!first) break;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(first.text);
    if (assignment && !first.quoted) {
      if (PROTECTED_VARS.test(assignment[1])) ask();
      words.shift();
      continue;
    }
    if (first.literal && !first.quoted && KEYWORDS.has(first.text)) {
      words.shift();
      continue;
    }
    if (!first.literal) ask();
    const dir = dirname(first.text);
    if (first.text.includes('/') && !BIN_DIRS.has(dir)) ask();
    const name = basename(first.text);
    words.shift();
    if (name === 'nohup' || name === 'exec' || name === 'builtin') {
      if (isFlag(words[0])) ask();
      continue;
    }
    if (name === 'command') {
      if (words[0]?.text === '-v' || words[0]?.text === '-V') break;
      if (isFlag(words[0])) ask();
      continue;
    }
    if (name === 'time') {
      if (words[0]?.text === '-p') words.shift();
      continue;
    }
    if (name === 'env') {
      while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text)) {
        if (PROTECTED_VARS.test(words[0].text.split('=')[0])) ask();
        words.shift();
      }
      if (isFlag(words[0])) ask();
      continue;
    }
    if (name === 'cd' || name === 'pushd' || name === 'popd') changeDir(name, words, cmd, state);
    else if (name === 'eval') {
      if (!words.every((w) => w.literal)) ask();
      walk(parseCommand(words.map((w) => w.text).join(' ')), state);
    } else if (SHELLS.has(name)) shellCommand(words, state);
    else if (name === 'git') gitCommand(words, state);
    else if (name === 'gh') ghCommand(words, state);
    else if (name === 'rm') rmCommand(words, state);
    else if (READONLY.has(name)) {
      // sort -o は書き込む
      if (name === 'sort' && words.some((w) => w.text === '-o' || w.text.startsWith('--o'))) mutate(state);
    } else ask();
    break;
  }
  if (writes) mutate(state);
}

// cd・pushd・popd。続けて動く（; && 改行で区切った）ものだけを追う。パイプ・裏で動かすもの・|| のあとの cd は外に効くか
// 分からないので、フォルダを分からないものにする
function changeDir(name: string, words: Word[], cmd: Simple, state: State): void {
  const sequential = ['', ';', '\n', '&&'].includes(cmd.before) && !['|', '&'].includes(cmd.after);
  if (name === 'popd' || !sequential) {
    state.cwd = null;
    return;
  }
  while (words[0]?.literal && (words[0].text === '-P' || words[0].text === '-L')) words.shift();
  const target = words[0];
  if (!target) state.cwd = homedir();
  else if (!target.literal || isFlag(target) || target.text === '-') state.cwd = null;
  else state.cwd = resolveFrom(state.cwd, target.text);
}

// sh -c '…' などは、中のコマンドを読む（中の cd は外に効かない）。-c の無いもの（標準入力・ヒアドキュメント・ファイルを読む）は ask
function shellCommand(words: Word[], state: State): void {
  let i = 0;
  let command = false;
  while (words[i]?.literal && /^[-+][a-zA-Z]+$/.test(words[i].text)) {
    if (words[i].text.startsWith('-') && words[i].text.includes('c')) command = true;
    i++;
  }
  const script = words[i];
  if (!command || !script || !script.literal) ask();
  const saved = state.cwd;
  walk(parseCommand(script.text), state);
  state.cwd = saved;
}

// 長いオプションの名前。git は、ほかと見分けられる省略形も受け付ける（--del は --delete）。names のうち、given で始まるもの
function longOption(given: string, names: string[]): string[] {
  const name = given.slice(2).split('=')[0];
  if (names.includes(name)) return [name];
  return names.filter((n) => n.startsWith(name));
}

function gitCommand(args: Word[], state: State): void {
  let dir = state.cwd;
  let i = 0;
  while (i < args.length && isFlag(args[i])) {
    const a = args[i].text;
    if (a === '-C') {
      const next = args[i + 1];
      if (!next?.literal) ask();
      dir = resolveFrom(dir, next.text);
      i += 2;
    } else if (GIT_GLOBAL.has(a)) i++;
    else ask();
  }
  const sub = args[i];
  if (!sub) return;
  if (!sub.literal) ask();
  const rest = args.slice(i + 1);
  // ファイルに書き出すオプション
  const output = rest.some((w) => w.text.startsWith('--output'));
  if (sub.text === 'branch') branchCommand(rest, dir, state);
  else if (sub.text === 'worktree') {
    const action = rest[0]?.text;
    if (action === 'list') return;
    if (action === 'remove') worktreeRemove(rest.slice(1), dir, state);
    else if (['prune', 'add', 'move', 'lock', 'unlock', 'repair'].includes(action ?? '')) mutate(state);
    else ask();
  } else if (GIT_READONLY.has(sub.text)) {
    if (output) mutate(state);
  } else if (sub.text === 'reflog') {
    if (['expire', 'delete', 'drop'].includes(rest[0]?.text ?? '')) mutate(state);
  } else if (sub.text === 'stash') {
    if (!['list', 'show'].includes(rest[0]?.text ?? '')) mutate(state);
  } else if (sub.text === 'remote') {
    const action = rest[0]?.text ?? '';
    if (!['', '-v', '--verbose', 'show', 'get-url'].includes(action)) mutate(state);
  } else if (sub.text === 'config') {
    if (!rest.some((w) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'].includes(w.text))) mutate(state);
  } else if (sub.text === 'symbolic-ref') {
    if (rest.filter((w) => !isFlag(w)).length > 1 || rest.some((w) => w.text === '-d' || w.text.startsWith('--d'))) mutate(state);
  } else if (GIT_MUTATING.has(sub.text)) mutate(state);
  else ask();
}

// git branch の長いオプション
const BRANCH_LONG = [
  'delete', 'force', 'remotes', 'all', 'list', 'merged', 'no-merged', 'contains', 'no-contains', 'points-at', 'format', 'sort', 'show-current',
  'verbose', 'quiet', 'color', 'no-color', 'column', 'no-column', 'abbrev', 'no-abbrev', 'ignore-case', 'omit-empty', 'track', 'no-track',
  'set-upstream-to', 'unset-upstream', 'edit-description', 'move', 'copy', 'create-reflog', 'recurse-submodules',
];
// 一覧を出すだけの git branch のオプション（値を取るものも、--format=… の形）
const BRANCH_LIST_LONG = new Set(['all', 'list', 'merged', 'no-merged', 'contains', 'no-contains', 'points-at', 'format', 'sort', 'show-current', 'verbose', 'quiet', 'color', 'no-color', 'column', 'no-column', 'abbrev', 'no-abbrev', 'ignore-case', 'omit-empty', 'remotes']);

function branchCommand(rest: Word[], dir: string | null, state: State): void {
  let del = false;
  let force = false;
  let strong = false;
  let remote = false;
  // 消すのでも一覧を出すのでもないオプション
  let other = false;
  // 一覧を出すオプションのほかのオプション（消すときに付いていれば ask）
  let extra = false;
  let listing = false;
  let ended = false;
  const names: Word[] = [];
  for (const w of rest) {
    if (!ended && w.literal && w.text === '--') ended = true;
    else if (!ended && isFlag(w)) {
      if (w.text.startsWith('--')) {
        const name = w.text.slice(2).split('=')[0];
        // --d・--f で始まるものは、--delete・--force とみなす（省略形）
        if (name !== '' && 'delete'.startsWith(name)) del = true;
        else if (name !== '' && 'force'.startsWith(name)) force = true;
        else {
          const found = longOption(w.text, BRANCH_LONG);
          if (found.length !== 1) other = true;
          else if (found[0] === 'remotes') remote = true;
          else if (BRANCH_LIST_LONG.has(found[0])) {
            if (found[0] === 'list') listing = true;
            if (!['quiet', 'verbose'].includes(found[0])) extra = true;
          } else other = true;
        }
      } else {
        for (const c of w.text.slice(1)) {
          if (c === 'D') strong = true;
          else if (c === 'd') del = true;
          else if (c === 'f') force = true;
          else if (c === 'r') remote = true;
          else if (c === 'l') listing = true;
          else if (c === 'a' || c === 'v') extra = c === 'a' || extra;
          else if (c !== 'q') other = true;
        }
      }
    } else names.push(w);
  }
  if (strong || (del && force)) {
    // リモート追跡のブランチ（-r）・ほかのオプションの付いたもの・名前の読めないものは確かめない
    if (remote || other || extra || names.length === 0 || dir === null) ask();
    if (!names.every((w) => w.literal && BRANCH_NAME.test(w.text))) ask();
    addDelete(state, { kind: 'branch', cwd: dir!, names: names.map((w) => w.text) });
  } else if (del || other || (names.length > 0 && !listing)) {
    // git branch -d・名前を変える・作るなど
    mutate(state);
  }
}

function worktreeRemove(rest: Word[], dir: string | null, state: State): void {
  let forces = 0;
  let ended = false;
  const paths: Word[] = [];
  for (const w of rest) {
    if (!ended && w.literal && w.text === '--') ended = true;
    else if (!ended && isFlag(w)) {
      if (w.text.startsWith('--')) {
        const name = w.text.slice(2);
        if (name === '' || !'force'.startsWith(name)) ask();
        forces++;
      } else if (/^-f+$/.test(w.text)) forces += w.text.length - 1;
      else ask();
    } else paths.push(w);
  }
  // --force の無いものは、git が、変更の残る worktree を消さない
  if (forces === 0) return mutate(state);
  if (paths.length !== 1 || !paths[0].literal || dir === null) ask();
  addDelete(state, { kind: 'worktree', cwd: dir!, path: resolveFrom(dir, paths[0].text)!, forces });
}

function ghCommand(args: Word[], state: State): void {
  const sub = args[0];
  if (!sub?.literal || isFlag(sub) || !GH_KNOWN.has(sub.text)) ask();
  const action = args[1];
  if (!(action?.literal && GH_READONLY[sub!.text]?.includes(action.text))) mutate(state);
}

// rm。消す先のすべてが、worktree になりえないと言い切れるときだけ許す（書き換えとして数える）。
// グロブ・中括弧・変数を含むもの、区切りの 1 つが worktrees のもの、.claude/worktrees の中や、それを含むフォルダ、
// worktree の中での . や .. は ask
function rmCommand(args: Word[], state: State): void {
  let ended = false;
  for (const w of args) {
    if (!ended && w.literal && w.text === '--') {
      ended = true;
      continue;
    }
    if (!ended && isFlag(w)) continue;
    if (!w.literal) ask();
    const text = w.text;
    if (tilde(text).split('/').includes('worktrees')) ask();
    const path = resolveFrom(state.cwd, text);
    if (path === null || inWorktrees(path) || holdsWorktrees(path)) ask();
    if (state.cwd !== null && inWorktrees(state.cwd + '/') && (/^\.\.?\/?$/.test(text) || text.startsWith('../') || path === state.cwd)) ask();
  }
  mutate(state);
}

// .claude/worktrees の中か
function inWorktrees(path: string): boolean {
  return path.includes('/.claude/worktrees/') || path.endsWith('/.claude/worktrees');
}

// 消すと、中の .claude/worktrees も消えるフォルダか
function holdsWorktrees(path: string): boolean {
  return existsSync(join(path, WORKTREES_DIR)) || (basename(path) === '.claude' && existsSync(join(path, 'worktrees')));
}

// リポジトリの、共通の git のフォルダ（worktree どうしで同じ）。リポジトリでなければ null
async function commonDir(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  return out?.trim() || null;
}

// 確かめる。cwd: フックの入力の cwd（Claude Code の今のフォルダ）
export async function verifyCommand(command: string, cwd: string): Promise<GuardVerdict> {
  const deletes = guardDeletes(command, cwd);
  if (deletes === null) return 'ask';
  // リポジトリごとに、消すブランチと消す worktree をまとめて確かめる（一緒に消すブランチどうしで、互いのコミットを持つときに、
  // 両方を消してよいとしないように。一緒に消す worktree で取り出しているブランチは、取り出していないものとして数える）
  const repos = new Map<string, { cwd: string; root: string; branches: string[]; worktrees: { path: string; forces: number }[] }>();
  for (const d of deletes) {
    const common = await commonDir(d.cwd);
    if (!common || basename(common) !== '.git') return 'ask';
    let repo = repos.get(common);
    if (!repo) repos.set(common, (repo = { cwd: d.cwd, root: dirname(common), branches: [], worktrees: [] }));
    if (d.kind === 'branch') repo.branches.push(...d.names);
    else repo.worktrees.push({ path: d.path, forces: d.forces });
  }
  for (const repo of repos.values()) {
    for (const w of repo.worktrees) {
      if (!(await insideWorktrees(repo.root, w.path)) || !(await worktreeSafeToRemove(repo.root, w.path, w.forces))) return 'ask';
    }
    const removing = repo.worktrees.map((w) => w.path);
    if (repo.branches.length > 0 && !(await branchesSafeToDelete(repo.cwd, repo.branches, removing))) return 'ask';
  }
  return 'pass';
}

// tanacode が作る worktree の場所（<リポジトリ>/.claude/worktrees/<名前>）か
async function insideWorktrees(root: string, path: string): Promise<boolean> {
  const [base, target] = await Promise.all([realpath(join(root, WORKTREES_DIR)).catch(() => null), realpath(path).catch(() => null)]);
  if (!base || !target) return false;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/');
}
