import { readFile, writeFile } from 'node:fs/promises';
import type { StatusLineInfo } from '@shared/statusline';
import type { UsageLimit, UsageLimits } from '@shared/usage';
import { claudeJsonPath } from './claude-config';
import type { UsageReport } from './stream/state';

// プランの利用枠（5 時間枠・週の枠・モデル別の週の枠）。アプリのセッションが応答するたびに statusLine から、チャットのターンの終わりに
// get_usage から（モデル別の枠はこちらだけ）受け取る。
// 裏で Claude Code を起動したりはしない。アプリを使っていない間の値は、Claude Code 自身の控えの方が新しければそちらを使う
export class UsageMonitor {
  private current: UsageLimits | null = null;

  // claudeDir: プロファイルの Claude Code の設定のフォルダ（/usage の控えを読む .claude.json の場所。null は既定のプロファイル）
  constructor(
    private readonly file: string,
    private readonly onChange: (usage: UsageLimits) => void,
    private readonly claudeDir: string | null = null,
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

  // チャットのターンの終わりに聞いた get_usage の利用枠（モデル別の週の枠を含む）
  fromUsage(report: UsageReport, updatedAt: number): void {
    if (report.limits.length > 0) this.set({ limits: report.limits, updatedAt, source: 'usage' }, report.modelsKnown);
  }

  fromStatusLine(info: StatusLineInfo): void {
    const rl = info.rateLimits;
    if (!rl) return;
    const limits = [
      rl.fiveHour && { label: '5時間', percent: rl.fiveHour.percent, resetsAt: rl.fiveHour.resetsAt },
      rl.sevenDay && { label: '週', percent: rl.sevenDay.percent, resetsAt: rl.sevenDay.resetsAt },
    ].filter((l): l is UsageLimit => !!l);
    if (limits.length > 0) this.set({ limits, updatedAt: info.rateLimitsAt ?? info.updatedAt, source: 'statusline' }, false);
  }

  // Claude Code の控えの方が新しければ使う（本家で /usage を開いたあとなど）
  async refresh(): Promise<void> {
    const cached = await readClaudeCache(this.claudeDir);
    if (cached) this.set(cached, true);
  }

  // 新しい値で置き換える。届いた値に無い枠は、前の値を残す。ただしモデル別の週の枠は、モデルの一覧を持つ知らせ（allModels。
  // model_scoped のある get_usage・控え）では、そのとき届いたものに置き換える（無くなったモデルの枠は残さない）。一覧を持たない
  // 知らせ（statusLine・model_scoped の無い get_usage）では、届かなかったモデルの枠を残す
  private set(usage: UsageLimits, allModels: boolean): void {
    if (this.current && this.current.updatedAt >= usage.updatedAt) return;
    const arrived = (old: UsageLimit) =>
      usage.limits.some((l) => (old.model ? l.model?.toLowerCase() === old.model.toLowerCase() : !l.model && l.label === old.label));
    const before = this.current;
    // 残す枠は、その値を得た時刻を持たせる（新しい知らせの時刻を付けて、新しく見せない）
    const kept = (before?.limits ?? [])
      .filter((old) => !(old.model && allModels) && !arrived(old))
      .map((old) => ({ ...old, updatedAt: old.updatedAt ?? before!.updatedAt }));
    usage = { ...usage, limits: [...usage.limits.filter((l) => !l.model), ...kept.filter((l) => !l.model), ...usage.limits.filter((l) => l.model), ...kept.filter((l) => l.model)] };
    this.current = usage;
    void writeFile(this.file, JSON.stringify(usage, null, 2)).catch(() => {});
    this.onChange(usage);
  }
}

// scope.model: モデル別の週の枠（kind は weekly_scoped）。surface（使う場所ごとの枠）は出さない
type CachedLimit = { kind?: string; percent?: number; resets_at?: string | null; scope?: { model?: { display_name?: unknown } | null } | null };

// Claude Code が /usage を開いたときに書く控え（.claude.json の cachedUsageUtilization）
async function readClaudeCache(claudeDir: string | null): Promise<UsageLimits | null> {
  try {
    const json = JSON.parse(await readFile(claudeJsonPath(claudeDir), 'utf8')) as {
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
    const models = list
      .filter((x) => x.kind === 'weekly_scoped' && typeof x.scope?.model?.display_name === 'string' && x.scope.model.display_name && typeof x.percent === 'number')
      .map((x): UsageLimit => ({ label: '週', model: String(x.scope!.model!.display_name), percent: x.percent!, resetsAt: x.resets_at ? Date.parse(x.resets_at) : null }));
    const limits = [pick('session', '5時間'), pick('weekly_all', '週'), ...models].filter((l): l is UsageLimit => !!l);
    return limits.length > 0 ? { limits, updatedAt: cache.fetchedAtMs, source: 'claude-cache' } : null;
  } catch {
    return null;
  }
}
