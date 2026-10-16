import type { PendingPermission, PermissionReply, QuestionReply } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';
import type { CanUseToolRequest, PermissionResult, PermissionUpdate } from './stream/protocol';

// Claude Code が答えを待つ要求（stream-json の can_use_tool）を、カードと親の道具で扱う形にし、答えを Claude Code への返事
// （PermissionResult）にする（設計書 8 節「カード」）。返事の文は、TUI で同じ答えを選んだときに Claude Code が Claude に返す文と同じ

// 断ったときに Claude Code が Claude に返す文（2.1.296 の会話ログの tool_result と同じ）
export const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

// 理由を添えて断ったとき（「No, and tell Claude what to do differently」と同じ）
export function rejectedWith(message: string): string {
  return `${REJECTED} To tell you how to proceed, the user said:\n${message}`;
}

// 質問で「Chat about this」を選んだときの文（2.1.296 の会話ログの tool_result と同じ）
export function chatMessage(questions: string[]): string {
  return [
    `${REJECTED} To tell you how to proceed, the user said:`,
    'The user wants to clarify these questions.',
    '    This means they may have additional information, context or questions for you.',
    '    Take their response into account and then reformulate the questions if appropriate.',
    '    Start by asking them what they would like to clarify.',
    '',
    '    Questions asked:',
    ...questions.map((q) => `- "${q}"\n  (No answer provided)`),
  ].join('\n');
}

// プランの承認のツール
export const PLAN_TOOL = 'ExitPlanMode';

// 質問への返事を、Claude Code への返事にする（答えは入力の answers・annotations に入れて許す。実測）
export function questionResult(input: Record<string, unknown>, questions: AskQuestion[], reply: QuestionReply): PermissionResult {
  if (reply.kind === 'answer') {
    return { behavior: 'allow', updatedInput: { ...input, answers: reply.answers, ...(reply.annotations ? { annotations: reply.annotations } : {}) } };
  }
  if (reply.kind === 'cancel') return { behavior: 'deny', message: REJECTED, interrupt: true };
  return { behavior: 'deny', message: chatMessage(questions.map((q) => q.question)) };
}

// 質問でない要求を、カードと親の道具で扱う形にする。plan: プランの承認なら、プランの本文（Claude Code は要求の入力に本文を入れず、
// プランのファイルから読む。session-manager がファイルか Claude の呼び出しの入力から取る。取れなければ空）
export function permissionOf(requestId: string, request: CanUseToolRequest, plan: string | null = null): PendingPermission {
  const planText = request.tool_name === PLAN_TOOL ? (plan ?? (typeof request.input.plan === 'string' ? request.input.plan : '')) : null;
  const suggestions = request.suppress_always_allow_rule ? [] : (request.permission_suggestions ?? []);
  const always = suggestions.flatMap(ruleNames);
  return {
    id: requestId,
    tool: request.tool_name,
    title: request.title ?? request.display_name ?? null,
    description: request.description ?? null,
    input: request.input,
    reason: request.decision_reason ?? null,
    always: always.length > 0 ? always : null,
    plan: planText,
    agent: request.agent_id ?? null,
  };
}

// 許可の確認への答えを、Claude Code への返事にする。accept-edits はプランの承認だけ（ほかの要求では、許すだけ）
export function permissionResult(request: CanUseToolRequest, reply: PermissionReply): PermissionResult {
  switch (reply.kind) {
    case 'allow':
      return reply.always && request.permission_suggestions?.length && !request.suppress_always_allow_rule
        ? { behavior: 'allow', updatedInput: request.input, updatedPermissions: request.permission_suggestions }
        : { behavior: 'allow', updatedInput: request.input };
    case 'accept-edits':
      return request.tool_name === PLAN_TOOL
        ? { behavior: 'allow', updatedInput: request.input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }
        : { behavior: 'allow', updatedInput: request.input };
    case 'deny':
      return { behavior: 'deny', message: rejectedWith(reply.message) };
    case 'stop':
      return { behavior: 'deny', message: REJECTED, interrupt: true };
  }
}

// 「今後は聞かない」で足す許可の短い名前（カードに出す）
function ruleNames(update: PermissionUpdate): string[] {
  if (update.type === 'addRules' || update.type === 'replaceRules') return update.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
  if (update.type === 'addDirectories') return update.directories;
  if (update.type === 'setMode') return [update.mode];
  return [];
}
