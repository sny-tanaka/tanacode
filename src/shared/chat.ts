import { CHECKLIST_EVENT_TAG, CHECKLIST_REMINDER_TAG, CHECKLIST_UNCHANGED_MARK, checklistTarget, parseChecklistEvent, type CardRef } from './checklist-tools';
import { walkthroughTarget } from './walkthrough-tools';
import { t } from './i18n';
import { handbackOf, type Handback } from './handback';
import { modelName } from './model-name';
import { autoPercentOf, isCompactMessage, parseCompactMessage } from './optimized-compact';
import { INSTRUCTIONS_TAG, PARENT_INSTRUCTIONS_FILE, parseParentRole } from './project-instructions';
import { parseWakeup } from './scheduled';
import { parseParentMessage, parseSessionEvent, SESSION_EVENT_TAG, unwrapWholePaste, WAKEUP_TAG } from './session-tools';
import { classifyLine, isIgnoredAssistantBlock, isIgnoredAttachment, isIgnoredSystem, type ConversationEntry, type SideEntry, type TranscriptLine } from './transcript-line';
import { parseUsageResume, USAGE_RESUME_TAG, usageLimitOf, usageLimitText, type UsageLimitStop } from './usage-limit';
import { unknownEvent, type UnknownEvent } from './unknown-event';

// images: 画像の鍵（中身は main の画像置き場から取る。ImageSink を参照）。at: 会話ログの時刻（ミリ秒。作業の書き出しで使う）
// parent: 親セッションの Claude からの指示（start_session・send_message）なら、親セッションの ID。人の発言には無い
// command: スラッシュコマンド（/model など。発言ではない）
// pastes: 発言に添えた長い貼り付け（入力欄の札）の中身。text には入らない（splitPasted を参照）
// pasted: 発言の全体が 1 つの貼り付けだった（text は、その貼り付けの中身。札だけを送った発言か、前のアプリが丸ごと貼り付けで送った複数行の発言）
// 送ったが、まだ会話に出ていない発言。id: アプリが発言に付けた uuid（会話ログの行の uuid にもなる）/
// state: sending（Claude Code に渡した）・queued（Claude Code の順番待ちに入った。作業中に送ったもの）/ images: 添えた画像の数 /
// text・pastes・parent: 会話に出たときと同じ形（親セッションからの指示は、囲みを外した本文と親の ID。unsentView）
export type UnsentPrompt = { id: string; text: string; pastes: string[]; images: number; state: 'sending' | 'queued'; parent?: string };

// Claude が書いている途中の応答の文・思考の 1 ブロック（stream-json の stream_event から main が組み立てる。会話ログには無い）。
// そのブロックが会話ログに出たら、会話ログの応答と同じ配信で外す。id: 応答の ID とブロックの位置
export type PartialBlock = { id: string; kind: 'text' | 'thinking'; text: string };

export type ChatEvent =
  | { type: 'user'; id: string; text: string; pastes?: string[]; pasted?: true; images?: string[]; at?: number; parent?: string; command?: true }
  | { type: 'assistant-text'; id: string; text: string; at?: number }
  | { type: 'thinking'; id: string; text: string }
  // input: 入力の詳細（Bash のコマンド全文など）。todos: TodoWrite の一覧。taskChange: TaskCreate・TaskUpdate の中身。at: 会話ログの時刻（ミリ秒）
  // sentFiles: SendUserFile でユーザーに送ったファイル（絶対パス）と添え書き
  | {
      type: 'tool-use';
      id: string;
      name: string;
      target: string;
      filePath?: string;
      input: string;
      todos?: TodoItem[];
      taskChange?: TaskChange;
      // 何をするかの説明（Bash・Agent などの description。ターミナルでは畳んだツールの行に出る）
      description?: string;
      sentFiles?: SentFiles;
      at?: number;
    }
  // filePath / line: Edit・Write で変更したファイルと、最初に変更した行
  // output: Claude が受け取った結果（長いものは切り詰め）/ patch: Edit・Write の差分（unified 形式の行）
  | {
      type: 'tool-result';
      id: string;
      isError: boolean;
      added?: number;
      removed?: number;
      filePath?: string;
      line?: number;
      output?: string;
      patch?: string[];
      images?: string[];
      // AskUserQuestion への回答
      answers?: QuestionAnswer[];
      // TaskCreate で作った ToDo の番号
      createdTaskId?: string;
      at?: number;
    }
  // Claude への、ユーザーの発言ではない知らせ（バックグラウンドのタスクの完了・CI の自動修正・スケジュールタスク）。
  // Claude はこれを受けて作業を始める。detail: 開くと読める全文 / sessions: 子セッションからの知らせなら、その子の ID（チャットから移れる）/
  // cards: チェックリストの返信・コピーの知らせなら、そのカード（チャットから開ける）/
  // compact: 最適化圧縮でアプリが送った文（handoff: 仕上げの頼み / resume: 再開の文。全文は detail）
  | { type: 'notice'; id: string; text: string; detail?: string; sessions?: string[]; cards?: CardRef[]; compact?: 'handoff' | 'resume' }
  // 別の Claude（サブエージェント・ほかのセッション）からの知らせで、待機中の Claude Code が続きを始める。
  // 発言でも完了通知でもなく、チャットには何も出さない（ターンの始まりだけを伝える）
  | { type: 'turn-start' }
  // 画面に出るだけのお知らせ（起動時の「AGENTS.md を読み込みました」・Claude Code の警告・モデルの切り替え・メモリなど）。ターンは始まらない。
  // detail: 開くと読める全文（モデルの切り替えの Claude Code の説明・メモリのファイル名など）/ warning: 警告の色で出す
  | { type: 'info'; id: string; text: string; detail?: string; warning?: true }
  // 入力欄で ! を付けて実行したシェルのコマンド（Claude には渡らない）
  | { type: 'shell'; id: string; command: string; output: string }
  // ! のコマンドの出力。今の Claude Code はコマンドと出力を別の行に書くので、直前の shell に付ける
  | { type: 'shell-output'; id: string; output: string }
  // 会話の圧縮（/compact・自動圧縮）の区切り
  | { type: 'divider'; id: string; text: string }
  // API エラー。retrying: Claude Code が自動で再試行している（応答が来れば消す）/
  // limit: プランの利用枠に当たって止まった（会話ログの apiError が usage_limit_reached。枠が戻る時刻と、当たった枠）
  | { type: 'api-error'; id: string; text: string; retrying: boolean; limit?: UsageLimitStop }
  // interrupted: 人が中断した（Esc）
  | { type: 'turn-end'; interrupted?: true }
  // 送ったが、まだ会話に出ていない発言（今の全部）。会話に出たら減る（送った発言の uuid で追う。設計書 7 節）
  | { type: 'queue'; prompts: UnsentPrompt[] }
  // このセッションで作った・紐づいた PR（会話ログの pr-link 行。同じものが何度も書かれる）
  | { type: 'pr-link'; pr: PullRequestLink }
  // 会話を始め直した（/clear）。compact: 最適化圧縮の流れの中でアプリが打った /clear（チャットの画面は消さない。
  // ほかのセッションに状態を返すときも、作業の区切りにしない）
  | { type: 'reset'; compact?: true }
  // 巻き戻し（/rewind）で会話が枝分かれした。events で表示し直す（それまでの表示は捨てる）
  | { type: 'replace'; events: ChatEvent[] }
  // Remote Control がつながった（url）・切れた（null）
  | { type: 'remote-control'; url: string | null }
  // hooks の実行（出力のあったものと、Stop の要約に載ったもの）
  | { type: 'hook'; id: string; run: HookRun }
  // チェックリストを使い続けさせるフック（main の checklist-hook.ts）が、ターンの終わりを止めた。チャットには何も出さない。
  // このあとの応答は、チェックリストを直した報告で、作業の結果ではない（ほかのセッションに結果を返すときに見分ける。main の sessions-control.ts）
  | { type: 'checklist-stop' }
  | { type: 'process-start' }
  // 起動が終わって入力を受け付けられるようになった（入力欄が出た）
  | { type: 'ready' }
  // reason: 終わったわけ（ターミナルモードで、起動を終える前に終わった など）。終了の表示に、終了コードの代わりに出す
  | { type: 'process-exit'; exitCode: number; reason?: string }
  // tanacode が知らない、Claude Code からの行（stream-json・会話ログ・制御の要求）。チャットに畳んだ 1 行で出すだけで、ターンは始まらない
  | UnknownEvent;

// id: TaskCreate で作ったもの（Task #1 の 1）。TodoWrite の項目には無い
export type TodoItem = { content: string; status: string; activeForm?: string; id?: string };

// 今の Claude Code は ToDo を TodoWrite ではなく、TaskCreate（作る）と TaskUpdate（番号で状態などを変える）で扱う。
// 作ったものの番号は、TaskCreate の結果（toolUseResult.task.id）で分かる
export type TaskChange =
  | { kind: 'create'; subject: string; activeForm?: string }
  | { kind: 'update'; taskId: string; status?: string; subject?: string; activeForm?: string };

// hooks の 1 回の実行。toolUseId が付いていれば、そのツールの PreToolUse / PostToolUse など
export type SentFiles = { paths: string[]; caption: string | null };

export type PullRequestLink = { number: number; url: string; repository: string };

// AskUserQuestion の質問と、ユーザーが選んだ答え（複数選択は「, 」でつながる。「その他」は打った文字）
export type QuestionAnswer = { header: string; question: string; answer: string };

export type HookRun = {
  // PreToolUse / PostToolUse / Stop / SessionStart など
  event: string;
  // 例: PostToolUse:Write
  name: string;
  command: string | null;
  // success: 成功 / blocked: 止めた（exit 2 など）/ error: 失敗 / context: Claude に情報を渡した
  outcome: 'success' | 'blocked' | 'error' | 'context';
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  // 止めた理由・Claude に渡した内容など
  message: string;
  toolUseId: string | null;
  // 何も出力しなかったフック（stream の hook_response から作ったもの）の、Claude Code の hook_id。1 回の実行ごとに違うので、
  // 画面はこれで同じ実行の重なりを見分ける（コマンドが無いので、ほかの欄では見分けられない）
  hookId?: string;
};

// チャットに載せる出力の上限（全文はデバッグ用ターミナルか会話ログで見る）
const OUTPUT_CHARS = 3000;
const PATCH_LINES = 300;
const INPUT_CHARS = 3000;

type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  content?: unknown;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
};

export type TranscriptEntry = {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  isSidechain?: boolean;
  // user 行の出どころ（human・task-notification・peer など）。peer: 別の Claude（サブエージェント・ほかのセッション）からの知らせ
  origin?: { kind?: string };
  url?: string;
  // bridge-session 行の Remote Control の ID（/remote-control で切ると空になる）
  bridgeSessionId?: string;
  // system 行の本文
  content?: string;
  customTitle?: string;
  aiTitle?: string;
  interruptedMessageId?: string;
  // 圧縮後の要約（ユーザーの発言ではない）
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  isApiErrorMessage?: boolean;
  // API エラーの種類（usage_limit_reached など）と、その詳しいところ（利用枠なら rate_limit_info）。quotaLimits も利用枠の同じ中身
  apiError?: unknown;
  apiErrorParams?: unknown;
  quotaLimits?: unknown;
  compactMetadata?: { trigger?: string; preTokens?: number };
  error?: unknown;
  retryAttempt?: number;
  maxRetries?: number;
  // id: 応答の ID（1 つの応答は、ブロックごとに同じ id の行に分かれる）
  message?: { id?: string; content?: string | ContentBlock[]; model?: string };
  // 応答の行の、その応答の中のブロックの位置
  apiBlockIndex?: number;
  toolUseResult?: unknown;
  attachment?: Record<string, unknown>;
  // stop_hook_summary
  hookInfos?: { command?: string; durationMs?: number }[];
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  stopReason?: string;
  toolUseID?: string;
  // その行を書いたときのブランチ（作業の書き出しで使う）
  gitBranch?: string;
  // その行を書いたときの Claude Code の権限モード（user 行と permission-mode 行。default・acceptEdits・plan・auto・bypassPermissions）
  permissionMode?: string;
  // pr-link
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  // その行を書いた Claude Code のバージョン（未知のイベントに添える。付帯情報の行には無い）
  version?: string;
  // model_fallback・model_refusal_fallback: 元のモデルと、切り替えた先のモデル（ID）
  originalModel?: unknown;
  fallbackModel?: unknown;
  // model_refusal_fallback: 断られて取り消された応答の行の uuid（チャットから外す。retractedUuidsOf）
  retractedMessageUuids?: unknown;
  // memory_saved: 保存したメモリのファイル（絶対パス）
  writtenPaths?: unknown;
  // Claude Code が、順番待ちの発言をまとめて 1 つにした発言の行の、行の uuid より前に送った発言の uuid（送った順。mergedParts）
  mergedSendUuids?: unknown;
};

const INTERRUPTED_PREFIX = '[Request interrupted by user';

// 会話ログに埋め込まれた画像を受け取る。key はイベントに載せる鍵、dataUrl は中身
export type ImageSink = (key: string, dataUrl: string) => void;

// sidechain: サブエージェントの会話ログを読むとき。本体の会話ログではサブエージェントの行を飛ばす。
// bridge-session 行の Remote Control のつながり。つながっていれば URL、切れていれば null、分からなければ undefined。
// /remote-control で切ると ID が空の行が書かれる。以前つないでいた会話を再開すると、フラグが無くてもつなぎ直し、
// bridge_status（URL）の行を書かずにこの行だけを書く。ID（cse_…）は URL（https://claude.ai/code/session_…）と同じ文字列
export function bridgeUrlOf(entry: TranscriptEntry): string | null | undefined {
  if (entry.type !== 'bridge-session' || typeof entry.bridgeSessionId !== 'string') return undefined;
  if (entry.bridgeSessionId === '') return null;
  const match = /^cse_(\w+)$/.exec(entry.bridgeSessionId);
  return match ? `https://claude.ai/code/session_${match[1]}` : undefined;
}

// onImage: 画像を受け取る先（無ければ画像は出さない）
export function toChatEvents(entry: TranscriptEntry, cwd: string, sidechain = false, onImage?: ImageSink): ChatEvent[] {
  return lineChatEvents(classifyLine(entry), cwd, sidechain, onImage);
}

// 分けた行（transcript-line.ts の classifyLine）をチャットのイベントにする。もう分けた行を読むところ（main の session-manager.ts の
// handleEntry・chat-log.ts）は、こちらを使う。知らない行は未知のイベントにし、意図して捨てる行は出さない
export function lineChatEvents(line: TranscriptLine, cwd: string, sidechain = false, onImage?: ImageSink): ChatEvent[] {
  if (line.entry.isSidechain && !sidechain) return [];
  if (line.kind === 'unknown') return [unknownLine(line.entry, line.name, line.problem)];
  if (line.kind === 'ignored') return [];
  if (line.kind === 'side') return sideEvents(line.entry);
  return conversationEvents(line.entry, cwd, sidechain, onImage);
}

// ほかで使う付帯の行のうち、チャットに出すもの（Remote Control のつながり・PR へのリンク）
function sideEvents(entry: SideEntry): ChatEvent[] {
  if (entry.type === 'bridge-session') {
    const url = bridgeUrlOf(entry);
    return url !== undefined ? [{ type: 'remote-control', url }] : [];
  }
  if (entry.type === 'pr-link') {
    if (typeof entry.prUrl !== 'string' || typeof entry.prNumber !== 'number') return [];
    return [{ type: 'pr-link', pr: { number: entry.prNumber, url: entry.prUrl, repository: entry.prRepository ?? '' } }];
  }
  return [];
}

function conversationEvents(entry: ConversationEntry, cwd: string, sidechain: boolean, onImage?: ImageSink): ChatEvent[] {
  const at = timeOf(entry);

  if (entry.type === 'system') {
    if (entry.subtype === 'turn_duration') return [{ type: 'turn-end' }];
    // local_command: /context などローカルで完結するコマンド。会話の最初に打つと user 行ではなくこの行で残る
    // （中身は user 行と同じ <command-name> / <local-command-stdout>）
    if (entry.subtype === 'local_command') {
      const text = typeof entry.content === 'string' ? entry.content : '';
      return text.includes('<command-name>') ? userTextEvents(entry, text) : [{ type: 'turn-end' }];
    }
    if (entry.subtype === 'bridge_status') return entry.url ? [{ type: 'remote-control', url: entry.url }] : [];
    if (entry.subtype === 'informational') {
      return typeof entry.content === 'string' && entry.content.trim() ? [{ type: 'info', id: entry.uuid ?? '', text: entry.content.trim() }] : [];
    }
    if (entry.subtype === 'compact_boundary') return [{ type: 'divider', id: entry.uuid ?? '', text: compactText(entry) }];
    if (entry.subtype === 'stop_hook_summary') return stopHookEvents(entry);
    if (entry.subtype === 'model_fallback' || entry.subtype === 'model_refusal_fallback') return [modelSwitchEvent(entry)];
    if (entry.subtype === 'memory_saved') return memoryEvents(entry, entry.writtenPaths, 'chat.transcript.memorySaved', 'system/memory_saved');
    if (entry.subtype === 'api_error') {
      const error = entry.error as { formatted?: string; message?: string } | undefined;
      const message = error?.formatted ?? error?.message ?? t('chat.transcript.unknownError');
      const text =
        entry.retryAttempt && entry.maxRetries
          ? t('chat.transcript.apiErrorRetrying', { message, attempt: entry.retryAttempt, max: entry.maxRetries })
          : t('chat.transcript.apiError', { message });
      return [{ type: 'api-error', id: entry.uuid ?? '', text, retrying: true }];
    }
    if (typeof entry.subtype !== 'string') return [unknownLine(entry, 'system', 'malformed')];
    return isIgnoredSystem(entry.subtype) ? [] : [unknownLine(entry, `system/${entry.subtype}`)];
  }

  if (entry.type === 'attachment') {
    const prompt = midTurnPromptOf(entry.attachment);
    if (prompt !== null) {
      const blocks = entry.attachment?.prompt;
      // stream-json で送った発言は、送ったときの uuid（source_uuid）を発言の ID にする（送信中の表示を、同じ ID で消すため）
      const source = entry.attachment?.source_uuid;
      const target = typeof source === 'string' && source ? { ...entry, uuid: source } : entry;
      const images = Array.isArray(blocks) ? takeImages(target, blocks, 'q', onImage) : [];
      return withImages(prompt ? userTextEvents(target, prompt) : [], target, images);
    }
    const kind = entry.attachment?.type;
    // 作業中に届いた、サブエージェントの報告（SubagentHandback）。Claude Code の画面と同じく、報告を見せる。
    // ターンの途中なので、ターンを始めるお知らせではなく、補足の行にする
    const handback = kind === 'queued_command' && !sidechain ? handbackOf(entry.attachment?.origin) : null;
    if (handback) return [{ type: 'info', ...handbackView(entry.uuid ?? '', handback) }];
    // 作業中に届いた、ほかの発言でない差し込み（完了通知・別の Claude からの知らせ）は出さない（midTurnPromptOf）
    if (kind === 'queued_command') return [];
    if (isChecklistStop(entry.attachment)) return [{ type: 'checklist-stop' }];
    // Claude が、発言に関係のありそうなメモリを思い出した（中身は Claude にだけ渡り、画面には数とファイル名を出す。TUI と同じ程度）
    if (entry.attachment?.type === 'relevant_memories') {
      const memories = entry.attachment.memories;
      const paths = Array.isArray(memories) ? memories.map((m: { path?: unknown } | null) => m?.path) : undefined;
      return memoryEvents(entry, paths, 'chat.transcript.memoryRecalled', 'attachment/relevant_memories');
    }
    // hooks の記録（hook_ で始まるもの）。出さないもの（アプリが足したフックなど）も、ここで決める（hookRunOf）
    if (typeof kind === 'string' && kind.startsWith('hook_')) {
      const run = hookRunOf(entry.attachment!, kind);
      return run ? [{ type: 'hook', id: entry.uuid ?? '', run }] : [];
    }
    if (typeof kind !== 'string') return [unknownLine(entry, 'attachment', 'malformed')];
    return isIgnoredAttachment(kind) ? [] : [unknownLine(entry, `attachment/${kind}`)];
  }

  if (entry.type === 'assistant') {
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    // 再開時に Claude Code が差し込む、応答のなかったターンの埋め合わせ
    if (entry.message?.model === '<synthetic>' && blocks.every((b) => b.type !== 'text' || b.text === 'No response requested.')) {
      return [];
    }
    if (entry.isApiErrorMessage) {
      const text = blocks.map((b) => b.text ?? '').join('\n').trim();
      // 利用枠に当たって止まった。Claude Code の英語の文（「You've hit your session limit · resets 5am」）の代わりに、枠が戻る時刻を出す
      const limit = usageLimitOf(entry);
      if (limit) return [{ type: 'api-error', id: entry.uuid ?? '', text: usageLimitText(limit) ?? (text || t('chat.transcript.apiErrorNoDetail')), retrying: false, limit }];
      return [{ type: 'api-error', id: entry.uuid ?? '', text: text || t('chat.transcript.apiErrorNoDetail'), retrying: false }];
    }
    const events: ChatEvent[] = [];
    blocks.forEach((block, i) => {
      if (block.type === 'text') {
        // 空の文と、ターンの終わりの知らせに「直すものは無い」と答えた目印（Claude とアプリのあいだのやりとり）は出さない
        if (block.text?.trim() && block.text.trim() !== CHECKLIST_UNCHANGED_MARK) events.push({ type: 'assistant-text', id: `${entry.uuid}:${i}`, text: block.text, at });
      } else if (block.type === 'thinking') {
        // 多くの思考は本文が空（署名だけ）で記録される。本文があるときだけ出す。
        // 前後の改行は、折り返しを保つ表示で空行になるので取り除く
        if (block.thinking?.trim()) events.push({ type: 'thinking', id: `${entry.uuid}:${i}`, text: block.thinking.trim() });
      } else if (block.type === 'tool_use') {
        if (block.id && block.name) events.push(toolUseEvent(block.id, block.name, block.input ?? {}, cwd, at));
      } else if (!isIgnoredAssistantBlock(block.type)) {
        events.push(unknownBlock(entry, block, i));
      }
    });
    return events;
  }

  // 待機中の Claude Code は、別の Claude からの知らせで続きを始める。会話ログでは isMeta の user 行で残るので、ここで拾う
  // （作業の途中に届いたものは attachment の queued_command になり、ターンは始まらない）。
  // サブエージェントの報告（SubagentHandback）は、Claude Code の画面と同じく報告を見せる（開くと全文）
  if (entry.type === 'user' && entry.isMeta && entry.origin?.kind === 'peer' && !sidechain) {
    const handback = handbackOf(entry.origin);
    return [handback ? { type: 'notice', ...handbackView(entry.uuid ?? '', handback) } : { type: 'turn-start' }];
  }

  if (entry.type === 'user' && !entry.isMeta && !entry.isCompactSummary && !entry.isVisibleInTranscriptOnly) {
    const content = entry.message?.content;
    if (typeof content === 'string') return userTextEvents(entry, content);

    const events: ChatEvent[] = [];
    (content ?? []).forEach((block, index) => {
      if (block.type === 'tool_result') {
        // 呼び出しの ID の無い結果は、付けるカードが無いので出さない
        if (block.tool_use_id) events.push(...toolResultEvents(entry, block, block.tool_use_id, index, onImage));
      } else if (block.type === 'text') {
        if (block.text) events.push(...userTextEvents(entry, block.text));
      } else if (block.type !== 'image') {
        // 画像（発言に添付したもの）は、下で発言に付ける
        events.push(unknownBlock(entry, block, index));
      }
    });
    // ユーザーが発言に添付した画像（ツールの結果の行には付けない）
    if (content?.some((b) => b.type === 'tool_result')) return events;
    return withImages(events, entry, takeImages(entry, content ?? [], 'u', onImage));
  }

  // メタの行（Claude への文脈・スキルの本文など）・圧縮の要約・会話ログにだけ見える行は出さない
  return [];
}

// サブエージェントの報告の行の見出しと、開いたときの中身（注記があれば、報告の前に）
function handbackView(id: string, handback: Handback): { id: string; text: string; detail: string } {
  return { id, text: t('chat.transcript.agentReport', { name: handback.name }), detail: handback.note ? `${handback.note}\n\n${handback.report}` : handback.report };
}

// 会話ログの行の未知のイベント
function unknownLine(entry: TranscriptEntry, name: string, problem: 'unknown' | 'malformed' = 'unknown'): UnknownEvent {
  return unknownEvent(name, problem, 'transcript', entry, { key: entry.uuid, version: entry.version });
}

// 応答・発言の、知らない content のブロック。生の JSON は、そのブロック（行の全体は大きいことがあり、上限で切れて見えなくなる）
function unknownBlock(entry: TranscriptEntry, block: unknown, index: number): UnknownEvent {
  const kind = (block as { type?: unknown } | null)?.type;
  const name = `${entry.type}/${typeof kind === 'string' ? kind : ''}`;
  return unknownEvent(name, typeof kind === 'string' ? 'unknown' : 'malformed', 'transcript', block, {
    key: entry.uuid && `${entry.uuid}:${index}`,
    version: entry.version,
  });
}

// ツールの結果（発言の行の tool_result のブロック）と、PreToolUse の hooks で止めたときの記録
function toolResultEvents(entry: TranscriptEntry, block: ContentBlock, toolUseId: string, index: number, onImage?: ImageSink): ChatEvent[] {
  const summary = editSummary(entry.toolUseResult);
  const images = Array.isArray(block.content) ? takeImages(entry, block.content, `r${index}-`, onImage) : [];
  const result: ChatEvent = {
    type: 'tool-result',
    id: toolUseId,
    isError: !!block.is_error,
    ...summary,
    patch: patchLines(entry.toolUseResult),
    // Edit・Write は差分を出すので、「更新しました」という結果の文章は載せない。
    // バックグラウンドで起動したもの（Agent・Workflow）の結果は Claude 向けの内部メッセージなので載せない
    output: (summary.filePath && !block.is_error) || isAsyncLaunch(entry.toolUseResult) ? undefined : resultText(block.content, images.length === 0),
    images: images.length > 0 ? images : undefined,
    answers: answersOf(entry.toolUseResult),
    createdTaskId: block.is_error ? undefined : createdTaskIdOf(entry.toolUseResult),
    at: timeOf(entry),
  };
  const blocked = block.is_error ? blockedByHook(toolUseId, resultText(block.content)) : null;
  return blocked ? [result, { type: 'hook', id: `${entry.uuid ?? ''}:hook`, run: blocked }] : [result];
}

// ツールの呼び出し（応答の tool_use のブロック）
function toolUseEvent(id: string, name: string, input: Record<string, unknown>, cwd: string, at: number | undefined): ChatEvent {
  return {
    type: 'tool-use',
    id,
    name,
    target: checklistTarget(name, input) ?? walkthroughTarget(name, input, cwd) ?? toolTarget(input, cwd),
    filePath: typeof input.file_path === 'string' ? input.file_path : undefined,
    input: toolInputDetail(name, input),
    todos: name === 'TodoWrite' && Array.isArray(input.todos) ? (input.todos as TodoItem[]) : undefined,
    taskChange: taskChangeOf(name, input),
    description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined,
    sentFiles: name === 'SendUserFile' ? sentFilesOf(input, cwd) : undefined,
    at,
  };
}

// 画像のブロック（base64）を onImage に渡し、その鍵を返す。鍵は行の uuid と場所から作る
function takeImages(entry: TranscriptEntry, blocks: unknown[], place: string, onImage?: ImageSink): string[] {
  if (!onImage) return [];
  const keys: string[] = [];
  blocks.forEach((b, i) => {
    const block = b as { type?: string; source?: { type?: string; media_type?: string; data?: string } };
    if (block?.type !== 'image' || block.source?.type !== 'base64' || typeof block.source.data !== 'string') return;
    const key = `${entry.uuid ?? ''}:${place}${i}`;
    onImage(key, `data:${block.source.media_type ?? 'image/png'};base64,${block.source.data}`);
    keys.push(key);
  });
  return keys;
}

// 発言に画像を付ける。文字の無い（画像だけの）発言なら、画像だけの発言を作る
function withImages(events: ChatEvent[], entry: TranscriptEntry, images: string[]): ChatEvent[] {
  if (images.length === 0) return events;
  let last = -1;
  events.forEach((e, i) => {
    if (e.type === 'user') last = i;
  });
  if (last === -1) return [...events, { type: 'user', id: entry.uuid ?? '', text: '', images, at: timeOf(entry) }];
  return events.map((e, i) => (i === last && e.type === 'user' ? { ...e, images } : e));
}

// Claude の作業中にユーザーが送り、そのターンに差し込まれた発言。user 行ではなく、この attachment だけが残る。
// 同じ形のものでも、サブエージェントの報告（origin が peer）はユーザーの発言ではない。
// CI の自動修正の知らせ（origin なし）は、user 行のときと同じくお知らせとして出す（userTextEvents が見分ける）。
// stream-json で送った発言（-p。アプリ・親セッション）は origin が無く、送ったときの uuid（source_uuid）が付く（実測。2.1.301）。
// 出すものでなければ null、発言だが文字が無い（画像だけ）なら ''
function midTurnPromptOf(a: Record<string, unknown> | undefined): string | null {
  if (a?.type !== 'queued_command' || a.commandMode !== 'prompt') return null;
  const origin = (a.origin as { kind?: unknown } | undefined)?.kind;
  if (origin === undefined && typeof a.prompt === 'string' && a.prompt.trimStart().startsWith('<ci-monitor-event>')) return a.prompt;
  const streamed = origin === undefined && typeof a.source_uuid === 'string';
  if (origin !== 'human' && !streamed) return null;
  if (typeof a.prompt === 'string') return a.prompt;
  if (!Array.isArray(a.prompt)) return '';
  return (a.prompt as ContentBlock[])
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n');
}

const HOOK_OUTCOME: Record<string, HookRun['outcome']> = {
  hook_success: 'success',
  hook_blocking_error: 'blocked',
  hook_non_blocking_error: 'error',
  hook_error_during_execution: 'error',
  hook_additional_context: 'context',
  hook_stopped_continuation: 'blocked',
};

// 会話ログの attachment（hook_success など）。出力のあった hooks だけが記録される
// アプリが足した、AskUserQuestion の質問をファイルに書かせるフック（main の sessionSettings）に渡す環境変数
export const ASK_FILE_ENV = 'TANACODE_ASK_FILE';
// アプリが足した、worktree やブランチを消す操作で確認を出させるフック（main の worktree-guard.ts）の目印
export const GUARD_HOOK_ENV = 'TANACODE_WORKTREE_GUARD';
// アプリが足した、アプリ内ブラウザの JavaScript の実行で、ページによって確認を出させるフック（main の browser-gate.ts）の目印
export const BROWSER_GATE_HOOK_ENV = 'TANACODE_BROWSER_GATE';
// アプリが足した、子セッションの起動で、権限モードによらず人の許可の確認を出させるフック（main の statusline.ts）の目印
export const SESSIONS_GATE_HOOK_ENV = 'TANACODE_SESSIONS_GATE';
// アプリが足した、Claude にチェックリストを使い続けさせるフック（main の checklist-hook.ts）の目印
export const CHECKLIST_HOOK_ENV = 'TANACODE_CHECKLIST_HOOK';
// アプリが足した、人のターミナルに打つ前に、権限モードによらず人の許可の確認を出させるフック（main の terminal-bridge.ts）の目印
export const TERMINAL_GATE_HOOK_ENV = 'TANACODE_TERMINAL_GATE';
// 前のバージョンのアプリが足した、AskUserQuestion の質問をアプリに渡して答えを待つフックの目印（前の会話ログに残る行を、チャットのフックの一覧に出さない）
export const QUESTION_HOOK_ENV = 'TANACODE_QUESTION_HOOK';
// アプリが足した、TANACODE.md を Claude に渡すフック（main の instructions-hook.ts）の目印
export const INSTRUCTIONS_HOOK_ENV = 'TANACODE_INSTRUCTIONS_HOOK';
const APP_HOOK_MARKS = [
  ASK_FILE_ENV,
  GUARD_HOOK_ENV,
  BROWSER_GATE_HOOK_ENV,
  SESSIONS_GATE_HOOK_ENV,
  CHECKLIST_HOOK_ENV,
  TERMINAL_GATE_HOOK_ENV,
  QUESTION_HOOK_ENV,
  INSTRUCTIONS_HOOK_ENV,
];

function isAppHook(command: string): boolean {
  return APP_HOOK_MARKS.some((mark) => command.includes(mark));
}

// チェックリストを使い続けさせるフックが、ターンの終わりを止めた記録。文を渡して続けさせた記録（hook_additional_context。コマンドは載らないので、
// 囲みで見分ける）と、前のバージョンのアプリが止めた記録（hook_blocking_error。止めたフックのコマンドは blockingError に入る）
function isChecklistStop(a: Record<string, unknown> | undefined): boolean {
  if (a?.hookEvent !== 'Stop') return false;
  if (a.type === 'hook_additional_context') return Array.isArray(a.content) && a.content.some((c) => typeof c === 'string' && c.includes(`<${CHECKLIST_REMINDER_TAG}>`));
  if (a.type !== 'hook_blocking_error') return false;
  const command = (a.blockingError as { command?: unknown } | null | undefined)?.command;
  return typeof command === 'string' && command.includes(CHECKLIST_HOOK_ENV);
}

// アプリのフックが Claude に渡した文か（チェックリストの知らせ・TANACODE.md）
function isAppText(text: string): boolean {
  return text.includes(`<${CHECKLIST_REMINDER_TAG}>`) || text.includes(`<${INSTRUCTIONS_TAG} `);
}

// type: hook_ で始まる attachment の種類
function hookRunOf(a: Record<string, unknown>, type: string): HookRun | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const blocking = (a.blockingError ?? null) as { blockingError?: string; command?: string } | null;
  // Claude に文を渡した記録（hook_additional_context）は、同じ出来事で動いたフックの文を、1 つの記録の content にまとめて持つ
  // （SessionStart で、ユーザーのフックとアプリのフックが 1 つの記録になる。2.1.303 で実測）。アプリのフックの文だけを除いて、残りを出す
  const parts = Array.isArray(a.content) ? a.content.map(String) : null;
  const users = parts ? parts.filter((part) => !isAppText(part)) : null;
  const content = users ? users.join('\n') : str(a.content);
  // アプリが足したフックは、ユーザーのフックではないので出さない（止めたフックのコマンドは blockingError に入る。
  // Claude に文を渡した記録にはコマンドが無いので、チェックリストの知らせと TANACODE.md は囲みで見分ける）
  if (isAppHook(str(a.command)) || isAppHook(blocking?.command ?? '') || (users ? users.length === 0 : isAppText(content))) return null;
  // ユーザーのフックが、標準出力の JSON で suppressOutput を指定した成功の記録（Claude Code の画面でも出ない）。読めない JSON・ほかの出力は出す。
  // Stop は、要約（stop_hook_summary）の行に、出力の無いフックとしてコマンドだけが残る
  if (type === 'hook_success' && suppressesOutput(str(a.stdout))) return null;
  return {
    event: str(a.hookEvent) || str(a.hookName).split(':')[0] || 'hook',
    name: str(a.hookName) || str(a.hookEvent),
    command: str(a.command) || blocking?.command || null,
    outcome: HOOK_OUTCOME[type] ?? 'success',
    exitCode: num(a.exitCode),
    durationMs: num(a.durationMs),
    stdout: truncate(str(a.stdout), OUTPUT_CHARS),
    stderr: truncate(str(a.stderr), OUTPUT_CHARS),
    message: truncate(blocking?.blockingError ?? (type === 'hook_success' ? '' : content || str(a.message)), OUTPUT_CHARS),
    toolUseId: str(a.toolUseID) || null,
  };
}

// フックの標準出力が、suppressOutput: true を指定した JSON のオブジェクトか（Claude Code と同じく、出力の全体が JSON のときだけ読む）
function suppressesOutput(stdout: string): boolean {
  const text = stdout.trim();
  if (!text.startsWith('{')) return false;
  try {
    // { で始まって読めたものは、いつもオブジェクト
    return (JSON.parse(text) as { suppressOutput?: unknown }).suppressOutput === true;
  } catch {
    return false;
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trimEnd();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n${t('chat.transcript.charsOmitted', { count: trimmed.length - max })}` : trimmed;
}

// PreToolUse の hooks がツールを止めたときは、hooks の記録は残らず、ツールの結果が
// 「PreToolUse:Bash hook error: [コマンド]: 理由」になる
function blockedByHook(toolUseId: string, text: string | undefined): HookRun | null {
  const m = text?.match(/^(\w+)(?::(\S+))? hook error: \[([\s\S]*?)\]: ([\s\S]*)$/);
  if (!m) return null;
  return {
    event: m[1],
    name: m[2] ? `${m[1]}:${m[2]}` : m[1],
    command: m[3],
    outcome: 'blocked',
    exitCode: null,
    durationMs: null,
    stdout: '',
    stderr: '',
    message: m[4].trim(),
    toolUseId,
  };
}

// Stop の hooks の要約。出力の無かった hooks もコマンドと所要時間が載る（callback は Claude Code の内部の hooks、目印の付いたものはアプリが足した hooks なので出さない）
function stopHookEvents(entry: TranscriptEntry): ChatEvent[] {
  const errors = (entry.hookErrors ?? []).map(String);
  return (entry.hookInfos ?? [])
    .filter((h) => h.command && h.command !== 'callback' && !isAppHook(h.command))
    .map((h, i) => ({
      type: 'hook' as const,
      id: `${entry.uuid ?? ''}:${i}`,
      run: {
        event: 'Stop',
        name: 'Stop',
        command: h.command ?? null,
        outcome: entry.preventedContinuation ? ('blocked' as const) : errors.length > 0 ? ('error' as const) : ('success' as const),
        exitCode: null,
        durationMs: h.durationMs ?? null,
        stdout: '',
        stderr: errors.join('\n'),
        message: entry.stopReason ?? '',
        toolUseId: entry.toolUseID ?? null,
      },
    }));
}

function compactText(entry: TranscriptEntry): string {
  const { trigger, preTokens } = entry.compactMetadata ?? {};
  const auto = trigger === 'auto';
  if (!preTokens) return t(auto ? 'chat.transcript.compactedAuto' : 'chat.transcript.compacted');
  return t(auto ? 'chat.transcript.compactedAutoFrom' : 'chat.transcript.compactedFrom', { count: Math.round(preTokens / 1000) });
}

// モデルの切り替えのお知らせ。model_fallback: 混雑などで、予備のモデル（fallbackModel の設定・--fallback-model）に切り替えた。
// model_refusal_fallback: モデルが断った応答を取り消して、別のモデルで取り直した（取り消された応答は、retractedUuidsOf でチャットから外す）。
// 開くと、Claude Code の説明（英語。理由や、断られた種類・案内のリンク）が読める
function modelSwitchEvent(entry: TranscriptEntry): ChatEvent {
  const from = modelLabel(entry.originalModel);
  const to = modelLabel(entry.fallbackModel);
  const detail = typeof entry.content === 'string' && entry.content.trim() ? entry.content.trim() : undefined;
  const refusal = entry.subtype === 'model_refusal_fallback';
  const text =
    from && to
      ? t(refusal ? 'chat.transcript.modelRefusalFallback' : 'chat.transcript.modelFallback', { from, to })
      : t(refusal ? 'chat.transcript.modelRefusalFallbackUnknown' : 'chat.transcript.modelFallbackUnknown');
  return { type: 'info', id: entry.uuid ?? '', text, ...(detail ? { detail } : {}), warning: true };
}

// モデルの ID の表示名（読めなければ ID のまま）
function modelLabel(id: unknown): string | null {
  return typeof id === 'string' && id ? (modelName(id) ?? id) : null;
}

// 断られて取り消された応答の行の uuid（model_refusal_fallback の retractedMessageUuids）。その行から作ったイベントは、チャットから外す
// （main の chat-log.ts の retract）。Claude Code も、会話を再開するときに、会話ログからこの行を外す（2.1.302 の本体）。
// 2.1.302 は、取り消した応答を会話ログに書かない（実測）が、書かれていても同じに見えるようにする
export function retractedUuidsOf(entry: TranscriptEntry): string[] {
  if (entry.type !== 'system' || entry.subtype !== 'model_refusal_fallback' || !Array.isArray(entry.retractedMessageUuids)) return [];
  return entry.retractedMessageUuids.filter((uuid): uuid is string => typeof uuid === 'string' && uuid !== '');
}

// メモリを思い出した（relevant_memories）・保存した（memory_saved）お知らせ。開くと、そのファイルの名前が読める。ファイルが無ければ出さない。
// 形が違う（ファイルの一覧が無い・パスでないものが混じる）ときは、黙って捨てずに、未知のイベント（name の形の崩れ）として出す
function memoryEvents(entry: TranscriptEntry, paths: unknown, key: 'chat.transcript.memorySaved' | 'chat.transcript.memoryRecalled', name: string): ChatEvent[] {
  if (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === 'string' && p !== '')) return [unknownLine(entry, name, 'malformed')];
  if (paths.length === 0) return [];
  return [{ type: 'info', id: entry.uuid ?? '', text: t(key, { count: paths.length }), detail: paths.map((p) => p.split('/').pop()).join('\n') }];
}

function userTextEvents(entry: TranscriptEntry, text: string): ChatEvent[] {
  // 順番待ちの発言をまとめた 1 行は、送った発言ごとに分けて読む（親の指示を 1 つずつの発言に、知らせを 1 つずつのお知らせにする）
  const parts = mergedParts(entry, text);
  if (parts) return parts.flatMap((part) => userTextEvents({ ...entry, uuid: part.id, mergedSendUuids: undefined }, part.text));
  if (entry.interruptedMessageId || text.startsWith(INTERRUPTED_PREFIX)) return [{ type: 'turn-end', interrupted: true }];
  // 親セッションの Claude からの指示。人の発言と見分けて出す
  const fromParent = parseParentMessage(text);
  if (fromParent) {
    // 親からの指示の本文は、アプリが打った文。本文が丸ごと貼り付けの囲みに入っていても（前の送り方）、貼り付けの印は付けない
    const { pasted: _, ...parts } = pastedParts(fromParent.body);
    return [{ type: 'user', id: entry.uuid ?? '', ...parts, at: timeOf(entry), parent: fromParent.parent }];
  }
  // 「親にする」で TANACODE_PARENT.md を読ませた発言。開くと、前書きとファイルの中身が読める。
  // 新規セッションの画面の「親として始める」では、最初の指示が続くので、知らせのあとに人の発言として出す（発言の ID は、行の uuid のまま）
  const parentRole = parseParentRole(text);
  if (parentRole) {
    const id = entry.uuid ?? '';
    const notice: ChatEvent = { type: 'notice', id: parentRole.rest ? `${id}:parent-role` : id, text: t('chat.transcript.parentRole', { file: PARENT_INSTRUCTIONS_FILE }), detail: parentRole.body };
    return parentRole.rest ? [notice, ...userTextEvents(entry, parentRole.rest)] : [notice];
  }
  // 子セッションの作業が終わった・人の対応待ちになった知らせ（アプリが、手の空いている親に送る）
  const event = parseSessionEvent(text);
  if (event) return [{ type: 'notice', id: entry.uuid ?? '', text: event.message, sessions: event.sessions }];
  // Claude が自分に入れた予約の時刻になった知らせ（アプリが、手が空いてから送る）。開くと、Claude が書いた本文が読める
  const wakeup = parseWakeup(text);
  if (wakeup) return [{ type: 'notice', id: entry.uuid ?? '', text: t('chat.transcript.wakeup'), detail: unwrapPasted(wakeup.body) }];
  // 利用枠で止まったあと、枠が戻ったのでアプリが送った再開のメッセージ。開くと全文が読める
  const usageResume = parseUsageResume(text);
  if (usageResume) return [{ type: 'notice', id: entry.uuid ?? '', text: t('chat.transcript.usageLimitResume'), detail: usageResume.body }];
  // チェックリストのスレッドへの返信・ほかのセッションから届いたカードの知らせ
  const checklist = parseChecklistEvent(text);
  if (checklist) return [{ type: 'notice', id: entry.uuid ?? '', text: checklist.message, cards: checklist.cards }];
  // 最適化圧縮でアプリが送った、仕上げの頼みと再開の文。開くと全文が読める
  const compact = parseCompactMessage(text);
  if (compact) {
    // 自動で始めたものは、そのときのコンテキストの割合と一緒に出して、手動と見分けられるようにする
    const percent = autoPercentOf(compact.body);
    const notice =
      percent === null
        ? t(compact.kind === 'handoff' ? 'chat.transcript.compactHandoff' : 'chat.transcript.compactResume')
        : t(compact.kind === 'handoff' ? 'chat.transcript.compactHandoffAuto' : 'chat.transcript.compactResumeAuto', { percent });
    return [{ type: 'notice', id: entry.uuid ?? '', text: notice, detail: compact.body, compact: compact.kind }];
  }
  const special = specialUserText(entry.uuid ?? '', text.trimStart());
  if (special) return [special];
  if (text.includes('<task-notification>')) {
    const summary = text.match(/<summary>(.*?)<\/summary>/s)?.[1]?.trim();
    return [{ type: 'notice', id: entry.uuid ?? '', text: summary ?? t('chat.transcript.taskFinished') }];
  }
  // ローカルコマンド（/model など）の出力。ターンは発生しない
  if (text.includes('<local-command-stdout>') || text.includes('<local-command-caveat>')) return [{ type: 'turn-end' }];

  const command = text.match(/<command-name>(.*?)<\/command-name>/s)?.[1];
  // /compact は送った時点の発言と、圧縮後のコマンドの記録の 2 回残る。後者は「会話を圧縮しました」の区切りで表す
  if (command === '/compact') return [];
  if (command) {
    const args = text.match(/<command-args>(.*?)<\/command-args>/s)?.[1]?.trim();
    return [{ type: 'user', id: entry.uuid ?? '', text: args ? `${command} ${args}` : command, at: timeOf(entry), command: true }];
  }
  return [{ type: 'user', id: entry.uuid ?? '', ...pastedParts(text), at: timeOf(entry) }];
}

// Claude Code は、順番待ちの発言（priority: later で送った親の指示・知らせ・予約など）が、ターンの終わりにいくつも待っていると、
// まとめて 1 つの発言の行にする。本文は送った順に改行 1 つでつなぎ、行の uuid は最後に送った発言のもの、mergedSendUuids はそれより
// 前に送った発言のもの（送った順）（2.1.302・2.1.303 で実測）。そのまま読むと、親の指示の本文の途中に、閉じタグと開きタグが文字で出る。
// 送った発言ごとの本文と uuid に分ける。分けるのは tanacode の囲み（<tanacode-…>…</tanacode-…>）の切れ目だけ（囲みの本文には、囲みの
// タグが入らない。neutralizeTags）。囲みの無い発言どうし（人が書いた予約など）は分けられないので、分けた数が送った数より少なければ、
// 分けた最後の部分に行の uuid を、ほかには送った順の uuid を当てる。まとめた行でない・分けられない・分けた数が送った数より多い（人の
// 発言の中に、囲みのタグがあった）ときは null（1 つの発言のまま読む）
function mergedParts(entry: TranscriptEntry, text: string): { id: string; text: string }[] | null {
  const merged = Array.isArray(entry.mergedSendUuids) ? entry.mergedSendUuids.filter((uuid): uuid is string => typeof uuid === 'string' && uuid !== '') : [];
  if (merged.length === 0 || !entry.uuid) return null;
  const texts = text.split(MERGED_BOUNDARY);
  if (texts.length < 2 || texts.length > merged.length + 1) return null;
  return texts.map((part, i) => ({ id: i === texts.length - 1 ? entry.uuid! : merged[i], text: part }));
}

// まとめた発言の切れ目: 囲みの閉じタグのあとの改行と、囲みの開きタグの前の改行
const MERGED_BOUNDARY = /(?<=<\/tanacode-[a-z-]+>)\n|\n(?=<tanacode-[a-z-]+[ >])/;

// user イベントに入れる形（札が無ければ pastes を持たない）
function pastedParts(raw: string): { text: string; pastes?: string[]; pasted?: true } {
  const { text, pastes, whole } = splitPasted(raw);
  return pastes.length > 0 ? { text, pastes } : whole ? { text, pasted: true } : { text };
}

function timeOf(entry: TranscriptEntry): number | undefined {
  return entry.timestamp ? Date.parse(entry.timestamp) || undefined : undefined;
}

// user 行に入る、ユーザーの発言ではないもの
function specialUserText(id: string, text: string): ChatEvent | null {
  // ! を付けて実行したコマンド。出力は <bash-stdout> / <bash-stderr> に入る。
  // 前の Claude Code は同じ行に、今の Claude Code はコマンド（<bash-input>）と出力を別の行に書く
  const tag = (name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
  // 出力は < > & をエスケープして書かれる（Claude Code の TUI の「!」）ので、戻して出す
  const unescape = (s: string) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const shellOutput = () => truncate([tag('bash-stdout'), tag('bash-stderr')].map((s) => unescape(s.trim())).filter(Boolean).join('\n'), OUTPUT_CHARS);
  if (text.startsWith('<bash-input>')) return { type: 'shell', id, command: tag('bash-input').trim(), output: shellOutput() };
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) return { type: 'shell-output', id, output: shellOutput() };
  // 本家アプリの「Auto-fix pull requests」が、PR のレビューコメントや CI の失敗を Claude に知らせる
  if (text.startsWith('<ci-monitor-event>')) {
    const body = text.replace(/^<ci-monitor-event>/, '').replace(/<\/ci-monitor-event>\s*$/, '').trim();
    const pr = body.match(/PR #(\d+)/)?.[1];
    // 2 段落目の最初の文が、何を見つけたか（例: 「… PR #16405 has 1 new review comment (quoted below).」）
    const found = body.split(/\n\s*\n/)[1]?.match(/^.*?\.(?=\s|$)/)?.[0];
    const comments = found?.match(/has (\d+) new review comments?/)?.[1];
    const what = /was just enabled/.test(body)
      ? t('chat.transcript.ciEnabled')
      : comments
        ? t('chat.transcript.ciNewComments', { count: Number(comments) })
        : (found?.replace(/^\S+ PR #\d+ /, '') ?? t('chat.transcript.ciReceived'));
    const notice = pr ? t('chat.transcript.ciNoticePr', { pr, what }) : t('chat.transcript.ciNotice', { what });
    return { type: 'notice', id, text: notice, detail: truncate(body, OUTPUT_CHARS) };
  }
  // スケジュールタスクの起動
  if (text.startsWith('<scheduled-task')) {
    const name = text.match(/^<scheduled-task name="([^"]*)"/)?.[1];
    const body = text.replace(/^<scheduled-task[^>]*>/, '').replace(/<\/scheduled-task>\s*$/, '').trim();
    const notice = name ? t('chat.transcript.scheduledTaskNamed', { name }) : t('chat.transcript.scheduledTask');
    return { type: 'notice', id, text: notice, detail: truncate(body, OUTPUT_CHARS) };
  }
  return null;
}

// 順番待ちの発言が、人（または親セッション）の発言か。完了通知や知らせは除く
export function isHumanPrompt(text: string): boolean {
  // 知らせの全体が貼り付けの囲みに入っていることがある（長いとき）
  const head = unwrapWholePaste(text).trimStart();
  return (
    !text.includes('<task-notification>') &&
    !head.startsWith('<ci-monitor-event>') &&
    !head.startsWith(`<${SESSION_EVENT_TAG}`) &&
    !head.startsWith(`<${WAKEUP_TAG}`) &&
    !head.startsWith(`<${USAGE_RESUME_TAG}`) &&
    !head.startsWith(`<${CHECKLIST_EVENT_TAG}`) &&
    !isCompactMessage(text)
  );
}

// 送った発言を、送信中・順番待ちに出す形。会話ログの発言の行と同じ読み方（userTextEvents）で、会話に出たときと同じ形にする
// （親セッションからの指示は、囲みを外した本文と親の ID）。発言でないもの（子セッション・予約・チェックリストの知らせ、
// 最適化圧縮の文など）は null（出さない。会話に出たときに、お知らせとして出る）。
// 「親にする」の発言は、人がボタンで頼んだものなので、順番待ちにも出す（最初の指示が続くときは、その指示を出す）
export function unsentView(text: string): { text: string; pastes: string[]; parent?: string } | null {
  const parentRole = parseParentRole(text);
  if (parentRole && !parentRole.rest) return { text: t('chat.parentRole.queued', { file: PARENT_INSTRUCTIONS_FILE }), pastes: [] };
  const events = userTextEvents({}, parentRole ? parentRole.rest : text);
  const event = events.length === 1 ? events[0] : null;
  if (event?.type !== 'user' || event.command) return null;
  return { text: event.text, pastes: event.pastes ?? [], ...(event.parent ? { parent: event.parent } : {}) };
}

// 順番待ちとして出す文字。親セッションからの指示は、囲みを外す
export function promptDisplayText(text: string): string {
  const fromParent = parseParentMessage(text);
  return fromParent ? unwrapPasted(fromParent.body) : text;
}

const PASTED_BLOCK = /<pasted_content( id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content\1>/g;

// 発言を、打った文と、添えた長い貼り付け（入力欄の札）に分ける。
// Claude Code は、長い貼り付けの中身を、発言の文のあとに \n\n<pasted_content id="…">\n…\n</pasted_content id="…">\n の形で足して会話ログに残す。
// - 全体が 1 つの囲みだけなら、札にせず、中身を文として返す。前のアプリは複数行の発言を丸ごと貼り付けで送っていたので、
//   前の会話の複数行の発言は、すべてこの形で残っている（札にすると、どれも畳まれてしまう）
//   whole: この形だった（文は、貼り付けの中身。ユーザーが打った文とは限らない）
// - 囲みのあとに文が続くなど、この形でないものは、囲みを外して全部を文にする
export function splitPasted(raw: string): { text: string; pastes: string[]; whole: boolean } {
  const start = raw.indexOf('<pasted_content');
  if (start === -1) return { text: raw, pastes: [], whole: false };
  const pastes: string[] = [];
  const rest = raw.slice(start).replace(PASTED_BLOCK, (_, _id: string, body: string) => {
    pastes.push(body);
    return '';
  });
  const text = raw.slice(0, start).trim();
  if (pastes.length === 0 || rest.trim() !== '') return { text: unwrapPasted(raw), pastes: [], whole: false };
  return text === '' && pastes.length === 1 ? { text: pastes[0].trim(), pastes: [], whole: true } : { text, pastes, whole: false };
}

// 貼り付けた文字は <pasted_content id="…">…</pasted_content id="…"> で囲まれて会話ログに残る。囲みだけを外す
function unwrapPasted(text: string): string {
  if (!text.includes('<pasted_content')) return text;
  return text
    .replace(/<pasted_content(?: id="[^"]*")?>\n?/g, '')
    .replace(/\n?<\/pasted_content(?: id="[^"]*")?>/g, '')
    .trim();
}

export function toolTarget(input: Record<string, unknown>, cwd: string): string {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  // SendUserFile: 送ったファイルの名前
  if (Array.isArray(input.files)) return sentFilesOf(input, cwd).paths.map((p) => p.split('/').pop()).join(', ');
  // Workflow ツール: 保存済みワークフローの名前か、スクリプトの meta.name
  const script = pick('script');
  if (script) return script.match(/name\s*:\s*(['"`])(.*?)\1/)?.[2] ?? 'workflow';
  const path = pick('file_path') ?? pick('notebook_path') ?? pick('path');
  if (path) return relativeTo(path, cwd);
  // summary: SendMessage で送った内容の要約（宛先の ID より分かりやすい）
  const value =
    pick('command') ?? pick('description') ?? pick('pattern') ?? pick('url') ?? pick('query') ?? pick('prompt') ?? pick('summary');
  if (value) return value.split('\n')[0];
  const firstString = Object.values(input).find((v): v is string => typeof v === 'string');
  return firstString?.split('\n')[0] ?? '';
}

// SendUserFile の input。相対パスは会話のフォルダから見たもの
function sentFilesOf(input: Record<string, unknown>, cwd: string): SentFiles {
  const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string') : [];
  return {
    paths: files.map((f) => (f.startsWith('/') ? f : `${cwd}/${f.replace(/^\.\//, '')}`)),
    caption: typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : null,
  };
}

// ツールカードを開いたときに出す入力。コマンドやプロンプトは全文、それ以外は JSON
function toolInputDetail(name: string, input: Record<string, unknown>): string {
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  let detail: string;
  if (name === 'Bash') detail = [text(input.description) && `# ${text(input.description)}`, text(input.command)].filter(Boolean).join('\n');
  else if (name === 'Agent' || name === 'Task') detail = text(input.prompt);
  else if (name === 'Workflow' && typeof input.script === 'string') detail = input.script;
  else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') detail = '';
  else detail = JSON.stringify(input, null, 2);
  return detail.length > INPUT_CHARS ? `${detail.slice(0, INPUT_CHARS)}\n${t('chat.transcript.omitted')}` : detail;
}

// AskUserQuestion の結果（toolUseResult の questions と、質問文から答えへの answers）
function answersOf(result: unknown): QuestionAnswer[] | undefined {
  const r = result as { questions?: { question?: unknown; header?: unknown }[]; answers?: Record<string, unknown> } | null;
  if (!r || !Array.isArray(r.questions) || !r.answers || typeof r.answers !== 'object') return undefined;
  return r.questions.map((q) => {
    const question = typeof q?.question === 'string' ? q.question : '';
    const answer = r.answers![question];
    return { header: typeof q?.header === 'string' ? q.header : '', question, answer: typeof answer === 'string' ? answer : t('chat.transcript.noAnswer') };
  });
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function taskChangeOf(name: string, input: Record<string, unknown>): TaskChange | undefined {
  if (name === 'TaskCreate') {
    const subject = str(input.subject);
    return subject ? { kind: 'create', subject, activeForm: str(input.activeForm) } : undefined;
  }
  if (name === 'TaskUpdate') {
    // 番号は taskId のほか、task_id で渡されることもある
    const taskId = str(input.taskId) ?? str(input.task_id);
    return taskId ? { kind: 'update', taskId, status: str(input.status), subject: str(input.subject), activeForm: str(input.activeForm) } : undefined;
  }
  return undefined;
}

function createdTaskIdOf(result: unknown): string | undefined {
  const task = (result as { task?: { id?: unknown } } | null)?.task;
  return task && typeof task === 'object' ? str(task.id) : undefined;
}

function isAsyncLaunch(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as { status?: unknown }).status === 'async_launched';
}

// tool_result の content は文字列か、text / image ブロックの配列。
// withImages: 画像を「[画像]」と書く（画像そのものを出すときは書かない）
function resultText(content: unknown, withImages = true): string | undefined {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' && withImages ? t('chat.transcript.image') : ''))
      .join('\n');
  } else return undefined;
  text = text.trim();
  if (!text) return undefined;
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n${t('chat.transcript.charsOmitted', { count: text.length - OUTPUT_CHARS })}` : text;
}

function patchLines(result: unknown): string[] | undefined {
  const r = result as {
    type?: string;
    content?: unknown;
    structuredPatch?: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[];
  };
  if (!r || typeof r !== 'object') return undefined;
  let lines: string[];
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) {
    lines = r.structuredPatch.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]);
  } else if (r.type === 'create' && typeof r.content === 'string') {
    lines = r.content.replace(/\n$/, '').split('\n').map((l) => `+${l}`);
  } else {
    return undefined;
  }
  return lines.length > PATCH_LINES ? [...lines.slice(0, PATCH_LINES), t('chat.transcript.linesOmitted', { count: lines.length - PATCH_LINES })] : lines;
}

function relativeTo(path: string, cwd: string): string {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

type PatchHunk = { newStart: number; lines: string[] };

function editSummary(result: unknown): { added?: number; removed?: number; filePath?: string; line?: number } {
  if (!result || typeof result !== 'object') return {};
  const r = result as { type?: string; filePath?: string; content?: string; structuredPatch?: PatchHunk[] };
  const filePath = typeof r.filePath === 'string' ? r.filePath : undefined;
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) {
    let added = 0;
    let removed = 0;
    for (const hunk of r.structuredPatch) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    }
    return { added, removed, filePath, line: firstChangedLine(r.structuredPatch[0]) };
  }
  if (r.type === 'create' && typeof r.content === 'string') {
    return { added: r.content.replace(/\n$/, '').split('\n').length, removed: 0, filePath, line: 1 };
  }
  return {};
}

// hunk は前後の変更されていない行を含むので、それを飛ばした最初の変更行（変更後のファイルでの行番号）
function firstChangedLine(hunk: PatchHunk): number {
  let line = hunk.newStart;
  for (const text of hunk.lines) {
    if (text.startsWith('+') || text.startsWith('-')) return line;
    line++;
  }
  return hunk.newStart;
}

// 一覧に出すタイトル。priority が高いものを優先する（custom-title > ai-title > 最初の発言）
export function transcriptTitle(entry: TranscriptEntry): { title: string; priority: number } | null {
  if (entry.type === 'custom-title' && entry.customTitle) return { title: entry.customTitle, priority: 3 };
  if (entry.type === 'ai-title' && entry.aiTitle) return { title: entry.aiTitle, priority: 2 };
  if (
    entry.type === 'user' &&
    !entry.isMeta &&
    !entry.isSidechain &&
    !entry.isCompactSummary &&
    typeof entry.message?.content === 'string'
  ) {
    // 順番待ちの発言をまとめた行は、はじめに送った発言で決める
    const text = mergedParts(entry, entry.message.content)?.[0].text ?? entry.message.content;
    if (text.includes('<local-command-') || text.includes('<command-name>') || parseSessionEvent(text) || parseChecklistEvent(text) || parseCompactMessage(text) || parseWakeup(text) || parseUsageResume(text)) return null;
    // 「親にする」の発言は、続く最初の指示から（「親として始める」）。指示が無ければタイトルにしない
    const parentRole = parseParentRole(text);
    if (parentRole && !parentRole.rest) return null;
    // 親セッションからの指示は、囲みを外した本文の 1 行目
    const firstLine = unwrapPasted(promptDisplayText(parentRole ? parentRole.rest : text)).trim().split('\n')[0];
    return firstLine ? { title: firstLine.slice(0, 80), priority: 1 } : null;
  }
  return null;
}

export function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  return typeof value === 'object' && value !== null;
}
