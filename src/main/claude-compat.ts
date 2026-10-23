import { readFileSync, writeFileSync } from 'node:fs';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import { parseCompatTable, verifiedFor } from '@shared/claude-compat';
import type { Fetcher } from './app-update';

// 動作確認済の Claude Code のバージョン（ステータスバーの印で比べる相手）。アプリを配信しなくても上げられるように、
// リポジトリの develop にある対応表（compat.json）を読み、このアプリのバージョンの行を使う。
// - 読めない（オフライン・形が違う）ときは、最後に読めた表（userData に控える）、それも無ければアプリに組み込んだバージョン。画面には何も出さない
// - 表にこのアプリの行が無いときも、組み込んだバージョン
// - 新しいバージョンの通知の設定（updateCheckEnabled）がオフなら読まない（組み込んだバージョンを使う）
// 署名は付けない（表が変えるのはステータスバーの印だけ）。HTTPS で読み、形を厳しく確かめる（parseCompatTable）
export const COMPAT_URL = 'https://raw.githubusercontent.com/sny-tanaka/tanacode/develop/compat.json';
const INTERVAL_MS = 60 * 60_000;
const TIMEOUT_MS = 15_000;
// 表は数 KB。これより長い返事は読まない
const MAX_CHARS = 64 * 1024;

// 控えの形。読んだアプリのバージョンも残し、アプリを入れ替えたあとは使わない（前のバージョンのときに読んだ表は、新しいバージョンの行が無いことがある）
type Cache = { app: string; table: unknown };

export class ClaudeCompatMonitor {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private last = VERIFIED_CLAUDE_CODE_VERSION;

  constructor(
    private readonly app: string,
    // 最後に読めた表の控え（userData の中）
    private readonly cacheFile: string,
    private readonly onChange: (verified: string) => void,
    private readonly fetcher: Fetcher = fetch,
    private readonly url = COMPAT_URL,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), INTERVAL_MS);
    this.set(this.fromCache() ?? VERIFIED_CLAUDE_CODE_VERSION);
    void this.refresh();
  }

  // 止めたとき（設定でオフにしたとき）は、組み込んだバージョンに戻す
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.set(VERIFIED_CLAUDE_CODE_VERSION);
  }

  get(): string {
    return this.last;
  }

  // 読み直す。読んでいる途中なら、それを待つ。止めているときは読まない
  refresh(): Promise<void> {
    if (!this.timer) return Promise.resolve();
    this.current ??= this.check().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async check(): Promise<void> {
    let table: unknown = null;
    try {
      const res = await this.fetcher(this.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const text = await res.text();
        if (text.length <= MAX_CHARS) table = JSON.parse(text);
      }
    } catch {
      // オフライン・タイムアウト・JSON でない返事は、次の機会に読み直す
    }
    const rows = parseCompatTable(table);
    // 問い合わせのあいだに止めたら、結果を捨てる。読めなかったときは、今のまま（控えか組み込み）
    if (!rows || !this.timer) return;
    this.save({ app: this.app, table });
    this.set(verifiedFor(rows, this.app) ?? VERIFIED_CLAUDE_CODE_VERSION);
  }

  private fromCache(): string | null {
    try {
      const cache = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Partial<Cache> | null;
      if (cache?.app !== this.app) return null;
      const rows = parseCompatTable(cache.table);
      return rows && verifiedFor(rows, this.app);
    } catch {
      // 無い・壊れている控えは使わない（次に読めたときに書き直す）
      return null;
    }
  }

  private save(cache: Cache): void {
    try {
      writeFileSync(this.cacheFile, JSON.stringify(cache));
    } catch (error) {
      console.error('Claude Code の対応表の控えを保存できませんでした', error);
    }
  }

  private set(verified: string): void {
    if (verified === this.last) return;
    this.last = verified;
    this.onChange(verified);
  }
}
