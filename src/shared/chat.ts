// images: 画像の鍵（中身は main の画像置き場から取る。ImageSink を参照）
export type ChatEvent =
  | { type: 'user'; id: string; text: string; images?: string[] }
  | { type: 'assistant-text'; id: string; text: string }
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
  // Claude はこれを受けて作業を始める。detail: 開くと読める全文
  | { type: 'notice'; id: string; text: string; detail?: string }
  // 画面に出るだけのお知らせ（起動時の「AGENTS.md を読み込みました」など）。ターンは始まらない
  | { type: 'info'; id: string; text: string }
  // 入力欄で ! を付けて実行したシェルのコマンド（Claude には渡らない）
  | { type: 'shell'; id: string; command: string; output: string }
  // 会話の圧縮（/compact・自動圧縮）の区切り
  | { type: 'divider'; id: string; text: string }
  // API エラー。retrying: Claude Code が自動で再試行している（応答が来れば消す）
  | { type: 'api-error'; id: string; text: string; retrying: boolean }
  | { type: 'turn-end' }
  // Claude Code の作業中に送って順番を待っている発言（今の全部）。受け取られたら減る
  | { type: 'queue'; prompts: string[] }
  // このセッションで作った・紐づいた PR（会話ログの pr-link 行。同じものが何度も書かれる）
  | { type: 'pr-link'; pr: PullRequestLink }
  | { type: 'reset' }
  // 巻き戻し（/rewind）で会話が枝分かれした。events で表示し直す（それまでの表示は捨てる）
  | { type: 'replace'; events: ChatEvent[] }
  // Remote Control がつながった（url）・切れた（null）
  | { type: 'remote-control'; url: string | null }
  // hooks の実行（出力のあったものと、Stop の要約に載ったもの）
  | { type: 'hook'; id: string; run: HookRun }
  | { type: 'process-start' }
  // 起動が終わって入力を受け付けられるようになった（入力欄が出た）
  | { type: 'ready' }
  | { type: 'process-exit'; exitCode: number };

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
  compactMetadata?: { trigger?: string; preTokens?: number };
  error?: unknown;
  retryAttempt?: number;
  maxRetries?: number;
  message?: { content?: string | ContentBlock[]; model?: string };
  toolUseResult?: unknown;
  attachment?: Record<string, unknown>;
  // stop_hook_summary
  hookInfos?: { command?: string; durationMs?: number }[];
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  stopReason?: string;
  toolUseID?: string;
  // pr-link
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
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
  if (entry.isSidechain && !sidechain) return [];
  const at = entry.timestamp ? Date.parse(entry.timestamp) || undefined : undefined;

  if (entry.type === 'system') {
    if (entry.subtype === 'turn_duration') return [{ type: 'turn-end' }];
    // local_command: /context などローカルで完結するコマンド。会話の最初に打つと user 行ではなくこの行で残る
    // （中身は user 行と同じ <command-name> / <local-command-stdout>）
    if (entry.subtype === 'local_command') {
      const text = typeof entry.content === 'string' ? entry.content : '';
      return text.includes('<command-name>') ? userTextEvents(entry, text) : [{ type: 'turn-end' }];
    }
    if (entry.subtype === 'bridge_status' && entry.url) return [{ type: 'remote-control', url: entry.url }];
    if (entry.subtype === 'informational' && typeof entry.content === 'string' && entry.content.trim()) {
      return [{ type: 'info', id: entry.uuid ?? '', text: entry.content.trim() }];
    }
    if (entry.subtype === 'compact_boundary') return [{ type: 'divider', id: entry.uuid ?? '', text: compactText(entry) }];
    if (entry.subtype === 'stop_hook_summary') return stopHookEvents(entry);
    if (entry.subtype === 'api_error') {
      const error = entry.error as { formatted?: string; message?: string } | undefined;
      const retry = entry.retryAttempt && entry.maxRetries ? ` — 再試行中（${entry.retryAttempt}/${entry.maxRetries}）` : '';
      return [{ type: 'api-error', id: entry.uuid ?? '', text: `API エラー: ${error?.formatted ?? error?.message ?? '不明なエラー'}${retry}`, retrying: true }];
    }
    return [];
  }

  if (entry.type === 'bridge-session') {
    const url = bridgeUrlOf(entry);
    if (url !== undefined) return [{ type: 'remote-control', url }];
  }
  if (entry.type === 'pr-link' && typeof entry.prUrl === 'string' && typeof entry.prNumber === 'number') {
    return [{ type: 'pr-link', pr: { number: entry.prNumber, url: entry.prUrl, repository: entry.prRepository ?? '' } }];
  }

  if (entry.type === 'attachment') {
    const prompt = midTurnPromptOf(entry.attachment);
    if (prompt !== null) {
      const blocks = entry.attachment?.prompt;
      const images = Array.isArray(blocks) ? takeImages(entry, blocks, 'q', onImage) : [];
      return withImages(prompt ? userTextEvents(entry, prompt) : [], entry, images);
    }
    const run = hookRunOf(entry.attachment);
    return run ? [{ type: 'hook', id: entry.uuid ?? '', run }] : [];
  }

  if (entry.type === 'assistant') {
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    // 再開時に Claude Code が差し込む、応答のなかったターンの埋め合わせ
    if (entry.message?.model === '<synthetic>' && blocks.every((b) => b.type !== 'text' || b.text === 'No response requested.')) {
      return [];
    }
    if (entry.isApiErrorMessage) {
      const text = blocks.map((b) => b.text ?? '').join('\n').trim();
      return [{ type: 'api-error', id: entry.uuid ?? '', text: text || 'API エラー', retrying: false }];
    }
    const events: ChatEvent[] = [];
    blocks.forEach((block, i) => {
      if (block.type === 'text' && block.text?.trim()) {
        events.push({ type: 'assistant-text', id: `${entry.uuid}:${i}`, text: block.text });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        // 多くの思考は本文が空（署名だけ）で記録される。本文があるときだけ出す
        events.push({ type: 'thinking', id: `${entry.uuid}:${i}`, text: block.thinking });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        const input = block.input ?? {};
        const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
        events.push({
          type: 'tool-use',
          id: block.id,
          name: block.name,
          target: toolTarget(input, cwd),
          filePath,
          input: toolInputDetail(block.name, input),
          todos: block.name === 'TodoWrite' && Array.isArray(input.todos) ? (input.todos as TodoItem[]) : undefined,
          taskChange: taskChangeOf(block.name, input),
          description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined,
          sentFiles: block.name === 'SendUserFile' ? sentFilesOf(input, cwd) : undefined,
          at,
        });
      }
    });
    return events;
  }

  if (entry.type === 'user' && !entry.isMeta && !entry.isCompactSummary && !entry.isVisibleInTranscriptOnly) {
    const content = entry.message?.content;
    if (typeof content === 'string') return userTextEvents(entry, content);

    const events: ChatEvent[] = [];
    (content ?? []).forEach((block, index) => {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const summary = editSummary(entry.toolUseResult);
        const images = Array.isArray(block.content) ? takeImages(entry, block.content, `r${index}-`, onImage) : [];
        events.push({
          type: 'tool-result',
          id: block.tool_use_id,
          isError: !!block.is_error,
          ...summary,
          patch: patchLines(entry.toolUseResult),
          // Edit・Write は差分を出すので、「更新しました」という結果の文章は載せない。
          // バックグラウンドで起動したもの（Agent・Workflow）の結果は Claude 向けの内部メッセージなので載せない
          output:
            (summary.filePath && !block.is_error) || isAsyncLaunch(entry.toolUseResult)
              ? undefined
              : resultText(block.content, images.length === 0),
          images: images.length > 0 ? images : undefined,
          answers: answersOf(entry.toolUseResult),
          createdTaskId: block.is_error ? undefined : createdTaskIdOf(entry.toolUseResult),
          at,
        });
        const blocked = block.is_error ? blockedByHook(block.tool_use_id, resultText(block.content)) : null;
        if (blocked) events.push({ type: 'hook', id: `${entry.uuid ?? ''}:hook`, run: blocked });
      } else if (block.type === 'text' && block.text) {
        events.push(...userTextEvents(entry, block.text));
      }
    });
    // ユーザーが発言に添付した画像（ツールの結果の行には付けない）
    if (content?.some((b) => b.type === 'tool_result')) return events;
    return withImages(events, entry, takeImages(entry, content ?? [], 'u', onImage));
  }

  return [];
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
  if (last === -1) return [...events, { type: 'user', id: entry.uuid ?? '', text: '', images }];
  return events.map((e, i) => (i === last && e.type === 'user' ? { ...e, images } : e));
}

// Claude の作業中にユーザーが送り、そのターンに差し込まれた発言。user 行ではなく、この attachment だけが残る。
// 同じ形のものでも、サブエージェントの報告（origin が peer）はユーザーの発言ではない。
// CI の自動修正の知らせ（origin なし）は、user 行のときと同じくお知らせとして出す（userTextEvents が見分ける）。
// 出すものでなければ null、発言だが文字が無い（画像だけ）なら ''
function midTurnPromptOf(a: Record<string, unknown> | undefined): string | null {
  if (a?.type !== 'queued_command' || a.commandMode !== 'prompt') return null;
  const origin = (a.origin as { kind?: unknown } | undefined)?.kind;
  if (origin === undefined && typeof a.prompt === 'string' && a.prompt.trimStart().startsWith('<ci-monitor-event>')) return a.prompt;
  if (origin !== 'human') return null;
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

function hookRunOf(a: Record<string, unknown> | undefined): HookRun | null {
  const type = typeof a?.type === 'string' ? a.type : '';
  if (!a || !type.startsWith('hook_')) return null;
  // アプリが足したフックは、ユーザーのフックではないので出さない
  if (typeof a.command === 'string' && a.command.includes(ASK_FILE_ENV)) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const blocking = (a.blockingError ?? null) as { blockingError?: string; command?: string } | null;
  const content = Array.isArray(a.content) ? a.content.map(String).join('\n') : str(a.content);
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

function truncate(text: string, max: number): string {
  const t = text.trimEnd();
  return t.length > max ? `${t.slice(0, max)}\n…（${t.length - max} 文字省略）` : t;
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

// Stop の hooks の要約。出力の無かった hooks もコマンドと所要時間が載る（callback はアプリ内部の hooks なので出さない）
function stopHookEvents(entry: TranscriptEntry): ChatEvent[] {
  const errors = (entry.hookErrors ?? []).map(String);
  return (entry.hookInfos ?? [])
    .filter((h) => h.command && h.command !== 'callback')
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
  const kind = trigger === 'auto' ? '自動で' : '';
  const tokens = preTokens ? `（${Math.round(preTokens / 1000)}k tokens から）` : '';
  return `会話を${kind}圧縮しました${tokens}`;
}

function userTextEvents(entry: TranscriptEntry, text: string): ChatEvent[] {
  if (entry.interruptedMessageId || text.startsWith(INTERRUPTED_PREFIX)) return [{ type: 'turn-end' }];
  const special = specialUserText(entry.uuid ?? '', text.trimStart());
  if (special) return [special];
  if (text.includes('<task-notification>')) {
    const summary = text.match(/<summary>(.*?)<\/summary>/s)?.[1]?.trim();
    return [{ type: 'notice', id: entry.uuid ?? '', text: summary ?? 'バックグラウンドのタスクが終わりました' }];
  }
  // ローカルコマンド（/model など）の出力。ターンは発生しない
  if (text.includes('<local-command-stdout>') || text.includes('<local-command-caveat>')) return [{ type: 'turn-end' }];

  const command = text.match(/<command-name>(.*?)<\/command-name>/s)?.[1];
  // /compact は送った時点の発言と、圧縮後のコマンドの記録の 2 回残る。後者は「会話を圧縮しました」の区切りで表す
  if (command === '/compact') return [];
  if (command) {
    const args = text.match(/<command-args>(.*?)<\/command-args>/s)?.[1]?.trim();
    return [{ type: 'user', id: entry.uuid ?? '', text: args ? `${command} ${args}` : command }];
  }
  return [{ type: 'user', id: entry.uuid ?? '', text: unwrapPasted(text) }];
}

// user 行に入る、ユーザーの発言ではないもの
function specialUserText(id: string, text: string): ChatEvent | null {
  // ! を付けて実行したコマンド。出力は <bash-stdout> / <bash-stderr> に入る
  if (text.startsWith('<bash-input>')) {
    const tag = (name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
    const output = [tag('bash-stdout'), tag('bash-stderr')].map((s) => s.trim()).filter(Boolean).join('\n');
    return { type: 'shell', id, command: tag('bash-input').trim(), output: truncate(output, OUTPUT_CHARS) };
  }
  // 本家アプリの「Auto-fix pull requests」が、PR のレビューコメントや CI の失敗を Claude に知らせる
  if (text.startsWith('<ci-monitor-event>')) {
    const body = text.replace(/^<ci-monitor-event>/, '').replace(/<\/ci-monitor-event>\s*$/, '').trim();
    const pr = body.match(/PR #(\d+)/)?.[1];
    // 2 段落目の最初の文が、何を見つけたか（例: 「… PR #16405 has 1 new review comment (quoted below).」）
    const found = body.split(/\n\s*\n/)[1]?.match(/^.*?\.(?=\s|$)/)?.[0];
    const comments = found?.match(/has (\d+) new review comments?/)?.[1];
    const what = /was just enabled/.test(body)
      ? '有効になりました'
      : comments
        ? `新しいレビューコメント ${comments} 件`
        : (found?.replace(/^\S+ PR #\d+ /, '') ?? '知らせが届きました');
    return { type: 'notice', id, text: `CI の自動修正${pr ? `（PR #${pr}）` : ''}: ${what}`, detail: truncate(body, OUTPUT_CHARS) };
  }
  // スケジュールタスクの起動
  if (text.startsWith('<scheduled-task')) {
    const name = text.match(/^<scheduled-task name="([^"]*)"/)?.[1];
    const body = text.replace(/^<scheduled-task[^>]*>/, '').replace(/<\/scheduled-task>\s*$/, '').trim();
    return { type: 'notice', id, text: `スケジュールタスク${name ? `「${name}」` : ''}の実行`, detail: truncate(body, OUTPUT_CHARS) };
  }
  return null;
}

// 貼り付けた文字は <pasted_content id="…">…</pasted_content id="…"> で囲まれて会話ログに残る
// （アプリは複数行の発言を貼り付けとして送るので、複数行の発言はすべてこの形になる）。表示では囲みを外す
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
  return detail.length > INPUT_CHARS ? `${detail.slice(0, INPUT_CHARS)}\n…（省略）` : detail;
}

// AskUserQuestion の結果（toolUseResult の questions と、質問文から答えへの answers）
function answersOf(result: unknown): QuestionAnswer[] | undefined {
  const r = result as { questions?: { question?: unknown; header?: unknown }[]; answers?: Record<string, unknown> } | null;
  if (!r || !Array.isArray(r.questions) || !r.answers || typeof r.answers !== 'object') return undefined;
  return r.questions.map((q) => {
    const question = typeof q?.question === 'string' ? q.question : '';
    const answer = r.answers![question];
    return { header: typeof q?.header === 'string' ? q.header : '', question, answer: typeof answer === 'string' ? answer : '（回答なし）' };
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
      .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' && withImages ? '[画像]' : ''))
      .join('\n');
  } else return undefined;
  text = text.trim();
  if (!text) return undefined;
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n…（${text.length - OUTPUT_CHARS} 文字省略）` : text;
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
  return lines.length > PATCH_LINES ? [...lines.slice(0, PATCH_LINES), `…（${lines.length - PATCH_LINES} 行省略）`] : lines;
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
    const text = entry.message.content;
    if (text.includes('<local-command-') || text.includes('<command-name>')) return null;
    const firstLine = unwrapPasted(text).trim().split('\n')[0];
    return firstLine ? { title: firstLine.slice(0, 80), priority: 1 } : null;
  }
  return null;
}

export function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  return typeof value === 'object' && value !== null;
}
