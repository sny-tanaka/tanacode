import type { TranscriptEntry } from '@shared/chat';
import type { BashTaskTracker } from './bash-task-tracker';
import { askQuestionsOf } from './screen-parser';
import type { ScreenTracker } from './screen-tracker';
import type { SubagentTracker } from './subagent-tracker';
import { workflowLaunchOf, type WorkflowTracker } from './workflow-tracker';

type Targets = {
  workflows: WorkflowTracker;
  subagents: SubagentTracker;
  bashTasks: BashTaskTracker;
  // 今の画面（起動し直すと変わる）。無ければ null
  screen: () => ScreenTracker | null;
  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある。/clear で変わる）
  sessionDir: () => string;
};

// 会話ログの行を読み、バックグラウンドで動くもの（ワークフロー・サブエージェント・Bash）の起動・結果・完了通知と、
// AskUserQuestion の質問を、それぞれを追う部品に渡す。
// アプリ（session-manager）と、Claude Code との互換性の確認（test/cli）で同じものを使う
export class TaskRouter {
  // Workflow ツールに直接渡されたスクリプト（tool_use ID ごと）。フェーズ名を読むのに使う
  private readonly workflowScripts = new Map<string, string>();
  // Agent ツールの tool_use ID（結果の行がどのツールのものか分かるように）
  private readonly agentToolIds = new Set<string>();
  // SendMessage の tool_use ID（結果が、前に起動したエージェントの再開かを見る）
  private readonly sendMessageIds = new Set<string>();
  // 回答を待っている AskUserQuestion の tool_use ID
  private askToolId: string | null = null;
  // バックグラウンドで起動した Bash の入力（tool_use ID ごと）。結果の行で起動を知る
  private readonly bashInputs = new Map<string, Record<string, unknown>>();

  constructor(private readonly targets: Targets) {}

  // isHistory: 前の起動の行（過去のもの）。replaying: 読み直している行（引き継いだ claude が書いた、今も続いている行を含む）
  track(entry: TranscriptEntry, isHistory: boolean, replaying: boolean): void {
    const { workflows, subagents, bashTasks } = this.targets;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'Workflow' && block.id && typeof block.input?.script === 'string') {
        this.workflowScripts.set(block.id, block.input.script);
      }
      if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task') && block.id) {
        this.agentToolIds.add(block.id);
        if (!isHistory) subagents.start(block.id, this.targets.sessionDir(), isTrue(block.input?.run_in_background));
      }
      if (block.type === 'tool_use' && block.name === 'SendMessage' && block.id) this.sendMessageIds.add(block.id);
      if (block.type === 'tool_result' && block.tool_use_id && this.sendMessageIds.has(block.tool_use_id)) {
        const agentId = resumedAgentOf(entry.toolUseResult, block.content);
        if (agentId) subagents.resume(block.tool_use_id, agentId, this.targets.sessionDir(), isHistory);
      }
      if (block.type === 'tool_result' && block.tool_use_id && this.agentToolIds.has(block.tool_use_id)) {
        subagents.finish(block.tool_use_id, entry.toolUseResult, !!block.is_error, isHistory);
      }
      // 質問の選択メニューは、画面ではなく AskUserQuestion の input から組み立てる（画面が低いと選択肢の一部しか出ない）
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id && !isHistory) {
        this.askToolId = block.id;
        this.targets.screen()?.setQuestions(askQuestionsOf(block.input));
      }
      if (block.type === 'tool_result' && block.tool_use_id && block.tool_use_id === this.askToolId) {
        this.askToolId = null;
        // 読み直しで届いた答えは、今の画面の質問への答えではない
        this.targets.screen()?.setQuestions(null, !replaying);
      }
      if (block.type === 'tool_use' && block.name === 'Bash' && block.id && block.input && isTrue(block.input.run_in_background)) {
        this.bashInputs.set(block.id, block.input);
      }
      const bashInput = block.type === 'tool_result' && block.tool_use_id ? this.bashInputs.get(block.tool_use_id) : undefined;
      if (bashInput) bashTasks.start(block.tool_use_id!, bashInput, entry.toolUseResult, resultText(block.content), isHistory);
    }
    const launch = workflowLaunchOf(entry, this.workflowScripts);
    if (launch) workflows.add(launch, isHistory);

    const notice = taskNotificationOf(entry);
    const notified = notice?.text.match(/<tool-use-id>(.*?)<\/tool-use-id>[\s\S]*?<status>(.*?)<\/status>/);
    if (notice && notified) {
      workflows.notified(notified[1], notified[2]);
      const result = notice.text.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim() ?? null;
      subagents.notified(notified[1], notified[2], result, notice.usage);
      bashTasks.notified(notified[1], notified[2]);
    }
  }
}

// run_in_background は真偽値のほか、文字列の "true" で来ることもある
function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

export type TaskUsage = { durationMs: number | null; totalTokens: number | null; toolUses: number | null };

// バックグラウンドのタスクの完了通知（<task-notification>）。書かれ方は 3 通りあり、同じ通知が複数の形で書かれることもある
// （受け取る側は何度受け取っても同じ結果になる）:
// - ユーザーの発言の行（Claude が待っているときに届いた）
// - attachment の queued_command（Claude の作業中に届いて、そのターンに差し込まれた。所要時間などが付く）
// - queue-operation の enqueue（届いた時点のキュー。どの通知にもある）
export function taskNotificationOf(entry: TranscriptEntry): { text: string; usage: TaskUsage | null } | null {
  const e = entry as TranscriptEntry & { operation?: string; content?: unknown };
  let text: unknown = null;
  let usage: TaskUsage | null = null;
  if (entry.type === 'user') text = entry.message?.content;
  else if (entry.type === 'queue-operation' && e.operation === 'enqueue') text = e.content;
  else if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
    text = entry.attachment.prompt;
    const u = entry.attachment.usage as Record<string, unknown> | undefined;
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    if (u) usage = { durationMs: num(u.durationMs), totalTokens: num(u.totalTokens), toolUses: num(u.toolUses) };
  }
  return typeof text === 'string' && text.includes('<task-notification>') ? { text, usage } : null;
}

// SendMessage の結果から、再開したエージェントの ID を読む（{"success":true,"resumedAgentId":"…"}）
function resumedAgentOf(toolUseResult: unknown, content: unknown): string | null {
  const read = (value: unknown): string | null => {
    const id = (value as { resumedAgentId?: unknown } | null)?.resumedAgentId;
    return typeof id === 'string' && id ? id : null;
  };
  if (read(toolUseResult)) return read(toolUseResult);
  try {
    return read(JSON.parse(resultText(content)));
  } catch {
    return null;
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: { text?: unknown }) => (typeof b.text === 'string' ? b.text : '')).join('\n');
}
