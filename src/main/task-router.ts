import type { TranscriptEntry } from '@shared/chat';
import type { KnownEntry } from '@shared/transcript-line';
import type { BashTaskTracker } from './bash-task-tracker';
import type { SubagentTracker } from './subagent-tracker';
import { workflowLaunchOf, type WorkflowTracker } from './workflow-tracker';

type Targets = {
  workflows: WorkflowTracker;
  subagents: SubagentTracker;
  bashTasks: BashTaskTracker;
  // 今の会話ログのセッションのフォルダ（subagents/・workflows/ がある。/clear で変わる）
  sessionDir: () => string;
};

// 会話ログの行を読み、バックグラウンドで動くもの（ワークフロー・サブエージェント・Bash）の起動・結果・完了通知を、
// それぞれを追う部品に渡す。
// アプリ（session-manager）と、Claude Code との互換性の確認（test/cli）で同じものを使う
export class TaskRouter {
  // Workflow ツールに直接渡されたスクリプト（tool_use ID ごと）。フェーズ名を読むのに使う
  private readonly workflowScripts = new Map<string, string>();
  // Agent ツールの tool_use ID（結果の行がどのツールのものか分かるように）
  private readonly agentToolIds = new Set<string>();
  // SendMessage の tool_use ID（結果が、前に起動したエージェントの再開かを見る）
  private readonly sendMessageIds = new Set<string>();
  // Bash と Monitor の呼び出し（tool_use ID ごと。結果の行が来たら捨てる）。裏で動くかは結果の行で知る:
  // Bash は run_in_background のほか、時間切れ（timeout）で Claude Code が裏に回すこともあり、どちらも結果に backgroundTaskId が付く
  // （時間切れのものは input に run_in_background が無い。2.1.302）。Monitor は、見張りを始めると結果に taskId が付く
  private readonly shellCalls = new Map<string, { tool: 'Bash' | 'Monitor'; input: Record<string, unknown> }>();

  constructor(private readonly targets: Targets) {}

  // entry: 知っている行（@shared/transcript-line の会話の行と、ほかで使う付帯の行）だけを受け取る。Claude Code は 2.1.301 から、
  // API に送った要求の控え（api-request-blob。意図して捨てる行）にも、前の tool_use と tool_result を toolUseResult なしでもう一度書く。
  // 控えから読むと、裏で起動したサブエージェントの結果を起動の知らせ（async_launched）でないものと読んで、すぐ完了にしてしまう。
  // isHistory: 前の起動の行（過去のもの）
  track(entry: KnownEntry, isHistory: boolean): void {
    const { workflows, subagents, bashTasks } = this.targets;
    // ツールの呼び出しと結果は、応答と発言の行から読む
    const conversation = entry.type === 'user' || entry.type === 'assistant';
    const content = conversation && Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'Workflow' && block.id && typeof block.input?.script === 'string') {
        this.workflowScripts.set(block.id, block.input.script);
      }
      if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task') && block.id) {
        this.agentToolIds.add(block.id);
        const description = block.input?.description;
        if (!isHistory) subagents.start(block.id, this.targets.sessionDir(), isTrue(block.input?.run_in_background), typeof description === 'string' ? description : null);
      }
      if (block.type === 'tool_use' && block.name === 'SendMessage' && block.id) this.sendMessageIds.add(block.id);
      if (block.type === 'tool_result' && block.tool_use_id && this.sendMessageIds.has(block.tool_use_id)) {
        const agentId = resumedAgentOf(entry.toolUseResult, block.content);
        if (agentId) subagents.resume(block.tool_use_id, agentId, this.targets.sessionDir(), isHistory);
      }
      if (block.type === 'tool_result' && block.tool_use_id && this.agentToolIds.has(block.tool_use_id)) {
        subagents.finish(block.tool_use_id, entry.toolUseResult, !!block.is_error, isHistory);
      }
      if (block.type === 'tool_use' && (block.name === 'Bash' || block.name === 'Monitor') && block.id && block.input) {
        this.shellCalls.set(block.id, { tool: block.name, input: block.input });
      }
      const call = block.type === 'tool_result' && block.tool_use_id ? this.shellCalls.get(block.tool_use_id) : undefined;
      if (call) {
        this.shellCalls.delete(block.tool_use_id!);
        if (call.tool === 'Bash') bashTasks.start(block.tool_use_id!, call.input, entry.toolUseResult, resultText(block.content), isHistory);
        else bashTasks.startMonitor(block.tool_use_id!, call.input, entry.toolUseResult, isHistory);
      }
    }
    const launch = workflowLaunchOf(entry, this.workflowScripts);
    if (launch) workflows.add(launch, isHistory);

    const notice = taskNotificationOf(entry);
    if (notice && notice.toolUseId !== null && notice.status !== null) {
      workflows.notified(notice.toolUseId, notice.status);
      subagents.notified(notice.toolUseId, notice.status, notice.result, notice.usage);
      bashTasks.notified(notice.toolUseId, notice.status, notice.exitCode, notice.outputFile);
    } else if (notice?.taskId && notice.event !== null && entry.type === 'queue-operation') {
      // Monitor の途中の知らせ（終わりでないもの）。同じ知らせが発言の行・queued_command にも書かれるので、どの知らせにもある
      // queue-operation の enqueue からだけ読む（何度も足さないように）
      bashTasks.event(notice.taskId, notice.event);
    }
  }
}

// run_in_background は真偽値のほか、文字列の "true" で来ることもある
function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

export type TaskUsage = { durationMs: number | null; totalTokens: number | null; toolUses: number | null };

// 完了通知の中身。toolUseId・status: どのタスクがどうなったか（無ければ null）。result: サブエージェントの結果の文。
// exitCode: Bash の要約に書かれた終了コード（「Background command "…" completed (exit code 0)」。無ければ null）。
// taskId: タスクの ID。outputFile: 出力ファイル。event: Monitor の知らせの中身（<event>。無ければ null）。
// Monitor は、見張りの出力が出るたびに、tool-use-id と status の無い知らせ（「Monitor event: "…"」）を出し、終わりに status の付いた知らせを出す
export type TaskNotification = {
  text: string;
  usage: TaskUsage | null;
  toolUseId: string | null;
  status: string | null;
  result: string | null;
  exitCode: number | null;
  taskId: string | null;
  outputFile: string | null;
  event: string | null;
};

// バックグラウンドのタスクの完了通知（<task-notification>）。書かれ方は 3 通りあり、同じ通知が複数の形で書かれることもある
// （受け取る側は何度受け取っても同じ結果になる）:
// - ユーザーの発言の行（Claude が待っているときに届いた）
// - attachment の queued_command（Claude の作業中に届いて、そのターンに差し込まれた。所要時間などが付く）
// - queue-operation の enqueue（届いた時点のキュー。どの通知にもある）
// サブエージェントの使用量（所要時間・トークン数・ツールの回数）は、本文の <usage> にも入っている。
// attachment の usage が無い形（発言の行・enqueue）では、本文から読む
export function taskNotificationOf(entry: TranscriptEntry): TaskNotification | null {
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
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  usage ??= usageOfText(text);
  const notified = text.match(/<tool-use-id>(.*?)<\/tool-use-id>[\s\S]*?<status>(.*?)<\/status>/);
  return {
    text,
    usage,
    toolUseId: notified?.[1] ?? null,
    status: notified?.[2] ?? null,
    result: text.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim() ?? null,
    exitCode: exitCodeOf(text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]),
    taskId: text.match(/<task-id>(.*?)<\/task-id>/)?.[1] ?? null,
    outputFile: text.match(/<output-file>(.*?)<\/output-file>/)?.[1] ?? null,
    event: text.match(/<event>([\s\S]*?)<\/event>/)?.[1] ?? null,
  };
}

function exitCodeOf(summary: string | undefined): number | null {
  const code = summary?.match(/\bexit code (-?\d+)/)?.[1];
  return code === undefined ? null : Number(code);
}

// 本文の <usage>（例: <usage><subagent_tokens>120</subagent_tokens><tool_uses>1</tool_uses><duration_ms>395</duration_ms></usage>）。
// <result> の後ろにある（結果の文の中の同じ文字は読まない）
function usageOfText(text: string): TaskUsage | null {
  const block = text.slice(text.lastIndexOf('</result>') + 1).match(/<usage>([\s\S]*?)<\/usage>/)?.[1];
  if (!block) return null;
  const tag = (...names: string[]) => {
    for (const name of names) {
      const value = block.match(new RegExp(`<${name}>(\\d+)</${name}>`))?.[1];
      if (value !== undefined) return Number(value);
    }
    return null;
  };
  return { durationMs: tag('duration_ms'), totalTokens: tag('subagent_tokens', 'total_tokens'), toolUses: tag('tool_uses') };
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
