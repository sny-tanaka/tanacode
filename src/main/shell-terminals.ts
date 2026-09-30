import { basename } from 'node:path';
import * as pty from 'node-pty';
import { childEnv } from './claude-session';

type Shell = { proc: pty.IPty; owner: string };

type Listeners = {
  onData: (id: string, data: string) => void;
  onExit: (id: string, exitCode: number) => void;
};

// ユーザーが自分で使うターミナル。セッション（owner）ごとに、そのフォルダでログインシェルを開く
export class ShellTerminals {
  private shells = new Map<string, Shell>();
  private seq = 0;

  constructor(private readonly listeners: Listeners) {}

  create(owner: string, cwd: string, cols: number, rows: number): { id: string; name: string } {
    const shell = process.env.SHELL || '/bin/zsh';
    const env = childEnv();
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
