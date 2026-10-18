import { elicitationFieldsOf, openableUrl, type ElicitationField, type ElicitationReply, type PendingElicitation } from '@shared/elicitation';
import { t } from '@shared/i18n';
import { stripControlChars } from '@shared/paste';
import type { PendingPermission, PermissionReply, QuestionReply } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';
import { tanacodeToolLabel } from '@shared/tool-label';
import type { CanUseToolRequest, ElicitationRequest, ElicitationResult, PermissionResult, PermissionUpdate } from './stream/protocol';

// Claude Code が答えを待つ要求（stream-json の can_use_tool と elicitation）を、カードと親の道具で扱う形にし、答えを Claude Code への返事
// （PermissionResult・ElicitationResult）にする（設計書 8 節「カード」）。返事の文は、TUI で同じ答えを選んだときに Claude Code が Claude に返す文と同じ

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
// ANSI の制御の並び（色などの CSI・題名などの OSC・2 文字の並び）
const ANSI_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

// 画面に出す文。ANSI の並びを消してから、残った制御文字を消す
export function displayText(text: string): string {
  return stripControlChars(text.replace(ANSI_SEQUENCES, ''));
}

// 説明・理由は Claude Code と Claude が書いたもので、ANSI の制御文字が入ることがある（SDK の型の説明）ので、消して出す
export function permissionOf(requestId: string, request: CanUseToolRequest, plan: string | null = null): PendingPermission {
  const planText = request.tool_name === PLAN_TOOL ? (plan ?? (typeof request.input.plan === 'string' ? request.input.plan : '')) : null;
  const suggestions = request.suppress_always_allow_rule ? [] : (request.permission_suggestions ?? []);
  const always = suggestions.flatMap(alwaysOf);
  const clean = (text: string | undefined) => (text ? displayText(text) : null);
  return {
    id: requestId,
    tool: request.tool_name,
    // tanacode 自身の MCP のツールは、チャットのツールの行と同じ名前にする（Claude Code の見出しは、ツールの名前を英語にしただけ）
    title: tanacodeToolLabel(request.tool_name) ?? clean(request.title ?? request.display_name),
    description: clean(request.description),
    input: request.input,
    reason: clean(request.decision_reason),
    always: always.length > 0 ? always : null,
    plan: planText,
    agent: request.agent_id ?? null,
    humanOnly: humanOnlyReason(request),
  };
}

// 人だけが答えられる確認なら、その理由（親の Claude に向けた英語）。親の answer_permission では断ることだけできる。
// プランの承認（承認すると子がプランモードから抜ける。入力は空で、親は本文も読めない）と、Claude Code が人に回したもの
// （requires_user_interaction・人の承認が要る安全の確かめ・間違って許されないようにする確認）と、人の設定の ask の規則が出させたもの
// （SDK の型の説明: 自動の承認で答えず、人に出す）。ふつうの確認には、どの印も付かない（実測）
export function humanOnlyReason(request: CanUseToolRequest): string | null {
  if (request.tool_name === PLAN_TOOL) return 'it is a plan approval: only the user approves a plan (approving it also takes the child out of plan mode).';
  if (request.requires_user_interaction) return 'Claude Code requires the user to answer this prompt themselves.';
  if (request.classifier_approvable === false || request.decision_reason_type === 'safetyCheck') return "Claude Code flagged it as a safety check that needs the user's own approval.";
  if (request.matched_ask_rule || request.decision_reason_type === 'rule') return "the user's settings (a permissions.ask rule) say the user must be asked.";
  if (request.default_to_no) return 'Claude Code marked it as a prompt the user must look at before it is allowed.';
  return null;
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
      return { behavior: 'deny', message: reply.byParent ? `${REJECTED} ${reply.message}` : rejectedWith(reply.message) };
    case 'stop':
      return { behavior: 'deny', message: REJECTED, interrupt: true };
  }
}

// 「今後は聞かない」で足す許可の説明（カードに出す）。何を許すか（規則・フォルダ・権限モード）と、どこに残るか（保存先）。
// TUI の「Yes, and don't ask again for … in <フォルダ>」「… in any project (user settings)」「Yes, allow all edits during this session」に寄せる
function alwaysOf(update: PermissionUpdate): string[] {
  const where = destinationText(update.destination);
  const item = (what: string) => t('main.permission.alwaysItem', { what, where });
  if (update.type === 'addRules' || update.type === 'replaceRules') {
    if (update.behavior !== 'allow') return [];
    return update.rules.map((r) => item(t('main.permission.alwaysRule', { rule: r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName })));
  }
  if (update.type === 'addDirectories') return update.directories.map((dir) => item(t('main.permission.alwaysDirectory', { dir })));
  if (update.type === 'setMode') return [item(update.mode === 'acceptEdits' ? t('main.permission.alwaysAcceptEdits') : t('main.permission.alwaysMode', { mode: update.mode }))];
  return [];
}

// 保存先（Claude Code の名前）を、どこに残るかの言葉に
function destinationText(destination: string): string {
  switch (destination) {
    case 'localSettings':
      return t('main.permission.whereLocal');
    case 'projectSettings':
      return t('main.permission.whereProject');
    case 'userSettings':
      return t('main.permission.whereUser');
    case 'session':
    case 'cliArg':
      return t('main.permission.whereSession');
    default:
      return destination;
  }
}

// AskUserQuestion の input から質問を取り出す。形が違えば null
export function askQuestionsOf(input: unknown): AskQuestion[] | null {
  const list = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const questions = list.map((q) => ({
    question: text(q?.question),
    header: text(q?.header),
    multiSelect: q?.multiSelect === true || q?.multiSelect === 'true',
    options: Array.isArray(q?.options)
      ? q.options.map((o: unknown) => {
          const opt = o as { label?: unknown; description?: unknown; preview?: unknown };
          return { label: text(opt?.label), description: text(opt?.description), preview: text(opt?.preview) || undefined };
        })
      : [],
  }));
  return questions.every((q) => q.question && q.options.length > 0) ? questions : null;
}

// MCP サーバーの質問（elicitation）を、カードと親の道具で扱う形にする。文・項目の名前・選択肢は MCP サーバーが書いたもので、
// ANSI の制御文字が入りうるので消して出す。開くページは、読み直した形（ホストは punycode）で出し、そのまま開く
export function elicitationOf(requestId: string, request: ElicitationRequest): PendingElicitation {
  const mode = request.mode === 'url' ? 'url' : 'form';
  const { fields, unsupported } = mode === 'form' ? elicitationFieldsOf(request.requested_schema, request.property_order) : { fields: [], unsupported: [] };
  const clean = (text: string | undefined) => (text?.trim() ? displayText(text) : null);
  const raw = mode === 'url' ? (request.url ?? '') : null;
  const openable = raw !== null && openableUrl(raw);
  return {
    id: requestId,
    server: displayText(request.mcp_server_name),
    message: displayText(request.message),
    title: clean(request.title),
    description: clean(request.description),
    mode,
    url: raw === null ? null : openable ? new URL(raw).href : displayText(raw),
    openable,
    fields: fields.map(cleanField),
    unsupported: unsupported.map(displayText),
    opened: false,
  };
}

// 項目の名前・説明・選択肢の名前の制御文字を消す（返す値の名前と、選択肢の値はそのまま）
function cleanField(field: ElicitationField): ElicitationField {
  const base = { ...field, title: displayText(field.title), description: field.description === null ? null : displayText(field.description) };
  return base.type === 'select' || base.type === 'multi' ? { ...base, options: base.options.map((o) => ({ ...o, label: displayText(o.label) })) } : base;
}

// MCP サーバーの質問への答えを、Claude Code への返事にする（URL の形の「開く」は、同意として accept）。完了待ちのカードの答えは返事にしない
export function elicitationResult(reply: ElicitationReply): ElicitationResult | null {
  switch (reply.kind) {
    case 'accept':
      return { action: 'accept', content: reply.content };
    case 'open':
      return { action: 'accept' };
    case 'decline':
    case 'cancel':
      return { action: reply.kind };
    default:
      return null;
  }
}
