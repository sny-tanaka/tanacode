import { useEffect, useState } from 'react';
import type { UsageLimit, UsageLimits } from '@shared/usage';

// これより古い値は、いつの値かを添えて出す
const STALE_MS = 30 * 60_000;

// セッション一覧の最下部に出す、プランの利用枠（5 時間枠・週の枠）。
// アプリのセッションが応答するたびに更新される。クリックで Claude Code 自身の控え（/usage を開いたときのもの）も確かめる
export function UsagePanel() {
  const [usage, setUsage] = useState<UsageLimits | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void window.tanacode.usage.get().then((u) => u && setUsage(u));
    return window.tanacode.usage.onChanged(setUsage);
  }, []);
  // リセットまでの残り時間を進める
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const age = usage ? now - usage.updatedAt : 0;
  const at = usage ? new Date(usage.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <button
      className="usage-panel"
      onClick={() => {
        setNow(Date.now());
        void window.tanacode.usage.refresh();
      }}
      title={usage ? `プランの利用枠。${at} 時点（${usage.source === 'statusline' ? 'セッションの応答から' : 'Claude Code の /usage の控えから'}）` : 'プランの利用枠'}
    >
      {!usage || usage.limits.length === 0 ? (
        <span className="usage-empty">利用枠はセッションが応答すると表示されます</span>
      ) : (
        usage.limits.map((limit) => <Gauge key={limit.label} limit={limit} now={now} />)
      )}
      {usage && age > STALE_MS && <span className="usage-status">{at} 時点の値</span>}
    </button>
  );
}

function Gauge({ limit, now }: { limit: UsageLimit; now: number }) {
  // リセット時刻を過ぎていれば、使用率はもう当てにならない
  const reset = limit.resetsAt !== null && limit.resetsAt <= now;
  const level = limit.percent >= 90 ? 'high' : limit.percent >= 70 ? 'mid' : 'low';
  return (
    <div className={`usage-gauge ${level}${reset ? ' reset' : ''}`}>
      <div className="usage-row">
        <span className="usage-label">{limit.label}</span>
        <span className="usage-percent">{reset ? '—' : `${limit.percent}%`}</span>
        <span className="usage-reset">{reset ? 'リセット済み' : remaining(limit.resetsAt, now)}</span>
      </div>
      <div className="usage-bar">
        <span style={{ width: `${reset ? 0 : Math.min(100, Math.max(limit.percent, 1))}%` }} />
      </div>
    </div>
  );
}

// 「あと 2時間13分」「あと 4日18時間」
function remaining(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '';
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (minutes < 60) return `あと ${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `あと ${hours}時間${minutes % 60}分`;
  return `あと ${Math.floor(hours / 24)}日${hours % 24}時間`;
}
