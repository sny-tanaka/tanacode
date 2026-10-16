import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// stream-json の送受信の控え（不具合を調べるため）。セッションごとに 1 つのファイルに、時刻・向き・行を書く。
// 発言・ツールの入出力がそのまま入るので、本人だけが読めるようにする（0600）。上限を超えたら、前の分を .1 に回して書き直す
// （古いものから消える）。セッションを一覧から消したら一緒に消す（remove）
export class LineLog {
  private fd: number | null = null;
  private bytes = 0;

  constructor(
    readonly path: string,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  // dir: '<' は Claude Code から、'>' はアプリから
  write(dir: '<' | '>', line: string): void {
    try {
      this.open();
      const text = `${new Date().toISOString()} ${dir} ${line}\n`;
      writeSync(this.fd!, text);
      this.bytes += Buffer.byteLength(text);
      if (this.bytes > this.maxBytes) this.rotate();
    } catch {
      // 控えが書けなくても、やりとりは続ける
    }
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  // 控えを消す（セッションを一覧から消したとき）
  remove(): void {
    this.close();
    rmSync(this.path, { force: true });
    rmSync(`${this.path}.1`, { force: true });
  }

  private open(): void {
    if (this.fd !== null) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.fd = openSync(this.path, 'a', 0o600);
    this.bytes = statSync(this.path).size;
  }

  private rotate(): void {
    this.close();
    renameSync(this.path, `${this.path}.1`);
    this.bytes = 0;
  }
}
