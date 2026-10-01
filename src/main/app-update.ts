import { REPO_URL, type AppUpdate } from '@shared/app-update';
import { compareVersions } from '@shared/claude-code';

// tanacode の新しい版。自動アップデートは無いので、GitHub の公開の Releases の最新の版を確かめて、タイトルバーで知らせるだけ。
// releases/latest は公開済みの版だけを返す（下書き・プレリリースは返さない）。認証なしの上限は 1 時間に 60 回なので、1 時間ごとで足りる
const REPO = 'sny-tanaka/tanacode';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const INTERVAL_MS = 60 * 60_000;
const TIMEOUT_MS = 15_000;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// releases/latest の返事から版を取り出す（タグ v0.1.5 → 0.1.5）。形が違えば null
export function parseLatestRelease(body: unknown): string | null {
  const tag = typeof body === 'object' && body !== null ? (body as { tag_name?: unknown }).tag_name : undefined;
  return (typeof tag === 'string' && /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1]) || null;
}

// 開くページは、返事の html_url を使わずに版から組み立てる（Releases のページ以外を開かない）
export function appUpdateOf(current: string, latest: string): AppUpdate {
  return { latest, available: compareVersions(latest, current) > 0, url: `${REPO_URL}/releases/tag/v${latest}` };
}

// 起動時と 1 時間ごとに確かめ、結果が変わったら知らせる。確かめられなかったとき（オフラインなど）は、前の結果のままにする。
// 止めたとき（設定でオフにしたとき）は、結果を消して null を知らせる
export class AppUpdateMonitor {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private last: AppUpdate | null = null;

  constructor(
    private readonly version: string,
    private readonly onChange: (update: AppUpdate | null) => void,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), INTERVAL_MS);
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.set(null);
  }

  get(): AppUpdate | null {
    return this.last;
  }

  // 確かめている途中なら、それを待つ（同時に何度も問い合わせない）
  refresh(): Promise<void> {
    this.current ??= this.check().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async check(): Promise<void> {
    let latest: string | null = null;
    try {
      const res = await this.fetcher(LATEST_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) latest = parseLatestRelease(await res.json());
    } catch {
      // オフライン・タイムアウト・JSON でない返事は、次の機会に確かめ直す
    }
    // 問い合わせのあいだに止めたら、結果を捨てる
    if (latest && this.timer) this.set(appUpdateOf(this.version, latest));
  }

  private set(update: AppUpdate | null): void {
    if (JSON.stringify(update) === JSON.stringify(this.last)) return;
    this.last = update;
    this.onChange(update);
  }
}
