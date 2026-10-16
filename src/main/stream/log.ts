import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// 1 行のうち控えに書く長さ（画像の base64 などの長い行を、そのまま書かない）
const MAX_LOGGED_CHARS = 64 * 1024;

// stream-json の送受信の控え（不具合を調べるため）。セッションごとに 1 つのファイルに、時刻・向き・行を書く。
// 発言・ツールの入出力がそのまま入るので、本人だけが読めるようにする（0600）。上限を超えたら、前の分を .1 に回して書き直す
// （古いものから消える）。セッションを一覧から消したら一緒に消す（remove）。長い行は頭だけを書く（本体のスレッドで同期で書くため）
export class LineLog {
  private fd: number | null = null;
  private bytes = 0;
  // 閉じた（claude が終わった・アプリが見るのをやめた）。そのあとに届いた行は書かない（開き直したまま閉じないことがないように）
  private closed = false;

  constructor(
    readonly path: string,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  // dir: '<' は Claude Code から、'>' はアプリから
  write(dir: '<' | '>', line: string): void {
    if (this.closed) return;
    try {
      this.open();
      const shown = line.length > MAX_LOGGED_CHARS ? `${line.slice(0, MAX_LOGGED_CHARS)}…（${line.length} 文字。以下は略）` : line;
      const text = `${new Date().toISOString()} ${dir} ${shown}\n`;
      writeSync(this.fd!, text);
      this.bytes += Buffer.byteLength(text);
      if (this.bytes > this.maxBytes) this.rotate();
    } catch {
      // 控えが書けなくても、やりとりは続ける
    }
  }

  close(): void {
    this.closed = true;
    this.closeFile();
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
    // 作るときの 0600 は、前からあったファイルには効かない
    fchmodSync(this.fd, 0o600);
    this.bytes = statSync(this.path).size;
  }

  private closeFile(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  private rotate(): void {
    this.closeFile();
    renameSync(this.path, `${this.path}.1`);
    this.bytes = 0;
  }
}
