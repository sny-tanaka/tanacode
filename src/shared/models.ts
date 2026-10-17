// Claude Code の /model に出るモデルの一覧（アプリのモデル欄の選択肢）

export type ModelChoice = {
  // --model に渡す値（opus[1m] などの別名、またはモデル ID）
  value: string;
  // 表示名（例: Opus 5）
  name: string;
  // /model の説明（使えないものは更新が必要なバージョンなど）
  detail: string;
  // 今の Claude Code では使えない（更新が必要）
  disabled: boolean;
  // 選べるエフォート（low など）。空ならエフォートを選べないモデル
  efforts: string[];
};

export type ModelCatalog = { choices: ModelChoice[]; updatedAt: number };

// 動いている Claude Code がその場で切り替えられるモデル（initialize の models）。
// value: set_model に渡す値（別名など）/ resolvedModel: その別名が指すモデル ID / name: Claude Code が付けた名前 /
// efforts: 選べるエフォート。空ならエフォートを選べないモデル
export type SessionModel = { value: string; resolvedModel: string | null; name: string; efforts: string[] };
