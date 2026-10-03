import { formatTokens } from '../workflow/WorkflowCard';

// コンテキストの使用量。多くなると自動で圧縮され、読んだファイルの中身を忘れる。押すと、サイドパネルに中身の一覧を出す
export function ContextMeter({ tokens, limit, onClick }: { tokens: number | null; limit: number; onClick: () => void }) {
  if (tokens === null) return null;
  const ratio = Math.min(tokens / limit, 1);
  const level = ratio >= 0.8 ? 'high' : ratio >= 0.5 ? 'mid' : 'low';
  return (
    <button
      type="button"
      className={`context-meter ${level}`}
      onClick={onClick}
      aria-label="コンテキストの中身"
      data-tip={`コンテキスト ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens（直近の応答時点）\nいっぱいに近づくと自動で圧縮されます。押すと中身の一覧を出します`}
    >
      <span className="context-meter-bar">
        <span style={{ width: `${Math.max(ratio * 100, 2)}%` }} />
      </span>
      <span className="context-meter-value">
        {Math.round(ratio * 100)}% · {formatTokens(tokens)}
      </span>
    </button>
  );
}
