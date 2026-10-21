import type { AskQuestion } from './screen';

// Claude Code が答えを待っている AskUserQuestion（stream-json の can_use_tool。main の pending-questions.ts）。
// 質問のカードは、この質問だけで描く。id: アプリが付ける、待っている質問ごとの番号。
// answered: 親が 1 問ずつ答えている途中の、答えた質問の答え（質問文 → 答え。カードは全部の答えを一度に返すので使わない）
export type PendingQuestion = { id: string; questions: AskQuestion[]; answered: Record<string, string> };

// 質問ごとの添え書き（質問文 → 添え書き）。preview: 選んだ選択肢のプレビュー
export type QuestionAnnotations = Record<string, { preview: string }>;

// 待っている質問への返事。
// answer: 質問文 → 答え（annotations: 質問ごとの添え書き）/ cancel: キャンセル（画面の Esc と同じく、Claude の作業を止める）
export type QuestionReply = { kind: 'answer'; answers: Record<string, string>; annotations?: QuestionAnnotations } | { kind: 'cancel' };

// Claude Code が答えを待っている、質問でない要求（stream-json の can_use_tool。ツールの実行の許可・プランの承認・ワークフローの確認）。
// id: 要求の ID（request_id）/ tool: ツールの名前 / title・description: Claude Code が付けた見出しと説明 / input: ツールの入力の全文 /
// reason: 確認する理由 / always: 「今後は聞かない」で足す許可の短い名前（例: Bash(npm test:*)。選べなければ null）/
// plan: プランの承認（ExitPlanMode）なら、プランの本文 / agent: サブエージェントの中の呼び出しなら、その ID
// always: 「今後は聞かない」で足す許可の説明（何を許すかと保存先。画面の言葉。Claude Code の候補が無ければ null）/
// plan: プランの承認なら本文（読めなければ空の文字列）。プランの承認でなければ null /
// humanOnly: 人だけが答えられる確認なら、その理由（親の Claude に向けた英語。プランの承認・Claude Code や人の設定が人に回したもの）
export type PendingPermission = {
  id: string;
  tool: string;
  title: string | null;
  description: string | null;
  input: Record<string, unknown>;
  reason: string | null;
  always: string[] | null;
  plan: string | null;
  agent: string | null;
  humanOnly?: string | null;
};

// 許可の確認への答え。allow: 許す（always: 今後は聞かない。Claude Code が出した候補の許可を足す）/
// accept-edits: プランを承認して、編集を自動で進める（acceptEdits にする）/ deny: 断る（message を Claude に伝えて、作業は続く）/
// stop: 断って、作業を止める（画面の Esc と同じ）
// （deny の byParent: 親の Claude が断った。message をそのまま Claude に伝える。人の発言の形にしない）
export type PermissionReply = { kind: 'allow'; always?: boolean } | { kind: 'accept-edits' } | { kind: 'deny'; message: string; byParent?: true } | { kind: 'stop' };

// 1 つの質問の答えの文。画面で答えたときと同じ形にする: 複数選択は、選んだ選択肢を選択肢の順に「, 」でつなぎ、自由記述は最後に足す。
// picked: 選んだ選択肢の名前 / other: 自由記述（前後の空白を除く。改行はそのまま）。どちらも無ければ空
export function answerText(question: AskQuestion, picked: string[], other: string): string {
  const labels = question.options.map((o) => o.label).filter((label) => picked.includes(label));
  const typed = other.trim();
  return [...labels, ...(typed ? [typed] : [])].join(', ');
}

// 形を確かめた返事（画面やフックとのやりとりで受け取ったもの）。形が違えば null
export function questionReplyOf(value: unknown): QuestionReply | null {
  const raw = value as { kind?: unknown; answers?: unknown; annotations?: unknown } | null;
  if (raw?.kind === 'cancel') return { kind: raw.kind };
  if (raw?.kind !== 'answer' || !isRecord(raw.answers)) return null;
  const answers = Object.entries(raw.answers).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  const annotations: QuestionAnnotations = {};
  for (const [question, note] of Object.entries(isRecord(raw.annotations) ? raw.annotations : {})) {
    if (isRecord(note) && typeof note.preview === 'string') annotations[question] = { preview: note.preview };
  }
  return { kind: 'answer', answers: Object.fromEntries(answers), ...(Object.keys(annotations).length > 0 ? { annotations } : {}) };
}

// 形を確かめた許可の確認への答え（画面から受け取ったもの）。形が違えば null
export function permissionReplyOf(value: unknown): PermissionReply | null {
  const raw = value as { kind?: unknown; always?: unknown; message?: unknown } | null;
  if (raw?.kind === 'allow') return raw.always === true ? { kind: 'allow', always: true } : { kind: 'allow' };
  if (raw?.kind === 'accept-edits' || raw?.kind === 'stop') return { kind: raw.kind };
  if (raw?.kind === 'deny' && typeof raw.message === 'string' && raw.message.trim()) return { kind: 'deny', message: raw.message };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
