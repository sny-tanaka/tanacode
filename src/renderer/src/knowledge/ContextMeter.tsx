import { formatTokens } from '../workflow/WorkflowCard';

// コンテキストの使用量。多くなると自動で圧縮され、読んだファイルの中身を忘れる
export function ContextMeter({ tokens, limit }: { tokens: number | null; limit: number }) {
  if (tokens === null) return null;
  const ratio = Math.min(tokens / limit, 1);
  const level = ratio >= 0.8 ? 'high' : ratio >= 0.5 ? 'mid' : 'low';
  return (
    <div
      className={`context-meter ${level}`}
      title={`コンテキスト ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens（直近の応答時点）。いっぱいに近づくと自動で圧縮されます`}
    >
      <span className="context-meter-bar">
        <span style={{ width: `${Math.max(ratio * 100, 2)}%` }} />
      </span>
      <span className="context-meter-value">
        {Math.round(ratio * 100)}% · {formatTokens(tokens)}
      </span>
    </div>
  );
}
