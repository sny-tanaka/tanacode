import { basename } from 'node:path';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { ShellSnapshot } from '@shared/ipc';
import { childEnv } from './claude-session';

// 控える行数（Claude が read_terminal で読める範囲）。出力は、pty-host.ts と同じく @xterm/headless の画面に書き込んで控える
// （色やカーソルの移動を解いた地の文で読めるように）
const SCROLLBACK = 3000;
// 終わったコマンドのタブの出力を、持ち主ごとに残す数の上限。画面がタブを閉じる（kill）まで残し、超えたら古いものから捨てる
const MAX_EXITED = 20;
// Claude が打つために開くシェルの大きさ（画面のタブが大きさを合わせるまで）
const OPEN_COLS = 100;
const OPEN_ROWS = 30;

// shell: 人が開いたシェル（と、Claude が打つために開いたシェル）/ command: アプリがコマンドを動かしたタブ（worktree の npm install など）
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
};

// 一覧に返す 1 つのターミナル。tab: 持ち主のパネルの並びの何番目か（1 から）/ foreground: 前面で動いているプログラム（node-pty の pty.process）
export type TerminalInfo = {
  id: string;
  owner: string;
  tab: number;
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
  // アプリがターミナルを開いた。task: コマンドのタブ（run）/ false: Claude が打つために開いたシェル（openShell）
  onOpened?: (owner: string, id: string, name: string, task: boolean) => void;
};

// ユーザーが自分で使うターミナル。セッション（owner）ごとに、そのフォルダでログインシェルを開く。
// 出力は画面に送るほか、Claude が読めるよう（terminal-control.ts）、シェルごとの画面（@xterm/headless）に控える
export class ShellTerminals {
  private shells = new Map<string, Shell>();
  private seq = 0;
  // 画面を読み込み直している（⌘R）。新しい画面が attach で引き継ぐまで、出力・終わり・開いたタブを画面に知らせない（控えには書く）
  private detached = false;

  // claudeDir: プロファイルの Claude Code の設定のフォルダ（シェルで起動する claude も、そのプロファイルのアカウントを使う）。null は既定のプロファイル
  constructor(
    private readonly listeners: Listeners,
    private readonly claudeDir: string | null = null,
    private readonly clock: () => number = Date.now,
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

  // アプリが実行するコマンド（worktree の npm install・yarn install など）を、セッションのターミナルのタブに出しながら実行する。終了コードを返す。
  // ログインシェルで実行する（Finder から起動したアプリでも、ふだんの PATH の npm を使うため）
  run(owner: string, cwd: string, command: string, name: string): Promise<number> {
    const id = `task-${++this.seq}`;
    const shell = this.spawn(id, owner, cwd, 'command', name, command, ['-l', '-c', command], 100, 24);
    if (!this.detached) this.listeners.onOpened?.(owner, id, name, true);
    return new Promise((resolve) => shell.proc.onExit(({ exitCode }) => resolve(exitCode)));
  }

  write(id: string, data: string): void {
    const shell = this.shells.get(id);
    if (shell && shell.exitCode === null) shell.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const shell = this.shells.get(id);
    if (!shell || shell.exitCode !== null || cols <= 0 || rows <= 0) return;
    shell.proc.resize(cols, rows);
    shell.term.resize(cols, rows);
  }

  // 止める。もう終わっていれば（終わったコマンドのタブを閉じた）、出力の控えを捨てる
  kill(id: string): void {
    const shell = this.shells.get(id);
    if (!shell) return;
    shell.killed = true;
    if (shell.exitCode === null) shell.proc.kill();
    else this.drop(id);
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
    // 止めている途中のもの（kill したが、まだ終わっていない）は渡さない（終わったら控えも捨てるので、タブに出さない）
    return [...this.shells].filter(([, s]) => !s.killed).map(([id, s]) => ({
      owner: s.owner,
      id,
      name: s.name,
      title: s.title,
      task: s.kind === 'command',
      exitCode: s.exitCode,
      cols: s.term.cols,
      rows: s.term.rows,
      screen: s.serializer.serialize() + s.unparsed.join(''),
    }));
  }

  // 持ち主のターミナル（パネルのタブの並び。開いた順）
  list(owner: string): TerminalInfo[] {
    return [...this.shells].filter(([, s]) => s.owner === owner).map(([id, s], i) => this.infoOf(id, s, i + 1));
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

  private spawn(id: string, owner: string, cwd: string, kind: TerminalKind, name: string, command: string | null, args: string[], cols: number, rows: number): Shell {
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
    };
    this.shells.set(id, shell);
    term.onTitleChange((title) => (shell.title = title || null));
    proc.onData((data) => {
      shell.lastOutputAt = this.clock();
      // 書き終えたものから順に外す（@xterm/headless は、届いた順に読み解き、終わったら順に呼ぶ）
      shell.unparsed.push(data);
      term.write(data, () => shell.unparsed.shift());
      if (!this.detached) this.listeners.onData(id, data);
    });
    proc.onExit(({ exitCode }) => {
      shell.exitCode = exitCode;
      if (!this.detached) this.listeners.onExit(id, exitCode);
      // 画面はシェルのタブを閉じる。コマンドのタブは、出力を見られるよう残す（人が止めたものは閉じる）
      if (kind === 'shell' || shell.killed) this.drop(id);
      else this.pruneExited(owner);
    });
    return shell;
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

  private infoOf(id: string, s: Shell, tab: number): TerminalInfo {
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
