// Claude Code の stream-json（claude -p --input-format stream-json --output-format stream-json）の行のうち、tanacode が使うもの。
// 形は公開の Agent SDK（@anthropic-ai/claude-agent-sdk 0.3.301 = Claude Code 2.1.301 の sdk.d.ts）の型に合わせ、使う項目だけを書く。
// SDK のパッケージは使わない（プロセスを常駐のホストが持ち、再起動したアプリが途中からつなぎ直すため。設計書 6 節）。
// 文書に無い内部の要求（remote_control・rewind_conversation など）は internal.ts に置く

import type { LineKind, RetainRule } from '../pty-host-protocol';

export type PermissionModeName = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Messages API の内容のブロック（使う形だけ）
export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ContentBlock = TextBlock | ImageBlock | { type: string; [key: string]: unknown };

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// SDKMessageOrigin（スマホなど、アプリの外から届いた発言は human）
export type MessageOrigin = { kind: string; [key: string]: unknown };

// アプリが送る発言（SDKUserMessage）。uuid はアプリが付け、戻ってくる行（--replay-user-messages）と command_lifecycle で追う。
// pasted_content: 入力欄に貼り付けた長い文（札）。CLI が打った文のあとに足し、TUI と同じ <pasted_content> の囲みに入れる
export type UserInput = {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  uuid: string;
  priority?: 'now' | 'next' | 'later';
  pasted_content?: string[];
};

// Claude Code が出す user の行（ツールの結果・戻ってきた発言 SDKUserMessageReplay など）
export type UserMessage = {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: string | null;
  uuid?: string;
  isReplay?: boolean;
  isSynthetic?: boolean;
  origin?: MessageOrigin;
  priority?: 'now' | 'next' | 'later';
  session_id?: string;
};

// SDKAssistantMessage（message は BetaMessage）
export type AssistantMessage = {
  type: 'assistant';
  message: { id?: string; model?: string; content?: ContentBlock[]; stop_reason?: string | null; usage?: Usage };
  parent_tool_use_id: string | null;
  uuid: string;
  session_id?: string;
  error?: string;
};

// rewind_files の返事（SDK の RewindFilesResult）。dry_run では、戻すと変わるファイルと行の数だけを返す
export type RewindFilesResult = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };

// SDKResultSuccess・SDKResultError（ターンの終わり）
export type ResultMessage = {
  type: 'result';
  subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result?: string;
  stop_reason: string | null;
  terminal_reason?: string;
  total_cost_usd?: number;
  usage?: Usage;
  // このターンが取り込んだ発言の uuid（アプリが付けたもの）
  user_message_uuids?: string[];
  errors?: string[];
  // API エラーで終わったときの種類と状態コード（利用枠に当たったときは usage_limit_reached と 429。subtype は success のまま。2.1.302 で実測）
  api_error?: string;
  api_error_status?: number;
  uuid: string;
  session_id: string;
};

// SDKSystemMessage（subtype init）。effort は次の要求で送るエフォート（無ければ null）
export type InitMessage = {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  permissionMode: PermissionModeName;
  apiKeySource: string;
  claude_code_version: string;
  cwd: string;
  tools: string[];
  slash_commands: string[];
  effort?: EffortLevel | null;
  capabilities?: string[];
  uuid: string;
};

// SDKStatusMessage。status: compacting（圧縮中）・requesting（応答を待っている）・null。
// 圧縮が終わると、null に compact_result（success・failed）と、失敗なら compact_error（理由の文）を付けて出す。
// 圧縮中の行は、要約を待つ間 30 秒ごとに出直すことがある。compact_output_chars（@internal）は自動の圧縮の compacting にだけ付く
// （手動の /compact には付かない。2.1.302 の型の説明と実測）。PreCompact のフックが自動の圧縮を止めると、compacting のあと、
// compact_result の無い null か、失敗（compact_error が「Compaction blocked by PreCompact hook: <フックの理由>」）になる（2.1.302 の本体）
export type StatusMessage = {
  type: 'system';
  subtype: 'status';
  status: 'compacting' | 'requesting' | null;
  permissionMode?: PermissionModeName;
  compact_result?: 'success' | 'failed';
  compact_error?: string;
  compact_output_chars?: number;
  uuid: string;
  session_id: string;
};

// auto モードの判定（ツールを使ってよいか）の待ち（system/permission_check_status。SDK の公開の型には無い）。
// checking: 判定を 4 秒ほど待って、まだ待っている / done: その待ちが終わった（4 秒より早く済んだ判定には、どちらも出ない）。
// agent_id: サブエージェントの中のツールの呼び出しのとき（2.1.302 の本体）
export type PermissionCheckStatusMessage = {
  type: 'system';
  subtype: 'permission_check_status';
  tool_use_id: string;
  agent_id?: string;
  status: 'checking' | 'done';
  uuid?: string;
};

// SDKTaskStartedMessage・SDKTaskNotificationMessage（裏のタスク）。task_type は local_bash・local_agent・local_workflow など
export type TaskStartedMessage = {
  type: 'system';
  subtype: 'task_started';
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  is_backgrounded?: boolean;
  uuid: string;
};

export type TaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  uuid: string;
};

// SDKCompactBoundaryMessage
export type CompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata: { trigger: 'manual' | 'auto'; pre_tokens: number; post_tokens?: number };
  uuid: string;
};

// SDKAPIRetryMessage
export type ApiRetryMessage = {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
  uuid: string;
};

// SDKNotificationMessage。Claude Code の警告（圧縮の失敗・起動時のエフォートやコンテキストの上限・メモリの停止など）。stream-json にだけ出る。
// key: 種類（stop-hook-error など）/ priority: low・medium・high・immediate / color: error・warning・success・suggestion など /
// timeout_ms: TUI で消すまでの時間（一時的な知らせ）。uuid は付かないこともある（Claude Code 2.1.302 の本体）
export type NotificationMessage = {
  type: 'system';
  subtype: 'notification';
  key: string;
  text: string;
  priority?: string;
  color?: string;
  timeout_ms?: number;
  uuid?: string;
};

// SDKModelRefusalFallbackMessage。モデルが断った応答を取り消して、別のモデルで取り直した。チャットのお知らせは会話ログの同じ行から出し、
// ここでは取り消された応答（retracted_message_uuids。stream-json に出た assistant・user の行の uuid）を、書いている途中の文から外すのに使う。
// 取り消された応答は会話ログに書かれない（2.1.302 で実測）
export type ModelRefusalFallbackMessage = {
  type: 'system';
  subtype: 'model_refusal_fallback';
  original_model?: string;
  fallback_model?: string;
  retracted_message_uuids?: string[];
  uuid?: string;
};

// Remote Control のつながり（system/bridge_state。SDK の公開の型には無い）。state: ready・connected・failed など
export type BridgeStateMessage = { type: 'system'; subtype: 'bridge_state'; state: string; detail?: string; uuid?: string };

// フックの始まりと終わり（system/hook_started・hook_response。--include-hook-events）。hook_name は「出来事:ツールの名前」など
// （例: PreToolUse:Bash）。コマンドとツールの呼び出しの ID は載らない。outcome: success・error・cancelled（2.1.302）
export type HookStartedMessage = { type: 'system'; subtype: 'hook_started'; hook_id: string; hook_name: string; hook_event: string; uuid?: string };
export type HookResponseMessage = {
  type: 'system';
  subtype: 'hook_response';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: string;
  uuid?: string;
};

// SDKCommandsChangedMessage（セッションの途中での / のコマンドの一覧の変化。スキルのファイルを足した・プラグインを読み直したなど）。
// commands は initialize の返事の commands と同じ形の、変わったあとの全部（Claude Code 2.1.302 の本体。同じ関数で作る）
export type CommandsChangedMessage = { type: 'system'; subtype: 'commands_changed'; commands: SlashCommandInfo[]; uuid?: string; session_id?: string };

// SDKConversationResetMessage（/clear）。新しい会話の ID は、このあとの system/init の session_id（new_conversation_id とは別。実測）
export type ConversationResetMessage = {
  type: 'conversation_reset';
  new_conversation_id: string;
  trigger?: 'clear' | 'plan_mode_exit' | 'fresh_session' | 'onboarding';
  user_message_uuid?: string;
  uuid: string;
  session_id: string;
};

// SDKPartialAssistantMessage（--include-partial-messages。書いている途中。event は Messages API のストリーミングの出来事）。
// 進み具合と、チャットに出す書いている途中の文（stream/partial.ts）に使う。読むときに確かめるのは type だけなので、ほかの項目は使う側で確かめる
export type StreamEventMessage = {
  type: 'stream_event';
  event: {
    type: string;
    // content_block_* のブロックの位置
    index?: number;
    // message_start の応答（id は会話ログの応答の行の message.id と同じ）
    message?: { id?: string };
    content_block?: { type?: string; text?: string; thinking?: string };
    delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null };
    usage?: Usage;
  };
  // 取り直すために捨てた応答のブロック（message_stop に付く。この応答の from_block_index から先は、会話ログに出ない。
  // 接続が途中で切れたときなど。Claude Code 2.1.302 で実測）
  abandoned_blocks?: { api_message_id?: string; from_block_index?: number };
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
};

// SDKToolProgressMessage（ツールの実行中の経過）
export type ToolProgressMessage = {
  type: 'tool_progress';
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  uuid: string;
};

// SDKRateLimitEvent。unifiedWindows の utilization は 0〜1、resetsAt は秒（実測）
export type RateLimitWindow = { utilization: number; resetsAt: number };
export type RateLimitEvent = {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: string;
    utilization?: number;
    unifiedWindows?: { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow };
  };
  uuid: string;
};

// 送った発言の受け付けの知らせ。queued: 順番待ちに入った / started: ターンに取り込まれた / completed・cancelled・discarded: 終わった。
// SDK の公開の型には無い（system/init の capabilities の msg_lifecycle_v1）。command_uuid は、アプリが発言に付けた uuid
export type CommandLifecycleMessage = {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded';
  uuid: string;
  session_id: string;
};

// Claude Code からアプリへの制御の要求のうち、答えるもの（SDKControlPermissionRequest）。
// 許可の確認・AskUserQuestion・ExitPlanMode・ワークフローを始める前の確認が、どれもこれで来る
export type PermissionUpdate =
  | { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: { toolName: string; ruleContent?: string }[]; behavior: 'allow' | 'deny' | 'ask'; destination: string }
  | { type: 'setMode'; mode: PermissionModeName; destination: string }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: string };

export type CanUseToolRequest = {
  subtype: 'can_use_tool';
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  permission_suggestions?: PermissionUpdate[];
  blocked_path?: string;
  decision_reason?: string;
  decision_reason_type?: string;
  // false: 安全の確かめのうち、人が承認しなければならないものがある
  classifier_approvable?: boolean;
  // 間違って 1 回押しただけで許されないようにする確認
  default_to_no?: boolean;
  // ユーザーの設定の ask の規則（permissions.ask）が出させた確認
  matched_ask_rule?: { source: string; tool_name: string; rule_content?: string };
  title?: string;
  display_name?: string;
  description?: string;
  agent_id?: string;
  suppress_always_allow_rule?: boolean;
  requires_user_interaction?: boolean;
};

// 許可への答え（PermissionResult）
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

// MCP サーバーから人への質問（SDKControlElicitationRequest）。MCP サーバーが elicitation/create を送り、フックが答えなかったときに来る。
// mode: form（項目を埋める。無ければ form）・url（人がページを開いて続ける。elicitation_id で、あとの完了の知らせ
// system/elicitation_complete と結ぶ）/ property_order: requested_schema.properties の項目の、MCP サーバーが書いた順 /
// title・display_name・description: MCP サーバーの _meta の anthropic/permissionDisplay。
// 待っている間、Claude Code は Remote Control に「Claude needs your input」と出す（2.1.302 の本体）
export type ElicitationRequest = {
  subtype: 'elicitation';
  mcp_server_name: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
  property_order?: string[];
  title?: string;
  display_name?: string;
  description?: string;
};

// 質問への答え（MCP の ElicitResult。content は accept のときだけ）。error で返すと、Claude Code は cancel にする（2.1.302 の本体）
export type ElicitationResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };

// SDKElicitationCompleteMessage（URL の形の質問を、MCP サーバーが終わったと知らせた。notifications/elicitation/complete）
export type ElicitationCompleteMessage = { type: 'system'; subtype: 'elicitation_complete'; mcp_server_name: string; elicitation_id: string; uuid?: string; session_id?: string };

export type ControlRequestMessage = { type: 'control_request'; request_id: string; request: { subtype: string; [key: string]: unknown } };
export type ControlCancelMessage = { type: 'control_cancel_request'; request_id: string };
export type ControlResponseMessage = {
  type: 'control_response';
  response: { subtype: 'success'; request_id: string; response?: Record<string, unknown> } | { subtype: 'error'; request_id: string; error: string };
};

// initialize の返事（SDKControlInitializeResponse のうち使うもの。pid・current_permission_mode・remote_control_available は公開の型に無い）
export type ModelInfo = {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAutoMode?: boolean;
};
export type SlashCommandInfo = { name: string; description: string; argumentHint: string; aliases?: string[]; builtin?: boolean };
export type AccountInfo = { email?: string; organization?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string; apiProvider?: string };
export type InitializeResponse = {
  commands: SlashCommandInfo[];
  models: ModelInfo[];
  account: AccountInfo;
  claude_code_version?: string;
  pid?: number;
  current_permission_mode?: PermissionModeName;
  remote_control_available?: boolean;
};

// initialize の返事のうち、記録に残して引き継ぎで戻すもの（SessionRecord.claudeInit）
export type SavedInit = Pick<InitializeResponse, 'commands' | 'models' | 'remote_control_available'>;

// get_context_usage の返事（SDKControlGetContextUsageResponse のうち使うもの）
export type ContextUsageResponse = { totalTokens: number; maxTokens: number; percentage: number; model?: string };

// get_usage の返事（SDKControlGetUsageResponse のうち使うもの）。utilization は 0〜100、resets_at は ISO の時刻（実測）
export type UsageWindow = { utilization: number | null; resets_at: string | null } | null;
// model_scoped: サーバーの一覧から来る、モデル別の週の枠（display_name はサーバーが付けた名前。一覧を作れなかったときは無い。2.1.302）。
// seven_day_opus・seven_day_sonnet は、それより前からある Opus・Sonnet の週の枠（2.1.302 の /usage は seven_day_opus を出さない）
export type UsageResponse = {
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: UsageWindow;
    seven_day?: UsageWindow;
    seven_day_opus?: UsageWindow;
    seven_day_sonnet?: UsageWindow;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
  } | null;
};

// get_settings の返事のうち使うもの。errors: 形の違う設定ファイル（-p は黙って無視する。実測）
export type SettingsResponse = { effective?: { plansDirectory?: unknown }; applied?: { model?: string; effort?: string | null }; errors?: unknown[] };

// stream-json の出力の行として知っている種類
export type StreamMessage =
  | UserMessage
  | AssistantMessage
  | ResultMessage
  | InitMessage
  | StatusMessage
  | PermissionCheckStatusMessage
  | TaskStartedMessage
  | TaskNotificationMessage
  | CompactBoundaryMessage
  | ApiRetryMessage
  | NotificationMessage
  | ModelRefusalFallbackMessage
  | BridgeStateMessage
  | CommandsChangedMessage
  | ElicitationCompleteMessage
  | ConversationResetMessage
  | StreamEventMessage
  | ToolProgressMessage
  | RateLimitEvent
  | CommandLifecycleMessage
  // ほかの system の知らせ（task_progress・task_updated・hook_* など）。使わないものは種類だけを見る
  | { type: 'system'; subtype: string; uuid?: string; [key: string]: unknown };

// 起動の引数（ClaudeSession の claudeArgs が足す）。--verbose が無いと stream-json では起動しない。
// --permission-prompt-tool stdio が無いと、聞くべき許可が自動で断られ、AskUserQuestion・ExitPlanMode も使えない（設計書 4 節）。
// --include-hook-events: すべての出来事のフックの終わり（system/hook_response）を出させる。何も出力しなかったフックは会話ログに
// 残らないので、これでチャットに出す（無いと SessionStart・Setup だけ）
export const STREAM_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-prompt-tool',
  'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
  '--include-hook-events',
] as const;

// 常駐のホストに控えてもらう、種類ごとの最新の行（アプリを再起動したとき、控えの頭が欠けても状態を組み立て直せるように）と、
// 控えない行（書いている途中。アプリがいない間は要らない）。
// status は、権限モードの付いた行だけ（圧縮中などのモードの無い status で、モードが分からなくならないように）。
// 裏のタスクは、終わりの知らせ（task_notification）か、終わった状態への変化（task_updated）で捨てる。
// / のコマンドの一覧の変化（commands_changed）は、アプリがいない間に変わっても、入力欄の候補を新しくできるように
export const RETAIN_RULES: RetainRule[] = [
  { type: 'system', subtype: 'init' },
  { type: 'system', subtype: 'status', where: { permissionMode: [] } },
  { type: 'system', subtype: 'bridge_state' },
  { type: 'system', subtype: 'commands_changed' },
  { type: 'rate_limit_event' },
  {
    type: 'system',
    subtype: 'task_started',
    key: 'task_id',
    until: [
      { type: 'system', subtype: 'task_notification', key: 'task_id' },
      { type: 'system', subtype: 'task_updated', key: 'task_id', where: { 'patch.status': ['completed', 'failed', 'killed'] } },
    ],
  },
];
export const TRANSIENT_KINDS: LineKind[] = [{ type: 'stream_event' }];
