import { basename } from 'node:path';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { ShellReplay, ShellSnapshot } from '@shared/ipc';
import { childEnv } from './claude-session';

// 控える行数（Claude が read_terminal で読める範囲）。出力は、pty-host.ts と同じく @xterm/headless の画面に書き込んで控える
// （色やカーソルの移動を解いた地の文で読めるように）
const SCROLLBACK = 3000;
// 終わったコマンドのタブの出力を、持ち主ごとに残す数の上限。画面がタブを閉じる（kill）まで残し、超えたら古いものから捨てる
const MAX_EXITED = 20;
// 止めたシェル（SIGHUP）がこの時間のうちに終わらなければ、強く止める（SIGKILL）。trap '' HUP などで SIGHUP を無視するもの
const KILL_GRACE_MS = 3000;
// Claude が打つために開くシェルの大きさ（画面のタブが大きさを合わせるまで）
const OPEN_COLS = 100;
const OPEN_ROWS = 30;
// 画面に出さずに動かしているコマンドの出力が、この時間止まっていて、カーソルが行の途中にあれば（問いを出し、改行せずに答えを待っている形）、
// 入力を待っているとみなしてタブに出す。見張るのは、この間ごと
const WAIT_QUIET_MS = 5000;
const WAIT_CHECK_MS = 1000;

// shell: 人が開いたシェル（と、Claude が打つために開いたシェル）/ command: アプリが動かしたコマンド（worktree の npm install など。画面に出すまではタブが無い）
export type TerminalKind = 'shell' | 'command';

type Shell = {
  proc: pty.IPty;
  owner: string;
  kind: TerminalKind;
  // タブの名前のもと（シェルは zsh など、コマンドは npm install など）と、動かしたコマンド（シェルは null）
  name: string;
  command: string | null;
  cwd: string;
  openedAt: number;
  lastOutputAt: number | null;
  // 動いている間は null
  exitCode: number | null;
  // シェルが付けたタイトル（OSC。画面のタブにも出る）
  title: string | null;
  term: Terminal;
  serializer: SerializeAddon;
  // 控えの画面に、まだ書き終えていない出力（@xterm/headless は少しずつ読み解く）。画面を引き継ぐとき、控えの画面のあとに渡す
  unparsed: string[];
  // 人が止めた・タブを閉じた（終わったら、出力の控えも捨てる）
  killed: boolean;
  // 止めたあと、終わらなければ強く止める待ちを片付ける（終わったら呼ぶ）
  cancelForceKill: (() => void) | null;
  // 画面に出さずに動かしているコマンド（run）。出すまで、出力・終わりを画面に知らせず、引き継ぐ画面にも渡さない
  hidden: boolean;
  // 入力を待っているかの見張りを片付ける（出したら・終わったら呼ぶ）
  cancelWatch: (() => void) | null;
};

// 一覧に返す 1 つのターミナル。tab: 持ち主のパネルの並びの何番目か（1 から。画面に出していないコマンドは null）/
// foreground: 前面で動いているプログラム（node-pty の pty.process）
export type TerminalInfo = {
  id: string;
  owner: string;
  tab: number | null;
  kind: TerminalKind;
  name: string;
  title: string | null;
  command: string | null;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  foreground: string | null;
  openedAt: number;
  lastOutputAt: number | null;
};

type Listeners = {
  onData: (id: string, data: string) => void;
  onExit: (id: string, exitCode: number) => void;
  // アプリがターミナルを開いた。task: コマンドのタブ（run）/ false: Claude が打つために開いたシェル（openShell）。
  // replay: 画面に出さずに動かしていたコマンドを出したときの、それまでの画面（reveal）
  onOpened?: (owner: string, id: string, name: string, task: boolean, replay?: ShellReplay) => void;
};

// ユーザーが自分で使うターミナル。セッション（owner）ごとに、そのフォルダでログインシェルを開く。
// 出力は画面に送るほか、Claude が読めるよう（terminal-control.ts）、シェルごとの画面（@xterm/headless）に控える。
// アプリが実行するコマンド（run）は、画面に出さずに動かし、人と一緒に見る必要があるときだけタブに出す
export class ShellTerminals {
  private shells = new Map<string, Shell>();
  private seq = 0;
  // 画面を読み込み直している（⌘R）。新しい画面が attach で引き継ぐまで、出力・終わり・開いたタブを画面に知らせない（控えには書く）
  private detached = false;

  // claudeDir: プロファイルの Claude Code の設定のフォルダ（シェルで起動する claude も、そのプロファイルのアカウントを使う）。null は既定のプロファイル。
  // later: 時間をおいて動かし、片付ける関数を返す（テストが差し替える）
  constructor(
    private readonly listeners: Listeners,
    private readonly claudeDir: string | null = null,
    private readonly clock: () => number = Date.now,
    private readonly later: (fn: () => void, ms: number) => () => void = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
  ) {}

  create(owner: string, cwd: string, cols: number, rows: number): { id: string; name: string } {
    const shell = process.env.SHELL || '/bin/zsh';
    const id = `shell-${++this.seq}`;
    this.spawn(id, owner, cwd, 'shell', basename(shell), null, ['-l'], cols, rows);
    return { id, name: basename(shell) };
  }

  // Claude が打つために、新しいシェルのタブを開く（type_in_terminal の new_tab）。画面には、人が開いたシェルと同じタブとして出す
  openShell(owner: string, cwd: string): { id: string; name: string } {
    const opened = this.create(owner, cwd, OPEN_COLS, OPEN_ROWS);
    if (!this.detached) this.listeners.onOpened?.(owner, opened.id, opened.name, false);
    return opened;
  }

  // アプリが実行するコマンド（worktree の npm install・yarn install など）を、画面に出さずに実行する。終了コードを返す。
  // 人と一緒に見る必要があるときだけ、それまでの出力ごとセッションのターミナルのタブに出す（reveal）: 失敗した・出力が止まって入力を待っているように
  // 見える（onWaiting で知らせる）・人が「ターミナルで見る」を押した（revealOwner）。出していない間も出力は控え、Claude は読める（list・tail）。
  // ログインシェルで実行する（Finder から起動したアプリでも、ふだんの PATH の npm を使うため）
  run(owner: string, cwd: string, command: string, name: string, onWaiting?: () => void): Promise<number> {
    const id = `task-${++this.seq}`;
    const shell = this.spawn(id, owner, cwd, 'command', name, command, ['-l', '-c', command], 100, 24, true);
    this.watchInput(id, shell, onWaiting);
    // シグナルで終わったもの（タブを閉じて止めた・強く止めた）は、node-pty が終了コードを 0 のまま返すので、シェルと同じく 128 + シグナルの番号にする
    // （0 のままだと、止めた install が済んだことになる）
    return new Promise((resolve) => shell.proc.onExit(({ exitCode, signal }) => resolve(signal ? 128 + signal : exitCode)));
  }

  // 画面に出していないコマンドを、それまでの出力ごとタブに出す。このあとは、出力・終わりを画面に知らせる。
  // 画面を読み込み直している間は、引き継ぐ画面に渡す（attach）
  reveal(id: string): void {
    const shell = this.shells.get(id);
    if (!shell?.hidden || shell.killed) return;
    shell.hidden = false;
    shell.cancelWatch?.();
    shell.cancelWatch = null;
    if (this.detached) return;
    let screen = '';
    try {
      screen = screenOf(shell);
    } catch {
      // 描き直す文字列を作れなければ、このあとの出力だけを出す
    }
    this.listeners.onOpened?.(shell.owner, id, shell.name, true, { exitCode: shell.exitCode, cols: shell.term.cols, rows: shell.term.rows, screen });
  }

  // 持ち主の、画面に出さずに動かしているコマンドを、タブに出す（人が準備中の「ターミナルで見る」を押した）
  revealOwner(owner: string): void {
    for (const [id, s] of [...this.shells]) if (s.owner === owner && s.hidden && s.exitCode === null) this.reveal(id);
  }

  // 止めたもの（kill したが、まだ終わっていない）には打たない
  write(id: string, data: string): void {
    const shell = this.shells.get(id);
    if (shell && shell.exitCode === null && !shell.killed) shell.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const shell = this.shells.get(id);
    if (!shell || shell.exitCode !== null || shell.killed || cols <= 0 || rows <= 0) return;
    shell.proc.resize(cols, rows);
    shell.term.resize(cols, rows);
  }

  // 止める。もう終わっていれば（終わったコマンドのタブを閉じた）、出力の控えを捨てる。
  // SIGHUP を無視するもの（trap '' HUP など）は終わらないので、しばらくして終わっていなければ強く止める。
  // 待ちがもうあれば作り直さない（終わる前に × を続けて押しても、最初に止めたときから数えて強く止める）
  kill(id: string): void {
    const shell = this.shells.get(id);
    if (!shell) return;
    shell.killed = true;
    if (shell.exitCode !== null) {
      this.drop(id);
      return;
    }
    shell.proc.kill();
    if (shell.cancelForceKill) return;
    shell.cancelForceKill = this.later(() => {
      shell.cancelForceKill = null;
      if (shell.exitCode !== null) return;
      try {
        shell.proc.kill('SIGKILL');
      } catch {
        // 終わりかけで、もういない
      }
    }, KILL_GRACE_MS);
  }

  // セッションを一覧から消したときは、そのフォルダで開いたシェルも閉じる
  killOwner(owner: string): void {
    for (const [id, shell] of this.shells) if (shell.owner === owner) this.kill(id);
  }

  killAll(): void {
    for (const id of [...this.shells.keys()]) this.kill(id);
  }

  // 画面を読み込み直し始めた。シェルは止めずに、新しい画面が引き継ぐまで知らせるのをやめる
  // （前の画面に送ったものも、引き継ぐまでに送ったものも、新しい画面には届かないか、引き継ぐ画面と重なるため）
  detach(): void {
    this.detached = true;
  }

  // 新しい画面が引き継ぐ。今のターミナルを開いた順に、画面を描き直すための文字列と一緒に返し、このあとは、また知らせる。
  // 文字列は、控えの画面と、まだ書き終えていない出力をつないだもの（返したあとに出たものだけを、知らせで送る）
  attach(): ShellSnapshot[] {
    this.detached = false;
    const snapshots: ShellSnapshot[] = [];
    for (const [id, s] of [...this.shells]) {
      // 止めている途中のもの（kill したが、まだ終わっていない）は渡さない（終わったら控えも捨てるので、タブに出さない）。
      // 画面に出していないコマンドも渡さない
      if (s.killed || s.hidden) continue;
      let screen: string;
      try {
        screen = screenOf(s);
      } catch {
        // 描き直す文字列を作れなかったものは、画面に出せないので、見えないまま動かし続けないよう止める（画面の側で書き直せなかったときと同じ）
        this.kill(id);
        continue;
      }
      snapshots.push({ owner: s.owner, id, name: s.name, title: s.title, task: s.kind === 'command', exitCode: s.exitCode, cols: s.term.cols, rows: s.term.rows, screen });
    }
    return snapshots;
  }

  // 持ち主のターミナル（パネルのタブの並び。開いた順）。止めたもの（kill したが、まだ終わっていない）は出さない（Claude から読ませず、打たせない）。
  // 番号は、止めたものも数えて振る（パネルは、終わるまで止めたもののタブも残すので、その並びと合わせる）。画面に出していないコマンドも
  // 一覧には入れる（Claude が出力を読める）が、パネルの並びには無いので、番号を振らない
  list(owner: string): TerminalInfo[] {
    const list: TerminalInfo[] = [];
    let tab = 0;
    for (const [id, s] of this.shells) {
      if (s.owner !== owner) continue;
      const position = s.hidden ? null : ++tab;
      if (!s.killed) list.push(this.infoOf(id, s, position));
    }
    return list;
  }

  info(id: string): TerminalInfo | null {
    const owner = this.shells.get(id)?.owner;
    return owner === undefined ? null : (this.list(owner).find((t) => t.id === id) ?? null);
  }

  // 届いた出力を、控えの画面に書き終えるまで待つ（@xterm/headless は、書き込みを少しずつ読み解く）
  flush(id: string): Promise<void> {
    const term = this.shells.get(id)?.term;
    return term ? new Promise((resolve) => term.write('', resolve)) : Promise.resolve();
  }

  // 控えの最後の count 行（地の文。折り返した行はつなぎ、後ろの空行は除く）。先に flush しておく
  tail(id: string, count: number): string[] | null {
    const term = this.shells.get(id)?.term;
    return term ? logicalLines(term, 0).slice(-count) : null;
  }

  // カーソルのある行（人が打ちかけたものがあれば、それも入っている）
  cursorLine(id: string): string | null {
    const buffer = this.shells.get(id)?.term.buffer.active;
    return buffer ? (buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '') : null;
  }

  // 今のカーソルの行に印を付け、そこから後に出た行を読む関数を返す。印は、控えが古い行を捨てて行の番号がずれても付いていく
  // （印の行まで捨てられたら、控えのはじめから読む）
  markCursor(id: string): (() => string[]) | null {
    const shell = this.shells.get(id);
    if (!shell) return null;
    const { term } = shell;
    const buffer = term.buffer.active;
    const marker = term.registerMarker(0);
    const fallback = buffer.baseY + buffer.cursorY;
    return () => {
      // シェルが終わって控えを捨てたあとは、読めるものが無い
      if (!this.shells.has(id)) return [];
      const from = marker ? (marker.isDisposed ? 0 : marker.line) : fallback;
      marker?.dispose();
      return logicalLines(term, Math.max(0, from));
    };
  }

  // 前面のプログラムが、矢印キーにアプリのモード（ESC O A）を求めているか（vim・less など）
  applicationCursor(id: string): boolean {
    return this.shells.get(id)?.term.modes.applicationCursorKeysMode ?? false;
  }

  private spawn(id: string, owner: string, cwd: string, kind: TerminalKind, name: string, command: string | null, args: string[], cols: number, rows: number, hidden = false): Shell {
    const env = childEnv(this.claudeDir);
    env.TERM_PROGRAM = 'tanacode';
    const proc = pty.spawn(process.env.SHELL || '/bin/zsh', args, { name: 'xterm-256color', cols, rows, cwd, env });
    const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    const shell: Shell = {
      proc,
      owner,
      kind,
      name,
      command,
      cwd,
      openedAt: this.clock(),
      lastOutputAt: null,
      exitCode: null,
      title: null,
      term,
      serializer,
      unparsed: [],
      killed: false,
      cancelForceKill: null,
      hidden,
      cancelWatch: null,
    };
    this.shells.set(id, shell);
    term.onTitleChange((title) => (shell.title = title || null));
    proc.onData((data) => {
      shell.lastOutputAt = this.clock();
      // 書き終えたものから順に外す（@xterm/headless は、届いた順に読み解き、終わったら順に呼ぶ）
      shell.unparsed.push(data);
      term.write(data, () => shell.unparsed.shift());
      if (!this.detached && !shell.hidden) this.listeners.onData(id, data);
    });
    proc.onExit(({ exitCode, signal }) => {
      // シグナルで終わったものは、run と同じく 128 + シグナルの番号にする（node-pty は 0 のまま返す。止められたコマンドを「完了」と出さない）
      const code = signal ? 128 + signal : exitCode;
      shell.exitCode = code;
      shell.cancelForceKill?.();
      shell.cancelForceKill = null;
      shell.cancelWatch?.();
      shell.cancelWatch = null;
      // 画面に出さずに動かしていたコマンドが失敗したら、出力ごとタブに出す（人が止めたもの・持ち主ごと止めたものは出さない）
      if (shell.hidden) {
        if (code !== 0 && !shell.killed) this.reveal(id);
      } else if (!this.detached) this.listeners.onExit(id, code);
      // 画面はシェルのタブを閉じる。コマンドは、出力を見られる（Claude が読める）よう残す（人が止めたものは閉じる）
      if (kind === 'shell' || shell.killed) this.drop(id);
      else this.pruneExited(owner);
    });
    return shell;
  }

  // 画面に出していないコマンドが、入力を待っているように見えたらタブに出し、onWaiting で知らせる。
  // 出力が WAIT_QUIET_MS 止まり、カーソルが行の途中にある（「Proceed? (Y/n) 」のような問いを出し、改行せずに答えを待っている）とき。
  // 進み具合を出すもの（スピナー・進捗の行）は止まらずに書き直し続け、仕事の出力はふつう行の終わりで改行するので、どちらにも当たらない
  private watchInput(id: string, shell: Shell, onWaiting?: () => void): void {
    shell.cancelWatch = this.later(() => {
      shell.cancelWatch = null;
      if (!shell.hidden || shell.exitCode !== null || shell.killed) return;
      if (!this.waitingForInput(shell)) return this.watchInput(id, shell, onWaiting);
      this.reveal(id);
      onWaiting?.();
    }, WAIT_CHECK_MS);
  }

  private waitingForInput(shell: Shell): boolean {
    if (this.clock() - (shell.lastOutputAt ?? shell.openedAt) < WAIT_QUIET_MS || shell.unparsed.length > 0) return false;
    const buffer = shell.term.buffer.active;
    return buffer.cursorX > 0 && !!buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).trim();
  }

  private drop(id: string): void {
    const shell = this.shells.get(id);
    if (!shell) return;
    this.shells.delete(id);
    shell.term.dispose();
  }

  // 終わったコマンドのタブの控えを、持ち主ごとに上限まで残す（古いものから捨てる）
  private pruneExited(owner: string): void {
    const exited = [...this.shells].filter(([, s]) => s.owner === owner && s.exitCode !== null);
    for (const [id] of exited.slice(0, Math.max(0, exited.length - MAX_EXITED))) this.drop(id);
  }

  private infoOf(id: string, s: Shell, tab: number | null): TerminalInfo {
    const running = s.exitCode === null;
    return {
      id,
      owner: s.owner,
      tab,
      kind: s.kind,
      name: s.name,
      title: s.title,
      command: s.command,
      cwd: s.cwd,
      running,
      exitCode: s.exitCode,
      foreground: running ? foregroundOf(s.proc) : null,
      openedAt: s.openedAt,
      lastOutputAt: s.lastOutputAt,
    };
  }
}

// 控えの画面を描き直すための文字列（控えの画面と、まだ書き終えていない出力をつないだもの）。作れなければ投げる
function screenOf(s: Shell): string {
  return s.serializer.serialize() + s.unparsed.join('');
}

function foregroundOf(proc: pty.IPty): string | null {
  try {
    return proc.process || null;
  } catch {
    // 終わりかけで読めない
    return null;
  }
}

// from の行から最後までを、折り返しをつないだ行にする。行の右の空白と、後ろの空行（カーソルより下のまだ使っていない行）は除く
function logicalLines(term: Terminal, from: number): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = from; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // 次の行へ折り返している行は、右の空白も文字のうち
    const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
    if (line.isWrapped && y > from && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const trimmed = lines.map((line) => line.trimEnd());
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}
