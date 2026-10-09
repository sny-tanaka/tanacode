import { basename } from 'node:path';
import * as pty from 'node-pty';
import { childEnv } from './claude-session';

type Shell = { proc: pty.IPty; owner: string };

type Listeners = {
  onData: (id: string, data: string) => void;
  onExit: (id: string, exitCode: number) => void;
  // アプリがコマンドのターミナルを開いた（run）
  onOpened?: (owner: string, id: string, name: string) => void;
};

// ユーザーが自分で使うターミナル。セッション（owner）ごとに、そのフォルダでログインシェルを開く
export class ShellTerminals {
  private shells = new Map<string, Shell>();
  private seq = 0;

  // claudeDir: プロファイルの Claude Code の設定のフォルダ（シェルで起動する claude も、そのプロファイルのアカウントを使う）。null は既定のプロファイル
  constructor(
    private readonly listeners: Listeners,
    private readonly claudeDir: string | null = null,
  ) {}

  create(owner: string, cwd: string, cols: number, rows: number): { id: string; name: string } {
    const shell = process.env.SHELL || '/bin/zsh';
    const env = childEnv(this.claudeDir);
    env.TERM_PROGRAM = 'tanacode';
    const proc = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd, env });
    const id = `shell-${++this.seq}`;
    this.shells.set(id, { proc, owner });
    proc.onData((data) => this.listeners.onData(id, data));
    proc.onExit(({ exitCode }) => {
      this.shells.delete(id);
      this.listeners.onExit(id, exitCode);
    });
    return { id, name: basename(shell) };
  }

  // アプリが実行するコマンド（worktree の npm install・yarn install など）を、セッションのターミナルのタブに出しながら実行する。終了コードを返す。
  // ログインシェルで実行する（Finder から起動したアプリでも、ふだんの PATH の npm を使うため）
  run(owner: string, cwd: string, command: string, name: string): Promise<number> {
    const shell = process.env.SHELL || '/bin/zsh';
    const env = childEnv(this.claudeDir);
    env.TERM_PROGRAM = 'tanacode';
    const proc = pty.spawn(shell, ['-l', '-c', command], { name: 'xterm-256color', cols: 100, rows: 24, cwd, env });
    const id = `task-${++this.seq}`;
    this.shells.set(id, { proc, owner });
    proc.onData((data) => this.listeners.onData(id, data));
    this.listeners.onOpened?.(owner, id, name);
    return new Promise((resolve) => {
      proc.onExit(({ exitCode }) => {
        this.shells.delete(id);
        this.listeners.onExit(id, exitCode);
        resolve(exitCode);
      });
    });
  }

  write(id: string, data: string): void {
    this.shells.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.shells.get(id)?.proc.resize(cols, rows);
  }

  kill(id: string): void {
    this.shells.get(id)?.proc.kill();
  }

  // セッションを一覧から消したときは、そのフォルダで開いたシェルも閉じる
  killOwner(owner: string): void {
    for (const [id, shell] of this.shells) if (shell.owner === owner) this.kill(id);
  }

  killAll(): void {
    for (const id of this.shells.keys()) this.kill(id);
  }
}
