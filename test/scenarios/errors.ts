import { expect } from 'vitest';
import type { ChatEvent, TranscriptEntry } from '@shared/chat';
import type { ChatBatch } from '@shared/ipc';
import type { Conversation } from '../cli/mock-api';

// 失敗や中断の台本（test/cli/errors.test.ts）と、アプリが読み取れるべきもの。
// 中断（stream-json の interrupt）・中断のあとの再開・API エラー・ツールの失敗・hooks で止める・Stop の hooks・Edit の差分。
// 期待値を確かめる関数は、読み取った結果（チャットのイベント・会話ログの行）だけを受け取る

// 応答が何も来ないうちに中断する発言
export const EARLY_PROMPT = '応答の前に中断します';
// 1 つ目の応答（ツール）のあと、2 つ目の応答を待つ間に中断する発言
export const WAIT_PROMPT = '応答を待つ間に中断します';
// ツールの実行中に中断する発言
export const TOOL_PROMPT = 'ツールの実行中に中断します';
// 中断した会話を --resume で再開してから送る発言と、その返事
export const RESUME_PROMPT = '中断のあとで再開しました';
export const RESUME_REPLY = '再開後の返事';
// API エラー: 一度だけ 529 を返してから応答する / 529 を返し続ける / 400 を返す
export const RETRY_PROMPT = '一度だけ混み合います';
export const RETRY_REPLY = '再試行で届いた返事';
export const OVERLOADED_PROMPT = 'ずっと混み合います';
export const BAD_REQUEST_PROMPT = '不正なリクエストになります';
export const BAD_REQUEST_MESSAGE = 'テストの不正なリクエストです';
// 書いている途中で接続が切れる発言と、切れる前の書きかけの文・取り直した返事
export const CUT_PROMPT = '書いている途中で接続が切れます';
export const CUT_DRAFT = '書きかけの文です。これは取り消されるはず';
export const CUT_REPLY = '取り直した返事';
// ツールの呼び出しの形が壊れた応答を返す発言と、取り消される応答の文・取り直した返事
export const MALFORMED_PROMPT = 'ツールの呼び出しの形が壊れます';
export const MALFORMED_DRAFT = '形の壊れた応答です。これは取り消されるはず';
export const MALFORMED_REPLY = '形を直して届いた返事';
// ツールの失敗・hooks で止める・Write と Edit
export const TOOLS_PROMPT = 'ツールの失敗と差分を試してください';
export const TOOLS_REPLY = 'ツールの確認が終わりました';

// PreToolUse の hooks。コマンドに tanacode-forbidden を含む Bash を exit 2 で止める（理由は標準エラーに書く）。
// コマンドに [ ] を入れて、止めた理由の行（「…hook error: [コマンド]: 理由」）からコマンドを読めるかも確かめる
export const BLOCK_HOOK = 'if [ -n "$(grep tanacode-forbidden)" ]; then echo "禁止のコマンドです" >&2; exit 2; fi';
export const BLOCK_REASON = '禁止のコマンドです';
// PostToolUse の hooks。コマンドに tanacode-post-block を含む Bash のあとで exit 2 する。ツールはもう動いたあとなので、
// 止めた理由が Claude に渡り、会話ログには hook_blocking_error の attachment が書かれる（PreToolUse で止めたときは書かれない）
export const POST_BLOCK_HOOK = 'if [ -n "$(grep tanacode-post-block)" ]; then echo "あとから止めました" >&2; exit 2; fi';
export const POST_BLOCK_REASON = 'あとから止めました';
// Stop の hooks。何も出力しないので、記録は stop_hook_summary の行だけになる
export const STOP_HOOK = 'cat > /dev/null';
export const SETTINGS = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: BLOCK_HOOK }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: POST_BLOCK_HOOK }] }],
    Stop: [{ hooks: [{ type: 'command', command: STOP_HOOK }] }],
  },
};

// Write で作り、Edit で書き換えるファイル
export const NOTES = 'notes.txt';
const NOTES_BEFORE = 'one\ntwo\nthree\nfour\n';
export const NOTES_AFTER = 'one\ntwo\nTHREE\nthree-and-half\nfour\n';

// モックの API の台本。WORK は作業フォルダに置き換える
const CONVERSATIONS: Conversation[] = [
  // 応答を返すまで長く待つ（その間に中断する）
  { match: EARLY_PROMPT, delayMs: 15_000, steps: [[{ type: 'text', text: '届かない返事' }]] },
  // どの応答も遅らせる。1 つ目のツール（echo は確認なしで動く）の結果を見てから、2 つ目を待つ間に中断する
  {
    match: WAIT_PROMPT,
    delayMs: 4000,
    steps: [
      [{ type: 'tool_use', id: 'toolu_wait', name: 'Bash', input: { command: 'echo tanacode-wait', description: '待つ前のコマンド' } }],
      [{ type: 'text', text: '届かない返事' }],
    ],
  },
  // 長く動くコマンドの途中で中断する。再開したあとの発言には、Claude Code が差し込む <synthetic> の応答の数だけずれた番号で
  // 届くので、どちらにも同じ返事を置く
  {
    match: TOOL_PROMPT,
    steps: [
      [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'sleep 30 && touch interrupted.txt', description: '長く動くコマンド' } }],
      [{ type: 'text', text: RESUME_REPLY }],
      [{ type: 'text', text: RESUME_REPLY }],
    ],
  },
  {
    match: RETRY_PROMPT,
    failures: { 0: { status: 529, errorType: 'overloaded_error', message: 'Overloaded', times: 1 } },
    steps: [[{ type: 'text', text: RETRY_REPLY }]],
  },
  {
    match: OVERLOADED_PROMPT,
    failures: { 0: { status: 529, errorType: 'overloaded_error', message: 'Overloaded' } },
    steps: [[{ type: 'text', text: '届かない返事' }]],
  },
  {
    match: BAD_REQUEST_PROMPT,
    failures: { 0: { status: 400, errorType: 'invalid_request_error', message: BAD_REQUEST_MESSAGE } },
    steps: [[{ type: 'text', text: '届かない返事' }]],
  },
  // 1 回目のストリーミングを、書いている途中で切る（Claude Code は取り直す）
  { match: CUT_PROMPT, cuts: { 0: { text: CUT_DRAFT, times: 1 } }, steps: [[{ type: 'text', text: CUT_REPLY }]] },
  // 1 回目は、ツールを呼ばないのに stop_reason が tool_use の応答（Claude Code は取り消して、形を直すよう頼んで取り直す）
  { match: MALFORMED_PROMPT, malformed: { 0: { text: MALFORMED_DRAFT, times: 1 } }, steps: [[{ type: 'text', text: MALFORMED_REPLY }]] },
  {
    match: TOOLS_PROMPT,
    steps: [
      [{ type: 'tool_use', id: 'toolu_fail', name: 'Bash', input: { command: 'echo tanacode-fail && exit 3', description: '失敗するコマンド' } }],
      [{ type: 'tool_use', id: 'toolu_blocked', name: 'Bash', input: { command: 'echo tanacode-forbidden', description: '止められるコマンド' } }],
      [{ type: 'tool_use', id: 'toolu_post_blocked', name: 'Bash', input: { command: 'echo tanacode-post-block', description: 'あとから止められるコマンド' } }],
      [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: `WORK/${NOTES}`, content: NOTES_BEFORE } }],
      [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: `WORK/${NOTES}`, old_string: 'three', new_string: 'THREE\nthree-and-half' } }],
      [{ type: 'text', text: TOOLS_REPLY }],
    ],
  },
];

export function conversationsFor(cwd: string): Conversation[] {
  return JSON.parse(JSON.stringify(CONVERSATIONS).replaceAll('WORK', cwd)) as Conversation[];
}

// API エラーの再試行を短くする（既定では 10 回まで、待ち時間を延ばしながら再試行する）
export const ENV = { CLAUDE_CODE_MAX_RETRIES: '2' };

// 会話の流れ（発言・応答・ツール・ターンの終わり）だけにする。送信中・順番待ちの表示や、状態の知らせを除く
const TALK = new Set<ChatEvent['type']>(['user', 'assistant-text', 'tool-use', 'tool-result', 'turn-end']);
const talk = (events: ChatEvent[]) => events.filter((e) => TALK.has(e.type));

// 応答の前に中断したあとのチャット。stream-json では、発言は会話に残り（入力欄には戻らない）、中断でターンが終わる
export function checkEarlyInterrupt(entries: TranscriptEntry[], events: ChatEvent[]): void {
  expect(talk(events)).toEqual([expect.objectContaining({ type: 'user', text: EARLY_PROMPT }), { type: 'turn-end', interrupted: true }]);
  expect(entries.some(isInterruption)).toBe(true);
}

// 2 つ目の応答を待つ間に中断したあとのチャット。1 つ目のツールは終わり、中断でターンが終わる
export function checkWaitInterrupt(entries: TranscriptEntry[], events: ChatEvent[]): void {
  const expected = [
    { type: 'user', text: WAIT_PROMPT },
    { type: 'tool-use', id: 'toolu_wait', name: 'Bash', description: '待つ前のコマンド' },
    { type: 'tool-result', id: 'toolu_wait', isError: false, output: 'tanacode-wait' },
    { type: 'turn-end', interrupted: true },
  ];
  expect(talk(events)).toEqual(expected.map((e) => expect.objectContaining(e)));
  expect(entries.some(isInterruption)).toBe(true);
}

// ツールの実行中に中断したあとのチャット。ツールは失敗（中断）になり、中断でターンが終わる
export function checkToolInterrupt(entries: TranscriptEntry[], events: ChatEvent[]): void {
  const expected = [
    { type: 'user', text: TOOL_PROMPT },
    { type: 'tool-use', id: 'toolu_long', name: 'Bash', description: '長く動くコマンド' },
    { type: 'tool-result', id: 'toolu_long', isError: true },
    { type: 'turn-end', interrupted: true },
  ];
  expect(talk(events)).toEqual(expected.map((e) => expect.objectContaining(e)));
  expect(entries.some(isInterruption)).toBe(true);
}

// 中断の行（-p では TUI と違い interruptedMessageId が付かない。実測 2.1.296）
function isInterruption(entry: TranscriptEntry): boolean {
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content : (content ?? []).map((b) => b.text ?? '').join('');
  return entry.type === 'user' && text.startsWith('[Request interrupted by user');
}

// 中断した会話を --resume で再開したあと。
// history: 読み直した過去の行から作ったチャット。中断したターンは終わったものとして読む（作業中にしない）。
// entries / events: 再開してからの行とイベント。Claude Code は、中断したターンの埋め合わせに <synthetic> の応答を差し込むが、
// チャットには出さない
export function checkResumed(history: ChatEvent[], entries: TranscriptEntry[], events: ChatEvent[]): void {
  const turns = history.filter((e) => e.type === 'user' || e.type === 'turn-end');
  expect(turns.at(-1)?.type).toBe('turn-end');
  const synthetic = entries.filter((e) => e.type === 'assistant' && e.message?.model === '<synthetic>');
  expect(synthetic.length).toBeGreaterThan(0);
  expect(events.filter((e) => e.type === 'assistant-text').map((e) => (e as { text: string }).text)).toEqual([RESUME_REPLY]);
  const expected = [{ type: 'user', text: RESUME_PROMPT }, { type: 'assistant-text', text: RESUME_REPLY }, { type: 'turn-end' }];
  for (const event of expected) expect(events).toContainEqual(expect.objectContaining(event));
}

// 一度だけ 529 を返して再試行させたあと。返事が届き、エラーは残らない
// （再試行中の api_error の行は、出ても再試行中のものだけ。今の Claude Code は会話ログに書かない）
export function checkRetried(events: ChatEvent[]): void {
  expect(events).toContainEqual(expect.objectContaining({ type: 'assistant-text', text: RETRY_REPLY }));
  for (const e of events.filter((e) => e.type === 'api-error')) expect(e).toMatchObject({ retrying: true, text: expect.stringMatching(/529|overloaded/i) });
  expect(talk(events).at(-1)).toEqual({ type: 'turn-end' });
}

// 529 を返し続けて、再試行をあきらめたあと（isApiErrorMessage の行）
export function checkOverloaded(events: ChatEvent[]): void {
  const errors = events.filter((e) => e.type === 'api-error' && !e.retrying);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ text: expect.stringMatching(/529|overloaded/i) });
  expect(events.some((e) => e.type === 'assistant-text')).toBe(false);
  expect(talk(events).at(-1)).toEqual({ type: 'turn-end' });
}

// 400 を返したあと（再試行しないエラー。isApiErrorMessage の行）
export function checkBadRequest(events: ChatEvent[]): void {
  const errors = events.filter((e) => e.type === 'api-error');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ retrying: false, text: expect.stringContaining('400') });
  expect(errors[0]).toMatchObject({ text: expect.stringContaining(BAD_REQUEST_MESSAGE) });
  expect(events.some((e) => e.type === 'assistant-text')).toBe(false);
  expect(talk(events).at(-1)).toEqual({ type: 'turn-end' });
}

// 取り消された応答を取り直したあと（#233）。batches: 発言を送ってからの配信。取り消された応答の文は、取り直した返事が
// チャットに出るまでに、書いている途中の文から外れる（ターンの終わりまで残らない）。返すのは、取り直した返事が出た配信の位置
function checkPartialRetracted(batches: ChatBatch[], draft: string, reply: string): number {
  const answered = batches.findIndex((b) => b.events.some((e) => e.type === 'assistant-text' && e.text === reply));
  expect(answered, '取り直した返事が出る').toBeGreaterThanOrEqual(0);
  // 配信は、書いている途中の文が変わったときだけ、その全部を持つ。取り直した返事が出たときに出ていたものと、そのあとに出たもの
  const then = batches.slice(0, answered + 1).reverse().find((b) => b.partial)?.partial ?? [];
  const later = batches.slice(answered + 1).flatMap((b) => b.partial ?? []);
  expect([...then, ...later].map((b) => b.text), '取り直した返事が出るまでに外れる（ターンの終わりまで残らない）').not.toContain(draft);
  return answered;
}

// 書いている途中で接続が切れて、取り直したあと。events: 今の台本のチャット。書きかけは、書いている途中の文として一度出てから外れる。
// 書きかけは会話ログに出ないので、チャットに残るのは取り直した返事だけ
export function checkCut(batches: ChatBatch[], events: ChatEvent[]): void {
  const answered = checkPartialRetracted(batches, CUT_DRAFT, CUT_REPLY);
  const shown = batches.findIndex((b) => b.partial?.some((p) => p.text === CUT_DRAFT));
  expect(shown, '書きかけの文が、書いている途中の文として出る').toBeGreaterThanOrEqual(0);
  expect(shown).toBeLessThan(answered);
  const expected = [{ type: 'user', text: CUT_PROMPT }, { type: 'assistant-text', text: CUT_REPLY }, { type: 'turn-end' }];
  expect(talk(events)).toEqual(expected.map((e) => expect.objectContaining(e)));
}

// ツールの呼び出しの形が壊れた応答を、Claude Code が取り消して（tombstone。abandoned_blocks は付かない）取り直したあと。
// 取り消された応答は、会話ログにいったん書かれてから消される（2.1.302 で実測）。消される前に読んだ行も、チャットには残らない（#240）。
// 書いている途中の文にも残らない
export function checkMalformed(batches: ChatBatch[], events: ChatEvent[]): void {
  checkPartialRetracted(batches, MALFORMED_DRAFT, MALFORMED_REPLY);
  checkMalformedTalk(events);
}
// events: 今の台本のチャット（配信したもの・会話ログから作り直したもの）。取り直した返事だけが残る
export function checkMalformedTalk(events: ChatEvent[]): void {
  const expected = [{ type: 'user', text: MALFORMED_PROMPT }, { type: 'assistant-text', text: MALFORMED_REPLY }, { type: 'turn-end' }];
  expect(talk(events)).toEqual(expected.map((e) => expect.objectContaining(e)));
}

// ツールの失敗・hooks で止めたツール・Write と Edit の差分・Stop の hooks
export function checkToolErrors(events: ChatEvent[], cwd: string): void {
  const file = `${cwd}/${NOTES}`;
  const expected = [
    { type: 'user', text: TOOLS_PROMPT },
    { type: 'tool-use', id: 'toolu_fail', name: 'Bash', description: '失敗するコマンド' },
    // 止めなかった（何も出力しなかった）PreToolUse の hooks は、会話ログに残らない。stream の hook_response から、ツールのカードに付ける
    // （コマンドは知らされないので、出来事の名前で出る）
    { type: 'hook', run: expect.objectContaining({ event: 'PreToolUse', name: 'PreToolUse:Bash', command: null, outcome: 'success', toolUseId: 'toolu_fail' }) },
    { type: 'tool-result', id: 'toolu_fail', isError: true, output: expect.stringMatching(/Exit code 3[\s\S]*tanacode-fail/) },
    { type: 'tool-use', id: 'toolu_blocked', name: 'Bash' },
    { type: 'tool-result', id: 'toolu_blocked', isError: true, output: expect.stringContaining(BLOCK_REASON) },
    {
      type: 'hook',
      run: expect.objectContaining({
        event: 'PreToolUse',
        name: 'PreToolUse:Bash',
        command: BLOCK_HOOK,
        outcome: 'blocked',
        message: BLOCK_REASON,
        toolUseId: 'toolu_blocked',
      }),
    },
    // PostToolUse の hooks で止めたときは、ツールは動いたあと。hook_blocking_error の attachment から、止めた hooks が出る
    { type: 'tool-use', id: 'toolu_post_blocked', name: 'Bash' },
    {
      type: 'hook',
      run: expect.objectContaining({
        event: 'PostToolUse',
        name: 'PostToolUse:Bash',
        command: POST_BLOCK_HOOK,
        outcome: 'blocked',
        message: expect.stringContaining(POST_BLOCK_REASON),
        toolUseId: 'toolu_post_blocked',
      }),
    },
    { type: 'tool-use', id: 'toolu_write', name: 'Write', filePath: file, target: NOTES },
    // Write で作ったファイルは、中身をすべて足した行の差分になる
    {
      type: 'tool-result',
      id: 'toolu_write',
      isError: false,
      filePath: file,
      added: 4,
      removed: 0,
      line: 1,
      patch: ['+one', '+two', '+three', '+four'],
      output: undefined,
    },
    { type: 'tool-use', id: 'toolu_edit', name: 'Edit', filePath: file, target: NOTES },
    // Edit は structuredPatch の hunk から。line は前後の変わらない行を飛ばした、最初に変わった行
    {
      type: 'tool-result',
      id: 'toolu_edit',
      isError: false,
      filePath: file,
      added: 2,
      removed: 1,
      line: 3,
      patch: ['@@ -1,4 +1,5 @@', ' one', ' two', '-three', '+THREE', '+three-and-half', ' four'],
      output: undefined,
    },
    { type: 'assistant-text', text: TOOLS_REPLY },
    // 出力の無かった Stop の hooks も、stop_hook_summary から出る
    { type: 'hook', run: expect.objectContaining({ event: 'Stop', name: 'Stop', command: STOP_HOOK, outcome: 'success' }) },
  ];
  // この順に出る（あいだにほかのイベントがあってもよい）
  let at = 0;
  for (const event of expected) {
    const found = events.findIndex((e, i) => i >= at && expect.objectContaining(event).asymmetricMatch(e));
    expect(found, JSON.stringify(event)).not.toBe(-1);
    at = found + 1;
  }
  // ターンの終わり（result から）は、返事のあとに出る。Stop の hooks の行（会話ログから）とは、どちらが先に届くかが決まらない
  // （ターンの終わりはチャットに項目を足さないので、画面の並びは変わらない）
  const reply = events.findIndex((e) => e.type === 'assistant-text' && e.text === TOOLS_REPLY);
  expect(events.slice(reply)).toContainEqual({ type: 'turn-end' });
}
