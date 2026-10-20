import { lineChatEvents, type TranscriptEntry } from '@shared/chat';
import { PARENT_MESSAGE_TAG } from '@shared/session-tools';
import { classifyLine } from '@shared/transcript-line';
import { BashTaskTracker } from '../src/main/bash-task-tracker';
import { ContextTracker } from '../src/main/context-tracker';
import { SubagentTracker } from '../src/main/subagent-tracker';
import { TaskRouter, taskNotificationOf } from '../src/main/task-router';
import { WorkflowTracker } from '../src/main/workflow-tracker';

// 本物の会話ログ（開発者の手元の ~/.claude*/projects。npm run check:transcripts）を、アプリの読み取りに流して、決まりを確かめる。
// モックの API（test/cli）では出ない、本物のモデルの出し方（並べた呼び出し・タイミング）で崩れないかを見る。
// 1 つの会話ログのファイルの行を、アプリと同じ分け方（@shared/transcript-line）で、チャットの組み立て・裏のタスクの追跡
// （TaskRouter と各トラッカー）・コンテキストの中身に流す。決まり:
// - チャットに未知のイベントが出ない（知らない行・system の行・attachment・content のブロック）
// - 会話の行でない行に、ツールの呼び出し・結果（tool_use・tool_result）が無い。あれば知らせる（API の要求の控えのように、
//   意図して捨てる行なら読み手に渡らないので困らないが、ほかの種類なら読み違えるおそれがある）
// - 1 つの呼び出しに、会話の行の結果は 1 つまで（同じ uuid の書き直しは 1 つと数える）
// - 裏で起動したもの（サブエージェント・Bash・ワークフロー）は、完了の知らせ（<task-notification>）までは実行中のまま
export type TranscriptCheck = {
  // 読んだ行の数
  lines: number;
  // チャットの未知のイベント（名前 → 数）と、最初に出た行の番号
  unknown: Map<string, { count: number; line: number }>;
  // 会話の行でない行の tool_use・tool_result（行の種類 → 数）と、それが意図して捨てる種類か
  toolBlocksOutside: Map<string, { count: number; line: number; ignored: boolean }>;
  // 結果が 2 つ以上ある呼び出し（行の番号）
  duplicateResults: { toolUseId: string; lines: number[] }[];
  // 完了の知らせより前に、実行中でなくなった裏のタスク
  earlyFinish: { toolUseId: string; kind: 'subagent' | 'bash' | 'workflow'; line: number; state: string }[];
  // 親セッションからの指示として読んだ発言の本文に、囲みのタグが文字で残った行（囲みの本文にはタグが入らない。neutralizeTags）。
  // Claude Code が順番待ちの発言をまとめた行（mergedSendUuids）を、1 つの発言として読むと出る
  parentTags: number[];
};

// line: ファイルの中の行の番号（1 から）。agentLog: サブエージェント・ワークフローのエージェントの会話ログ（行はどれもサイドチェーン）
export type NumberedEntry = { entry: TranscriptEntry; line: number };

export function checkTranscript(entries: NumberedEntry[], { cwd, agentLog }: { cwd: string; agentLog: boolean }): TranscriptCheck {
  const check: TranscriptCheck = { lines: entries.length, unknown: new Map(), toolBlocksOutside: new Map(), duplicateResults: [], earlyFinish: [], parentTags: [] };
  const results = new Map<string, number[]>();
  const seenUuids = new Set<string>();
  // 裏のタスクの追跡。ファイルは読ませない（出力ファイル・完了時の記録という後ろ盾を使わず、会話ログの行と完了の知らせだけで動かす）
  const subagents = new SubagentTracker(cwd, () => {});
  const bashTasks = new BashTaskTracker(() => {});
  const workflows = new WorkflowTracker(() => {});
  const router = new TaskRouter({ workflows, subagents, bashTasks, sessionDir: () => NO_DIR });
  const context = new ContextTracker(cwd);
  const notified = new Set<string>();
  const reported = new Set<string>();
  try {
    for (const { entry, line } of entries) {
      const classified = classifyLine(entry);
      for (const event of lineChatEvents(classified, cwd, agentLog)) {
        if (event.type === 'user' && event.parent && PARENT_TAG.test(event.text) && !check.parentTags.includes(line)) check.parentTags.push(line);
        if (event.type !== 'unknown-event') continue;
        const found = check.unknown.get(event.name);
        check.unknown.set(event.name, { count: (found?.count ?? 0) + 1, line: found?.line ?? line });
      }
      const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
      if (classified.kind !== 'conversation') {
        if (blocks.some((b) => b?.type === 'tool_use' || b?.type === 'tool_result')) {
          const kind = classified.kind === 'unknown' ? classified.name : String(entry.type);
          const found = check.toolBlocksOutside.get(kind);
          check.toolBlocksOutside.set(kind, { count: (found?.count ?? 0) + 1, line: found?.line ?? line, ignored: classified.kind === 'ignored' });
        }
      } else if (entry.type === 'user' && !(entry.uuid && seenUuids.has(entry.uuid))) {
        if (entry.uuid) seenUuids.add(entry.uuid);
        for (const block of blocks) {
          if (block?.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, [...(results.get(block.tool_use_id) ?? []), line]);
        }
      }
      if (classified.kind === 'conversation') context.handle(classified.entry);
      // 裏のタスクの追跡は、本体の会話ログだけ（アプリも、エージェントの会話ログは追跡に渡さない）
      if (agentLog || (classified.kind !== 'conversation' && classified.kind !== 'side')) continue;
      const notice = taskNotificationOf(classified.entry);
      if (notice?.toolUseId) notified.add(notice.toolUseId);
      router.track(withoutFiles(classified.entry), false);
      const running = (kind: TranscriptCheck['earlyFinish'][number]['kind'], toolUseId: string, state: string) => {
        if (state === 'running' || notified.has(toolUseId) || reported.has(toolUseId)) return;
        reported.add(toolUseId);
        check.earlyFinish.push({ toolUseId, kind, line, state });
      };
      for (const run of subagents.all()) if (run.background) running('subagent', run.toolUseId, run.state);
      for (const task of bashTasks.all()) running('bash', task.toolUseId, task.state);
      for (const run of workflows.all()) running('workflow', run.toolUseId, run.status);
    }
  } finally {
    subagents.dispose();
    bashTasks.dispose();
    workflows.dispose();
  }
  check.duplicateResults = [...results].filter(([, lines]) => lines.length > 1).map(([toolUseId, lines]) => ({ toolUseId, lines }));
  return check;
}

// 無いフォルダ（トラッカーに、サブエージェントの会話ログ・ワークフローの記録を読ませない）
const NO_DIR = '/nonexistent/tanacode-transcript-check';
// 親セッションからの指示の囲みのタグ（@shared/session-tools の PARENT_MESSAGE_TAG）
const PARENT_TAG = new RegExp(`</?${PARENT_MESSAGE_TAG}`);

// ワークフローの完了時の記録・journal を読ませない（会話ログの行と、完了の知らせだけで動かす）
function withoutFiles<T extends TranscriptEntry>(entry: T): T {
  const result = entry.toolUseResult as Record<string, unknown> | undefined;
  if (!result || typeof result !== 'object' || typeof result.transcriptDir !== 'string') return entry;
  return { ...entry, toolUseResult: { ...result, transcriptDir: NO_DIR, scriptPath: null } };
}
