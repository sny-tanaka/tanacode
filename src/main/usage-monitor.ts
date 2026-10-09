import { readFile, writeFile } from 'node:fs/promises';
import type { StatusLineInfo } from '@shared/statusline';
import type { UsageLimit, UsageLimits } from '@shared/usage';
import { CLAUDE_JSON } from './claude-account';

// プランの利用枠（5 時間枠・週の枠）。アプリのセッションが応答するたびに statusLine から受け取る。
// 裏で Claude Code を起動したりはしない。アプリを使っていない間の値は、Claude Code 自身の控えの方が新しければそちらを使う
export class UsageMonitor {
  private current: UsageLimits | null = null;

  constructor(
    private readonly file: string,
    private readonly onChange: (usage: UsageLimits) => void,
  ) {}

  async start(): Promise<void> {
    this.current = await readFile(this.file, 'utf8')
      .then((t) => JSON.parse(t) as UsageLimits)
      .catch(() => null);
    await this.refresh();
    if (this.current) this.onChange(this.current);
  }

  get(): UsageLimits | null {
    return this.current;
  }

  fromStatusLine(info: StatusLineInfo): void {
    const rl = info.rateLimits;
    if (!rl) return;
    const limits = [
      rl.fiveHour && { label: '5時間', percent: rl.fiveHour.percent, resetsAt: rl.fiveHour.resetsAt },
      rl.sevenDay && { label: '週', percent: rl.sevenDay.percent, resetsAt: rl.sevenDay.resetsAt },
    ].filter((l): l is UsageLimit => !!l);
    if (limits.length > 0) this.set({ limits, updatedAt: info.updatedAt, source: 'statusline' });
  }

  // Claude Code の控えの方が新しければ使う（本家で /usage を開いたあとなど）
  async refresh(): Promise<void> {
    const cached = await readClaudeCache();
    if (cached) this.set(cached);
  }

  private set(usage: UsageLimits): void {
    if (this.current && this.current.updatedAt >= usage.updatedAt) return;
    this.current = usage;
    void writeFile(this.file, JSON.stringify(usage, null, 2)).catch(() => {});
    this.onChange(usage);
  }
}

type CachedLimit = { kind?: string; percent?: number; resets_at?: string | null };

// Claude Code が /usage を開いたときに書く控え（~/.claude.json の cachedUsageUtilization）
async function readClaudeCache(): Promise<UsageLimits | null> {
  try {
    const json = JSON.parse(await readFile(CLAUDE_JSON, 'utf8')) as {
      cachedUsageUtilization?: { fetchedAtMs?: number; utilization?: { limits?: CachedLimit[] } };
    };
    const cache = json.cachedUsageUtilization;
    const list = cache?.utilization?.limits;
    if (!cache?.fetchedAtMs || !Array.isArray(list)) return null;
    const pick = (kind: string, label: string): UsageLimit | null => {
      const l = list.find((x) => x.kind === kind);
      return l && typeof l.percent === 'number'
        ? { label, percent: l.percent, resetsAt: l.resets_at ? Date.parse(l.resets_at) : null }
        : null;
    };
    const limits = [pick('session', '5時間'), pick('weekly_all', '週')].filter((l): l is UsageLimit => !!l);
    return limits.length > 0 ? { limits, updatedAt: cache.fetchedAtMs, source: 'claude-cache' } : null;
  } catch {
    return null;
  }
}
