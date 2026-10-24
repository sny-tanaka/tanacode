// 離席モード（英語の画面では Away mode）。人が席を外している間、親セッション（人が動かす、子でないセッション）の Claude に、
// 人に聞かずに決めて記録させ、人に回る許可の確認・質問は、決まった時間だけ待って、答えが無ければアプリが断る。
// 効くのは入れたセッションだけ（アプリ全体には効かせない）。子は人に聞かないので、子には効かせず、知らせもしない。
// Claude に渡す文は英語で書く（AGENTS.md）

// 答えを待つ時間（分）の選択肢と既定
export const AWAY_WAIT_MINUTES = [1, 3, 5, 10, 15, 30] as const;
export const DEFAULT_AWAY_WAIT_MINUTES = 5;

// 離席モードを入れた・解いたのは誰か。human: 画面のスイッチ / claude: Claude が set_away_mode で
export type AwayChangedBy = 'human' | 'claude';

// 離席中に、人の発言（UserPromptSubmit）と圧縮のあと（SessionStart）のフックで Claude に渡す文の囲み
export const AWAY_REMINDER_TAG = 'tanacode-away-mode';

// 待つ時間の言い方（Claude に渡す文）
export function waitText(waitMs: number): string {
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  if (seconds % 60 !== 0) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// 離席中の決まり。set_away_mode で入れたときの結果と、フックで渡す文の中身
export function awayRules(waitMs: number): string {
  return [
    'Away mode is on in this session: the user is away from the computer and is not answering. Until it is turned off:',
    '- Do not ask the user (AskUserQuestion) and do not wait for them. Decide yourself with the option you would recommend, and record each decision with its reason on the list of decisions for the user to review (e.g. 「確認事項」), so that they can approve or correct it later. Then keep working.',
    '- Do not do operations that cannot be undone or that reach outside the machine (deleting, force-pushing, merging, publishing, sending, paying, reading secrets), even if they are part of the work. Put them on the list of things only the user can do (e.g. 「人のやること」) with the exact command or action and why it is needed, and go on with other work.',
    "- The same goes for your child sessions: a permission prompt you cannot allow yourself (can_allow is false, or it needs the user's go-ahead) or a question from an MCP server goes on the list of things only the user can do, instead of telling the user and waiting.",
    `- A permission prompt or question of this session that still reaches the user is declined by tanacode when nobody answers it within ${waitText(waitMs)}. Do not retry it and do not look for a way around it.`,
    '- If the PushNotification tool is available, you may send one short notification when something important is on hold for the user (not one for every item), so that they can see it on their phone.',
    '- Turn away mode off with set_away_mode (away: false) when the user says they are back (for example "good morning" or "I\'m back"). A message from the user alone does not turn it off: they may be writing from their phone.',
  ].join('\n');
}

// 解いたときに Claude に頼むこと（set_away_mode で解いたときの結果と、画面のスイッチで解いたときの知らせ）
export const AWAY_ENDED =
  'Away mode is off: the user is back. Report to the user, in one message and in the language the user is using, what you put on hold for them while they were away (the list of things only the user can do) and the decisions you made yourself (the list for review), so that they can check them. If there was nothing, say so in one line.';

// 時間切れで断ったときの理由に、どちらも入る文。Claude Code が返したツールの結果にこれがあれば、断りが使われた
export const AWAY_DENIED_MARK = 'away mode is on (the user is away from the computer)';

// 離席中に、人に回った許可の確認を断るときの理由（Claude Code が Claude に返す）
export function awayPermissionDenied(waitMs: number): string {
  return `tanacode declined this permission prompt: ${AWAY_DENIED_MARK}, and nobody answered it within ${waitText(waitMs)}. Nothing was run. Do not retry it now and do not look for a way around it. Put it on the list of things only the user can do (e.g. 「人のやること」) with the exact command or edit and why it is needed, then continue with other work that does not need it.`;
}

// 離席中に、人に回った質問（AskUserQuestion）を返すときの理由
export function awayQuestionDeclined(waitMs: number): string {
  return `The user did not answer: ${AWAY_DENIED_MARK}, and nobody answered this question within ${waitText(waitMs)}. Do not ask it again. Decide yourself: take the option you recommend, record the decision and the reason on the list of decisions for the user to review (e.g. 「確認事項」), and continue. If the choice would lead to something that cannot be undone or that reaches outside the machine, do not do it: put it on the list of things only the user can do (e.g. 「人のやること」) instead.`;
}

// 離席中にフックで渡す文
export function awayReminder(waitMs: number): string {
  return `<${AWAY_REMINDER_TAG}>\n${awayRules(waitMs)}\n</${AWAY_REMINDER_TAG}>`;
}
