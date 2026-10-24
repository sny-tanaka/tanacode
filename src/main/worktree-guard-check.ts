import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git } from './git';
import { branchesSafeToDelete, WORKTREES_DIR, worktreeSafeToRemove } from './worktree';

// worktree-guard（worktree-guard.ts）の awk が「確認を出させる」と決めたコマンドを、もう一度読み直して確かめる。
// awk はクォートや文字列の中も区切りとしてざっと見るので、文字列の中に「git worktree remove」が入っているだけのものや、パスに
// worktrees を含むだけの rm -rf でも確認を出させてしまう。ここでは、シェルの文法でコマンドを読み、本当に消すものだけを取り出して、
// 消して失うものが無いかを git で確かめる。
// - git branch -D（--delete --force も）: 消すブランチに、手元にしか無いコミットが無い（worktree の片付けと同じ判定。worktree.ts の
//   branchesSafeToDelete）
// - git worktree remove --force: tanacode が作った worktree（.claude/worktrees/ の下）で、消して失うものが無い（worktreeSafeToRemove）
// - worktree の rm -rf: 今までどおり確かめずに確認を出させる（パスの区切りの 1 つが worktrees のものだけ）
// どれか 1 つでも確かめられなければ（変数・コマンド置換で名前が決まる、xargs で渡す、cd の先が分からないなど）、確認を出させる。
// 確かめて失うものが無ければ 'pass'（フックは何も決めず、Claude Code のふだんの許可の決まりに任せる。allow は返さない。
// コマンドのほかの部分の確認まで飛ばしてしまうため）

export type GuardVerdict = 'pass' | 'ask';

// 確かめを待つ上限（ミリ秒）。過ぎたら ask。gh の問い合わせ（github.ts。10 秒で打ち切る）を待てる長さにする
export const GUARD_DEADLINE_MS = 20_000;

// 単語。text: クォートを外した文字（変数などは書いたまま）/ literal: 変数・コマンド置換・glob の無い、書いたとおりの文字か
type Word = { text: string; literal: boolean };
// 単純なコマンド。heredoc: ヒアドキュメントの中身
type Simple = { words: Word[]; heredoc: Word | null };
// コマンドの並び。sub: サブシェル・コマンド置換の中の並び（中の cd は外に効かない）
type Item = { kind: 'cmd'; cmd: Simple } | { kind: 'sub'; items: Item[] };

class ParseError extends Error {}

// シェルのコマンドの文字列を、コマンドの並びにする。読めない（クォートが閉じていない・括弧が合わないなど）ときは ParseError
export function parseCommand(source: string): Item[] {
  const parser = new Parser(source);
  return parser.list(false);
}

class Parser {
  i = 0;
  constructor(private readonly s: string) {}

  // stop: 対になる ) で止まる（サブシェル・コマンド置換の中）
  list(stop: boolean): Item[] {
    const s = this.s;
    const items: Item[] = [];
    let cur: Simple = { words: [], heredoc: null };
    let word: Word | null = null;
    // 次の単語がリダイレクトの先（コマンドの引数ではない）
    let redirect = false;
    // 読み終えていないヒアドキュメント（次の改行のあとに中身がある）
    let pending: { delim: string; strip: boolean; quoted: boolean; cmd: Simple }[] = [];

    const add = (text: string, literal: boolean) => {
      word ??= { text: '', literal: true };
      word.text += text;
      if (!literal) word.literal = false;
    };
    const endWord = () => {
      if (word && !redirect) cur.words.push(word);
      else if (word) redirect = false;
      word = null;
    };
    const endCmd = () => {
      endWord();
      if (cur.words.length > 0) items.push({ kind: 'cmd', cmd: cur });
      cur = { words: [], heredoc: null };
    };

    while (this.i < s.length) {
      const c = s[this.i];
      if (word === null && c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === ' ' || c === '\t') {
        endWord();
        this.i++;
      } else if (c === '\n') {
        endCmd();
        this.i++;
        for (const doc of pending) doc.cmd.heredoc = this.heredoc(doc.delim, doc.strip, doc.quoted, items);
        pending = [];
      } else if (c === '&' && s[this.i + 1] === '>') {
        endWord();
        redirect = true;
        this.i += s[this.i + 2] === '>' ? 3 : 2;
      } else if (c === ';' || c === '&' || c === '|') {
        endCmd();
        this.i++;
      } else if (c === '(') {
        endCmd();
        this.i++;
        items.push({ kind: 'sub', items: this.list(true) });
      } else if (c === ')') {
        if (!stop) throw new ParseError('unbalanced )');
        endCmd();
        this.i++;
        return items;
      } else if (c === '<' && s[this.i + 1] === '<' && s[this.i + 2] === '<') {
        // ヒアストリング（標準入力に渡す文字。引数ではない）
        endWord();
        redirect = true;
        this.i += 3;
      } else if (c === '<' && s[this.i + 1] === '<') {
        endWord();
        this.i += 2;
        const strip = s[this.i] === '-';
        if (strip) this.i++;
        while (s[this.i] === ' ' || s[this.i] === '\t') this.i++;
        const delim = this.delimiter();
        pending.push({ ...delim, strip, cmd: cur });
      } else if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
        // プロセス置換
        endWord();
        this.i += 2;
        items.push({ kind: 'sub', items: this.list(true) });
      } else if (c === '<' || c === '>') {
        // 2>&1 の 2 のような、ファイル記述子の番号は引数ではない
        // （add が word を書き換えるので、TypeScript には null に見える）
        const fd = word as Word | null;
        if (fd && fd.literal && /^\d+$/.test(fd.text)) word = null;
        endWord();
        redirect = true;
        this.i++;
        while ('<>&|'.includes(s[this.i] ?? 'x')) this.i++;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) throw new ParseError('unterminated quote');
        add(s.slice(this.i + 1, end), true);
        this.i = end + 1;
      } else if (c === '"') {
        add('', true);
        this.i++;
        for (;;) {
          if (this.i >= s.length) throw new ParseError('unterminated quote');
          const d = s[this.i];
          if (d === '"') break;
          if (d === '\\') {
            const next = s[this.i + 1] ?? '';
            if (next === '\n') this.i += 2;
            else if ('$`"\\'.includes(next) && next !== '') {
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
        if (s[this.i + 1] !== '\n') add(s[this.i + 1] ?? '', true);
        this.i += 2;
      } else if (c === '$') {
        this.dollar(add, items);
      } else if (c === '`') {
        this.backtick(add, items);
      } else {
        add(c, !'*?['.includes(c));
        this.i++;
      }
    }
    if (stop) throw new ParseError('unbalanced (');
    endCmd();
    return items;
  }

  // $ で始まるもの（コマンド置換・変数）。どれも、書いたとおりの文字ではない
  private dollar(add: (text: string, literal: boolean) => void, items: Item[]): void {
    const s = this.s;
    const next = s[this.i + 1] ?? '';
    if (next === '(') {
      this.i += 2;
      items.push({ kind: 'sub', items: this.list(true) });
      add('$(…)', false);
    } else if (next === '{') {
      const end = s.indexOf('}', this.i + 2);
      if (end < 0) throw new ParseError('unterminated ${');
      add(s.slice(this.i, end + 1), false);
      this.i = end + 1;
    } else if (/[A-Za-z0-9_@*#?$!-]/.test(next)) {
      let end = this.i + 2;
      if (/[A-Za-z_]/.test(next)) while (end < s.length && /[A-Za-z0-9_]/.test(s[end])) end++;
      add(s.slice(this.i, end), false);
      this.i = end;
    } else {
      add('$', true);
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
    return { delim, quoted };
  }

  // ヒアドキュメントの中身を読む。展開するもの（印をクォートしていない）は、中のコマンド置換も items に足す
  private heredoc(delim: string, strip: boolean, quoted: boolean, items: Item[]): Word {
    const s = this.s;
    const lines: string[] = [];
    while (this.i < s.length) {
      const nl = s.indexOf('\n', this.i);
      const line = s.slice(this.i, nl < 0 ? s.length : nl);
      this.i = nl < 0 ? s.length : nl + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
      lines.push(line);
    }
    const text = lines.join('\n');
    if (quoted) return { text, literal: true };
    const body = new Parser(text);
    let literal = true;
    const add = (_: string, l: boolean) => {
      if (!l) literal = false;
    };
    while (body.i < text.length) {
      const c = text[body.i];
      if (c === '\\') body.i += 2;
      else if (c === '$') body.dollar(add, items);
      else if (c === '`') body.backtick(add, items);
      else body.i++;
    }
    return { text, literal };
  }
}

// 確かめるもの。cwd: そのコマンドを動かすフォルダ（cd の先が分からなければ null）/ extra: xargs・find -exec などで、
// 書いていない引数が足される
type Action =
  | { kind: 'branch'; cwd: string | null; names: Word[]; extra: boolean }
  | { kind: 'worktree'; cwd: string | null; paths: Word[]; extra: boolean }
  | { kind: 'ask' };

// awk と同じく、消す操作に見える文字があるか（中を読めない文字列に使う）
const RISKY_TEXT = /\bgit\b[\s\S]*\b(worktree|branch)\b|\brm\b[\s\S]*worktrees/;
// 文法の言葉。コマンドの前に付くものは飛ばす
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}']);
// 繰り返し・分岐のはじまり。中のコマンドは ; や改行のあとに別に並ぶので、この行は見ない
const COMPOUND = new Set(['for', 'select', 'case', 'function']);
// 引数を、別のところでコマンドとして動かすもの。中を読まずに、消す操作に見える文字があれば確認を出させる
const RUNNERS = new Set(['ssh', 'watch', 'su', 'script', 'parallel', 'tmux', 'screen', 'chroot', 'flock', 'entr', 'osascript', 'expect']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

// コマンドの並びから、確かめるものを取り出す
export function guardActions(command: string, cwd: string): Action[] {
  const out: Action[] = [];
  try {
    collect(parseCommand(command), cwd, out);
  } catch {
    return [{ kind: 'ask' }];
  }
  return out;
}

function collect(items: Item[], start: string | null, out: Action[]): void {
  let cwd = start;
  for (const item of items) {
    if (item.kind === 'sub') collect(item.items, cwd, out);
    else cwd = simple(item.cmd.words, item.cmd.heredoc, cwd, out, false);
  }
}

const isFlag = (w: Word | undefined) => !!w && w.literal && w.text.startsWith('-') && w.text !== '-';
const tilde = (text: string) => (text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text);

// 単純なコマンドを 1 つ見る。返すのは、そのあとのコマンドを動かすフォルダ（cd）
function simple(all: Word[], heredoc: Word | null, cwd: string | null, out: Action[], extraArgs: boolean): string | null {
  const words = [...all];
  let extra = extraArgs;
  let dir = cwd;
  const skipFlags = (withValue: string[] = []) => {
    while (isFlag(words[0])) {
      const flag = words.shift()!.text;
      if (flag === '--') break;
      if (withValue.includes(flag)) words.shift();
    }
  };
  for (;;) {
    const first = words[0];
    if (!first) return cwd;
    if (first.literal && KEYWORDS.has(first.text)) {
      words.shift();
      continue;
    }
    if (first.literal && COMPOUND.has(first.text)) return cwd;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text)) {
      words.shift();
      continue;
    }
    // 変数で決まるコマンドは読めない
    if (!first.literal) {
      if (RISKY_TEXT.test(words.map((w) => w.text).join(' '))) out.push({ kind: 'ask' });
      return cwd;
    }
    const name = basename(first.text);
    words.shift();
    switch (name) {
      case 'cd':
      case 'pushd': {
        while (isFlag(words[0])) words.shift();
        const target = words[0];
        if (!target) return homedir();
        return target.literal && target.text !== '-' && cwd !== null ? resolve(cwd, tilde(target.text)) : null;
      }
      case 'sudo':
      case 'doas':
        skipFlags(['-u', '-g', '-U', '-C', '-D', '-h', '-p', '-r', '-t', '-R', '-T']);
        continue;
      case 'env':
        while (words[0]) {
          const t = words[0].text;
          if (['-u', '--unset'].includes(t)) words.splice(0, 2);
          else if (['-C', '--chdir'].includes(t)) {
            words.splice(0, 2);
            dir = null;
          } else if (t.startsWith('-S') || t.startsWith('--split-string')) {
            if (RISKY_TEXT.test(words.map((w) => w.text).join(' '))) out.push({ kind: 'ask' });
            return cwd;
          } else if (isFlag(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) words.shift();
          else break;
        }
        continue;
      case 'command':
      case 'builtin':
      case 'exec':
      case 'nohup':
      case 'stdbuf':
      case 'unbuffer':
      case 'time':
        skipFlags();
        continue;
      case 'nice':
        skipFlags(['-n']);
        continue;
      case 'caffeinate':
        skipFlags(['-t', '-w']);
        continue;
      case 'timeout':
      case 'gtimeout':
        skipFlags(['-s', '-k', '--signal', '--kill-after']);
        words.shift();
        continue;
      case 'xargs':
        skipFlags(['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-a', '-R', '-S']);
        extra = true;
        continue;
      case 'eval': {
        const text = words.map((w) => w.text).join(' ');
        if (words.every((w) => w.literal)) collect(parseCommand(text), dir, out);
        else if (RISKY_TEXT.test(text)) out.push({ kind: 'ask' });
        return cwd;
      }
      case 'find': {
        const roots = words.slice(0, Math.max(0, words.findIndex((w) => w.text.startsWith('-')))).map((w) => w.text);
        for (let i = 0; i < words.length; i++) {
          if (!['-exec', '-execdir', '-ok', '-okdir'].includes(words[i].text)) continue;
          let end = i + 1;
          while (end < words.length && words[end].text !== ';' && words[end].text !== '+') end++;
          const inner = words.slice(i + 1, end);
          const found: Action[] = [];
          simple(inner, null, dir, found, true);
          out.push(...found);
          if (inner[0] && basename(inner[0].text) === 'rm' && roots.some(hasWorktreesSegment)) out.push({ kind: 'ask' });
          i = end;
        }
        return cwd;
      }
      case 'git':
        gitCommand(words, dir, out, extra);
        return cwd;
      case 'rm':
        rmCommand(words, dir, out);
        return cwd;
      default:
        if (SHELLS.has(name)) {
          const c = words.findIndex((w) => w.literal && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
          const script = c < 0 ? null : words.slice(c + 1).find((w) => !w.text.startsWith('-') && !w.text.startsWith('+'));
          if (script) {
            if (script.literal) collect(parseCommand(script.text), dir, out);
            else if (RISKY_TEXT.test(script.text)) out.push({ kind: 'ask' });
          } else if (c < 0 && heredoc) collect(parseCommand(heredoc.text), dir, out);
          return cwd;
        }
        if (RUNNERS.has(name) && RISKY_TEXT.test(words.map((w) => w.text).join(' '))) out.push({ kind: 'ask' });
        return cwd;
    }
  }
}

function gitCommand(args: Word[], cwd: string | null, out: Action[], extra: boolean): void {
  let dir = cwd;
  let i = 0;
  // git のサブコマンドの前のオプション
  while (i < args.length) {
    const a = args[i];
    if (!a.literal) {
      dir = null;
      i++;
    } else if (a.text === '-C') {
      const next = args[i + 1];
      dir = next?.literal && dir !== null ? resolve(dir, tilde(next.text)) : null;
      i += 2;
    } else if (['--git-dir', '--work-tree', '--namespace'].includes(a.text)) {
      dir = null;
      i += 2;
    } else if (/^--(git-dir|work-tree|namespace)=/.test(a.text)) {
      dir = null;
      i++;
    } else if (a.text === '-c' || a.text === '--config-env') i += 2;
    else if (a.text.startsWith('-')) i++;
    else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return;
  if (!sub.literal) {
    if (rest.length > 0) out.push({ kind: 'ask' });
    return;
  }
  if (sub.text === 'branch') {
    let del = false;
    let force = false;
    let strong = false;
    let remote = false;
    let ended = false;
    const names: Word[] = [];
    for (const w of rest) {
      if (!ended && w.literal && w.text === '--') ended = true;
      else if (!ended && isFlag(w)) {
        if (w.text === '--delete') del = true;
        else if (w.text === '--force') force = true;
        else if (w.text === '--remotes') remote = true;
        else if (!w.text.startsWith('--')) {
          if (w.text.includes('D')) strong = true;
          if (w.text.includes('d')) del = true;
          if (w.text.includes('f')) force = true;
          if (w.text.includes('r')) remote = true;
        }
      } else names.push(w);
    }
    if (!strong && !(del && force)) return;
    // リモート追跡のブランチ（-r）は確かめない
    out.push(remote ? { kind: 'ask' } : { kind: 'branch', cwd: dir, names, extra });
    return;
  }
  if (sub.text === 'worktree' && rest[0]?.literal && rest[0].text === 'remove') {
    let force = false;
    let ended = false;
    const paths: Word[] = [];
    for (const w of rest.slice(1)) {
      if (!ended && w.literal && w.text === '--') ended = true;
      else if (!ended && isFlag(w)) {
        if (w.text === '--force' || /^-[a-zA-Z]*f/.test(w.text)) force = true;
      } else paths.push(w);
    }
    // --force の無いものは、git が、変更の残る worktree を消さない
    if (force) out.push({ kind: 'worktree', cwd: dir, paths, extra });
  }
}

function hasWorktreesSegment(text: string): boolean {
  return text.split('/').includes('worktrees');
}

// worktree の rm -rf（パスの区切りの 1 つが worktrees のもの。worktree の中では . や .. や * も）は、確かめずに確認を出させる
function rmCommand(args: Word[], cwd: string | null, out: Action[]): void {
  let recursive = false;
  let force = false;
  let ended = false;
  const targets: Word[] = [];
  for (const w of args) {
    if (!ended && w.literal && w.text === '--') ended = true;
    else if (!ended && isFlag(w)) {
      if (w.text === '--recursive') recursive = true;
      else if (w.text === '--force') force = true;
      else if (!w.text.startsWith('--')) {
        if (/[rR]/.test(w.text)) recursive = true;
        if (w.text.includes('f')) force = true;
      }
    } else targets.push(w);
  }
  if (!recursive || !force) return;
  // cd の先が分からなければ、worktree の中にいるかもしれないとみなす
  const inWorktree = cwd === null || cwd.includes('/.claude/worktrees/');
  for (const { text } of targets) {
    if (hasWorktreesSegment(text)) return void out.push({ kind: 'ask' });
    if (inWorktree && (/^\.\.?\/?$/.test(text) || text.startsWith('../') || /^(\.\/)?\*$/.test(text) || text === cwd)) return void out.push({ kind: 'ask' });
  }
}

// リポジトリの、共通の git のフォルダ（worktree どうしで同じ）。リポジトリでなければ null
async function commonDir(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  if (!out?.trim()) return null;
  return realpath(out.trim()).catch(() => null);
}

// 確かめる。cwd: フックの入力の cwd（Claude Code の今のフォルダ）
export async function verifyCommand(command: string, cwd: string): Promise<GuardVerdict> {
  const actions = guardActions(command, cwd);
  const deletes: Exclude<Action, { kind: 'ask' }>[] = [];
  for (const a of actions) {
    if (a.kind === 'ask') return 'ask';
    if (a.extra || a.cwd === null) return 'ask';
    const words = a.kind === 'branch' ? a.names : a.paths;
    if (!words.every((w) => w.literal)) return 'ask';
    deletes.push(a);
  }
  if (deletes.length === 0) return 'pass';
  // リポジトリごとに、消すブランチと消す worktree をまとめて確かめる（一緒に消すブランチどうしで、互いのコミットを持つときに、
  // 両方を消してよいとしないように。一緒に消す worktree で取り出しているブランチは、取り出していないものとして数える）
  const repos = new Map<string, { cwd: string; root: string; branches: string[]; worktrees: string[] }>();
  for (const a of deletes) {
    const common = await commonDir(a.cwd!);
    if (!common || basename(common) !== '.git') return 'ask';
    let repo = repos.get(common);
    if (!repo) repos.set(common, (repo = { cwd: a.cwd!, root: dirname(common), branches: [], worktrees: [] }));
    if (a.kind === 'branch') repo.branches.push(...a.names.map((w) => w.text));
    else repo.worktrees.push(...a.paths.map((w) => resolve(a.cwd!, tilde(w.text))));
  }
  for (const repo of repos.values()) {
    for (const path of repo.worktrees) if (!(await insideWorktrees(repo.root, path)) || !(await worktreeSafeToRemove(repo.root, path))) return 'ask';
    if (repo.branches.length > 0 && !(await branchesSafeToDelete(repo.cwd, repo.branches, repo.worktrees))) return 'ask';
  }
  return 'pass';
}

// tanacode が作る worktree の場所（<リポジトリ>/.claude/worktrees/<名前>）か
async function insideWorktrees(root: string, path: string): Promise<boolean> {
  const [base, target] = await Promise.all([realpath(join(root, WORKTREES_DIR)).catch(() => null), realpath(path).catch(() => resolve(path))]);
  if (!base) return false;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/');
}
