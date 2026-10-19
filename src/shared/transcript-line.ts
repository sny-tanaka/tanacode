import type { TranscriptEntry } from './chat';

// 会話ログの行の種類の分け方。行は、どれも次の 4 つのどれか 1 つになる（docs/claude-code-events.md の ✅・⏭・⚠️ と同じ分け方。
// stream-json は main の stream/client.ts）。会話ログを読むところ（main の session-manager.ts の handleEntry・chat-log.ts など）は、
// ここで 1 回だけ分けて、読み手には要る種類だけを渡す（読み手ごとに種類を見分けると、見落としたところに知らない行が届く。
// 2.1.301 の API の要求の控えが、裏のタスクの追跡に届いたように）
// - conversation（会話の行）: 発言・応答・system・attachment。uuid と parentUuid でつながる、会話そのもの
// - side（ほかで使う付帯の行）: 会話の外の行のうち、tanacode が使うもの
// - ignored（意図して捨てる行）: Claude Code が自分で使う付帯情報（理由つき）。どの読み手にも渡さない
// - unknown（知らない行）: どこにも書いていない種類と、種類の欄の無い行。どの読み手にも渡さず、未知のイベントとして知らせる
// 会話の行の中の種類（system の subtype・attachment の type・応答のブロックの type）も、意図して捨てるものはここに書く。
// 使うものは、読み手（chat.ts の toChatEvents）の分岐。どちらにも無いものは、チャットに未知のイベントとして出る。
// 出どころ: test/fixtures/claude-code/ の会話ログ、開発者の手元の会話ログ、Claude Code 2.1.302 の本体（会話ログを読む処理と attachment の一覧）

// 会話の行
const CONVERSATION_TYPES = ['user', 'assistant', 'system', 'attachment'] as const;

// ほかで使う付帯の行: 一覧の名前（custom-title・ai-title。chat.ts の transcriptTitle）・作業中に届いた知らせの振り分け
// （queue-operation。main の task-router.ts）・ターミナルモードの権限モード（permission-mode。main の session-manager.ts の
// permissionModeOf）・Remote Control のつながりと PR へのリンク（bridge-session・pr-link。チャットに出す）
const SIDE_TYPES = ['custom-title', 'ai-title', 'queue-operation', 'permission-mode', 'bridge-session', 'pr-link'] as const;

export type ConversationEntry = TranscriptEntry & { type: (typeof CONVERSATION_TYPES)[number] };
export type SideEntry = TranscriptEntry & { type: (typeof SIDE_TYPES)[number] };
// 知っている行のうち、読み手に渡すもの
export type KnownEntry = ConversationEntry | SideEntry;

// 分けた行。unknown の name: 種類の名前（種類の欄が無ければ空）/ problem: unknown（知らない種類）・malformed（種類の欄が無い）
export type TranscriptLine =
  | { kind: 'conversation'; entry: ConversationEntry }
  | { kind: 'side'; entry: SideEntry }
  | { kind: 'ignored'; entry: TranscriptEntry }
  | { kind: 'unknown'; entry: TranscriptEntry; name: string; problem: 'unknown' | 'malformed' };

export function classifyLine(entry: TranscriptEntry): TranscriptLine {
  const type = entry.type;
  if (typeof type !== 'string') return { kind: 'unknown', entry, name: '', problem: 'malformed' };
  if (CONVERSATION.has(type)) return { kind: 'conversation', entry: entry as ConversationEntry };
  if (SIDE.has(type)) return { kind: 'side', entry: entry as SideEntry };
  if (IGNORED_TYPES.has(type)) return { kind: 'ignored', entry };
  return { kind: 'unknown', entry, name: type, problem: 'unknown' };
}

// 会話の行なら、その行。ほかは null（会話の行だけを読む読み手に渡すとき）
export function conversationOf(entry: TranscriptEntry): ConversationEntry | null {
  const line = classifyLine(entry);
  return line.kind === 'conversation' ? line.entry : null;
}

// 知っている行（会話の行と、ほかで使う付帯の行）なら、その行。ほかは null
export function knownOf(entry: TranscriptEntry): KnownEntry | null {
  const line = classifyLine(entry);
  return line.kind === 'conversation' || line.kind === 'side' ? line.entry : null;
}

// 意図して捨てる system の行・attachment・応答のブロックか
export function isIgnoredSystem(subtype: string): boolean {
  return IGNORED_SYSTEM.has(subtype);
}

export function isIgnoredAttachment(type: string): boolean {
  return IGNORED_ATTACHMENTS.has(type);
}

export function isIgnoredAssistantBlock(type: string): boolean {
  return IGNORED_ASSISTANT_BLOCKS.has(type);
}

const CONVERSATION = new Set<string>(CONVERSATION_TYPES);
const SIDE = new Set<string>(SIDE_TYPES);

// 意図して捨てる行の種類。どれも Claude Code が自分で使う付帯情報で、会話の中身ではない
const IGNORED_TYPES = new Set([
  // セッションを開き直すときの状態（モード・名前・色・タグ・費用・worktree・メモリのモード・場所の移動・続きの先・モデルが終えた印・
  // 最後の発言・前のバージョンが書いた会話の要約など）
  'summary',
  'mode',
  'atis-latch',
  'isolation-latch',
  'last-prompt',
  'worktree-state',
  'agent-name',
  'agent-color',
  'agent-setting',
  'tag',
  'cost-state',
  'dev-mods',
  'memory-mode',
  'history-suppression',
  'relocated',
  'ended-by-model',
  'continued-in',
  // 巻き戻し・枝分かれのためのファイルと文脈の控え
  'file-history-snapshot',
  'file-history-delta',
  'attribution-snapshot',
  'content-replacement',
  'fork-context-ref',
  // API の呼び出しの控え（2.1.301 から。前の応答と発言が、tool_use・tool_result も含めて、toolUseResult なしでもう一度入る。
  // 会話の行と読み違えると、裏のタスクの追跡などが壊れる）
  'api-request',
  'api-request-blob',
  'api-request-shape',
  // Claude アプリの成果物（コメントの見張り・自動の反応）とフレームへのリンク
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'frame-link',
]);

// 意図して捨てる system の行（docs/claude-code-events.md の 5 節）
const IGNORED_SYSTEM = new Set([
  // クラウド・Remote Control・別の機能向け（離れていた間のまとめ・許可のやり直し・予約の実行・巻き戻しの代わりの行・クラウドの状態・
  // ファイルの控え）
  'away_summary',
  'permission_retry',
  'scheduled_task_fire',
  'rewind_stand_in',
  'cloud_session_status',
  'file_snapshot',
  // 断られて取り直さなかった知らせは中身が空（断られた応答そのものは、応答の行に出る）
  'model_refusal_no_fallback',
  // 人がモデルを選んで切り替えた知らせ。tanacode の起動のしかたでは選ばせないので出ない
  'model_consent_fallback',
  // 使い道がない（裏のエージェントを止めた記録。止めたことは、裏のタスクの終わりで分かる）
  'agents_killed',
]);

// 意図して捨てる attachment。どれも Claude Code が Claude に渡す文脈で、チャットには出さない
// （コンテキストの中身（main の context-tracker.ts）や、読んだファイル（main の knowledge-tracker.ts）では使うものもある）
const IGNORED_ATTACHMENTS = new Set([
  // 環境・日付・セッションの情報・指示・出力の形・システムプロンプトの控え
  'environment',
  'model',
  'date',
  'date_change',
  'session_context',
  'credential_org',
  'instructions',
  'language',
  'output_style',
  'output_style_instructions',
  'coordinator_context',
  'context_sections',
  'prompt_snapshot',
  'prompt_render_point',
  'remote_session_change',
  // トークン・時間・予算などを思い出させる文と、注意書き
  'total_tokens_reminder',
  'token_usage',
  'output_token_usage',
  'budget_usd',
  'silent_turn_reminder',
  'elapsed_time_reminder',
  'output_limit_note',
  'critical_system_reminder',
  'todo_reminder',
  'task_reminder',
  'task_status',
  'tool_search_usage_reminder',
  'batching_reminder',
  'batching_reminder_sent',
  'secondary_reminder',
  'secondary_reminder_sent',
  'bash_output_audience_note',
  'read_truncation_notice',
  'context_efficiency',
  'attention_budget',
  'thread_state',
  'prefix_delta',
  // ツール・エージェント・MCP・スキル・コマンドの一覧と、その差分
  'deferred_tools_delta',
  'deferred_tools_record',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'mcp_dropped_tools_delta',
  'skill_listing',
  'invoked_skills',
  'dynamic_skill',
  'command_permissions',
  // モードと機能の切り替え（auto・プラン・ワークフロー・エフォート・思考など）
  'auto_mode',
  'auto_mode_exit',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'plan_file_reference',
  'proactivity',
  'sandbox_instructions',
  'team_context',
  'tool_hosts_notice',
  'tool_hosts_correction',
  'tool_host_result_lines',
  'workflow_keyword_request',
  'workflow_size_guideline_change',
  'ultra_effort_enter',
  'ultra_effort_exit',
  'ultrathink_effort',
  'thinking_stripped',
  'thinking_drop',
  'advisor_stripped',
  'advisor_tool',
  'artifact_opening_prefetch',
  // @ で指したもの・読んだファイル・IDE の選択・診断（ファイルの中身は、ツールの結果としてチャットに出る）
  'agent_mention',
  'at_mention_reference',
  'peer_mention',
  'skill_mention',
  'file',
  'directory',
  'already_read_file',
  'edited_text_file',
  'edited_image_file',
  'compact_file_reference',
  'pdf_reference',
  'inlined_image_paths',
  'opened_file_in_ide',
  'selected_lines_in_ide',
  'selected_lines_in_diff',
  'diagnostics',
  'mcp_resource',
  // CLAUDE.md とメモリの更新・差し控え
  'nested_memory',
  'memory_update',
  'withheld_memory',
  'cowork_memory_context',
  'account_memory_recall',
]);

// 意図して捨てる、応答の content のブロック: 中身が暗号化された思考（読めない）
const IGNORED_ASSISTANT_BLOCKS = new Set(['redacted_thinking']);
