import type { AskQuestion } from './screen';

// Claude Code の AskUserQuestion のうち、アプリが PermissionRequest のフックで受け取って、答えを待っているもの（main の question-hook.ts）。
// 質問のカードは、この質問だけで描く（ターミナルの画面は読まない）。id: アプリが付ける、待っている質問ごとの番号。
// answered: 親が 1 問ずつ答えている途中の、答えた質問の答え（質問文 → 答え。カードは全部の答えを一度に返すので使わない）
export type PendingQuestion = { id: string; questions: AskQuestion[]; answered: Record<string, string> };

// 待っている質問への返事。
// answer: 質問文 → 答え / chat: 「Chat about this」（答えずに、質問について話す。画面で選んだときと同じ結果を返す）/
// cancel: キャンセル（画面の Esc と同じく、Claude の作業を止める）
export type QuestionReply = { kind: 'answer'; answers: Record<string, string> } | { kind: 'chat' } | { kind: 'cancel' };

// 1 つの質問の答えの文。画面で答えたときと同じ形にする: 複数選択は、選んだ選択肢を選択肢の順に「, 」でつなぎ、自由記述は最後に足す。
// picked: 選んだ選択肢の名前 / other: 自由記述（前後の空白を除く。改行はそのまま）。どちらも無ければ空
export function answerText(question: AskQuestion, picked: string[], other: string): string {
  const labels = question.options.map((o) => o.label).filter((label) => picked.includes(label));
  const typed = other.trim();
  return [...labels, ...(typed ? [typed] : [])].join(', ');
}

// 形を確かめた返事（画面やフックとのやりとりで受け取ったもの）。形が違えば null
export function questionReplyOf(value: unknown): QuestionReply | null {
  const raw = value as { kind?: unknown; answers?: unknown } | null;
  if (raw?.kind === 'chat' || raw?.kind === 'cancel') return { kind: raw.kind };
  if (raw?.kind !== 'answer' || !raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)) return null;
  const answers = Object.entries(raw.answers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return { kind: 'answer', answers: Object.fromEntries(answers) };
}
