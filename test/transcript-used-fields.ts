import type { Inventory } from './transcript-inventory';

// tanacode が読む、会話ログのフィールド（行の種類 → フィールド。名前の付け方は test/transcript-inventory.ts の目録と同じ）。
// 動作確認済のバージョンの目録に、どれもあるかを recorded.test.ts が確かめる。毎日の確認は、確かめたバージョンを動作確認済にした
// つもりで流すので、Claude Code の更新でここのフィールドが消えたら落ちる（Issue が立ち、バージョンは上がらない）。
// アプリで新しく読むフィールドを足したら、ここにも足す。
//
// 台本（test/cli）で出せない種類は、目録に無いので入れられない（読んでいても、ここでは確かめられない）:
// - bridge-session の bridgeSessionId・system/bridge_status の url（Remote Control。claude.ai へのログインが要る）・pr-link（PR へのリンク）
// - system/model_fallback・model_refusal_fallback の originalModel・fallbackModel・retractedMessageUuids（user・assistant の
//   retractedMessageUuids も。形の壊れたツールの呼び出しを取り直すときに書かれる。2.1.314 の目録の user には出たが、どの台本で決まって出るかは確かめていない）、system/memory_saved の
//   writtenPaths、system/informational の content、attachment/relevant_memories の memories・instructions の files・
//   compact_file_reference の filename
// - toolUseResult/TaskCreate の task.id（API キーでは ToDo のツールが出ない）・SendMessage の resumedAgentId・前で動かした Agent の
//   totalToolUseCount・totalDurationMs・totalTokens、user.content/image（画像の添付）、user の interruptedMessageId・sourceToolUseID
// - attachment/queued_command の origin・usage（作業中に届いた人の発言・完了通知。台本の並びによる）
// - permission-mode の行の permissionMode（台本では、ターミナルモードの TUI が止められるときにだけ書き、書き終える前に止まると無い。
//   出るかが実行ごとに揺れるので、目録の比べ方でも揺れる種類にしている（scripts/inventory-diff.mjs の UNSTABLE_KINDS）。
//   権限モードは user の行の permissionMode でも読む）
export const USED_FIELDS: Record<string, string[]> = {
  // 会話の行。巻き戻しの見分け（uuid・parentUuid）・今の claude の行か（timestamp）・サブエージェントの行か（isSidechain）・
  // チャットの組み立て（chat.ts）・作業の書き出しのブランチ（gitBranch）・会話の一覧のフォルダ（cwd）・未知のイベントのバージョン（version）
  'user': [
    'type',
    'uuid',
    'parentUuid',
    'timestamp',
    'isSidechain',
    'isMeta',
    'origin',
    'isCompactSummary',
    'isVisibleInTranscriptOnly',
    'permissionMode',
    'toolUseResult',
    'message',
    'message.content',
    'cwd',
    'gitBranch',
    'version',
  ],
  // 応答。書いている途中の文との突き合わせ（message.id・apiBlockIndex）・モデル名・コンテキストの使用量（message.usage）・
  // 利用枠で止まった印（isApiErrorMessage・apiError・apiErrorParams・quotaLimits。usage-limit.ts）
  'assistant': [
    'type',
    'uuid',
    'parentUuid',
    'timestamp',
    'isSidechain',
    'isApiErrorMessage',
    'apiError',
    'apiErrorParams',
    'quotaLimits',
    'apiBlockIndex',
    'message',
    'message.id',
    'message.model',
    'message.content',
    'message.usage',
    'gitBranch',
    'version',
  ],
  'system/compact_boundary': ['subtype', 'uuid', 'compactMetadata'],
  'system/stop_hook_summary': ['subtype', 'uuid', 'hookInfos', 'hookErrors', 'preventedContinuation', 'stopReason', 'toolUseID'],
  'system/api_error': ['subtype', 'uuid', 'error', 'retryAttempt', 'maxRetries'],
  'system/local_command': ['subtype', 'content'],
  // 作業中に送った発言（source_uuid で、送った発言と突き合わせる）
  'attachment/queued_command': ['attachment.type', 'attachment.commandMode', 'attachment.prompt', 'attachment.source_uuid'],
  // hooks の記録（chat.ts の hookRunOf）
  'attachment/hook_success': [
    'attachment.type',
    'attachment.hookEvent',
    'attachment.hookName',
    'attachment.command',
    'attachment.stdout',
    'attachment.stderr',
    'attachment.exitCode',
    'attachment.durationMs',
    'attachment.toolUseID',
    'attachment.content',
  ],
  'attachment/hook_blocking_error': ['attachment.hookEvent', 'attachment.hookName', 'attachment.blockingError', 'attachment.toolUseID'],
  'attachment/hook_additional_context': ['attachment.hookEvent', 'attachment.content'],
  // プランのファイル（session-manager.ts）・読んだファイル（knowledge-tracker.ts・context-tracker.ts）
  'attachment/plan_mode': ['attachment.planFilePath'],
  'attachment/file': ['attachment.filename'],
  'attachment/nested_memory': ['attachment.path'],
  // ほかで使う付帯の行
  'custom-title': ['customTitle'],
  'ai-title': ['aiTitle'],
  'queue-operation': ['operation', 'content'],
  // content のブロック
  'user.content/text': ['type', 'text'],
  'user.content/tool_result': ['type', 'tool_use_id', 'content', 'is_error'],
  'assistant.content/text': ['type', 'text'],
  'assistant.content/thinking': ['type', 'thinking'],
  'assistant.content/tool_use': ['type', 'id', 'name', 'input'],
  // ツールの結果。差分（chat.ts の editSummary・patchLines）・質問の答え（answersOf）・裏で起動した印（isAsyncLaunch）・
  // サブエージェントとワークフローの追跡（subagent-tracker.ts・workflow-tracker.ts）・裏の Bash（bash-task-tracker.ts）
  'toolUseResult/Edit': ['filePath', 'structuredPatch'],
  'toolUseResult/Write': ['type', 'content', 'filePath', 'structuredPatch'],
  'toolUseResult/AskUserQuestion': ['questions', 'answers'],
  'toolUseResult/Agent': ['status', 'agentId', 'resolvedModel'],
  'toolUseResult/Workflow': ['taskType', 'runId', 'transcriptDir', 'taskId', 'workflowName', 'summary', 'scriptPath', 'status'],
  'toolUseResult/Bash': ['backgroundTaskId'],
};

// 目録に無い、tanacode が読むフィールド（「種類: フィールド」。種類ごと無ければ「種類: （種類が無い）」）
export function missingUsedFields(inventory: Inventory): string[] {
  return Object.entries(USED_FIELDS).flatMap(([kind, names]) => {
    const found = inventory.transcript[kind];
    if (!found) return [`${kind}: （種類が無い）`];
    return names.filter((name) => !found.includes(name)).map((name) => `${kind}: ${name}`);
  });
}
