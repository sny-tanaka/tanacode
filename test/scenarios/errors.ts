import { expect } from 'vitest';
import type { ChatEvent, TranscriptEntry } from '@shared/chat';
import type { ScreenInfo } from '@shared/screen';
import { pulledBackPrompt } from '../../src/main/chat-log';
import type { Conversation } from '../cli/mock-api';

// 失敗や中断の台本（test/cli/errors.test.ts）と、アプリが読み取れるべきもの。
// 中断（Esc）・中断のあとの再開・API エラー・ツールの失敗・hooks で止める・Stop の hooks・Edit の差分。
// 期待値を確かめる関数は、本物の claude を動かす確認と、控えを読む確認の両方から呼べるよう、読み取った結果だけを受け取る

// 応答が何も来ないうちに Esc で中断する発言
export const EARLY_PROMPT = '応答の前に中断します';
// 1 つ目の応答（ツール）のあと、2 つ目の応答を待つ間に Esc で中断する発言
export const WAIT_PROMPT = '応答を待つ間に中断します';
// ツールの実行中に Esc で中断する発言
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
// ツールの失敗・hooks で止める・Write と Edit
export const TOOLS_PROMPT = 'ツールの失敗と差分を試してください';
export const TOOLS_REPLY = 'ツールの確認が終わりました';

// PreToolUse の hooks。コマンドに tanacode-forbidden を含む Bash を exit 2 で止める（理由は標準エラーに書く）。
// コマンドに [ ] を入れて、止めた理由の行（「…hook error: [コマンド]: 理由」）からコマンドを読めるかも確かめる
export const BLOCK_HOOK = 'if [ -n "$(grep tanacode-forbidden)" ]; then echo "禁止のコマンドです" >&2; exit 2; fi';
export const BLOCK_REASON = '禁止のコマンドです';
// Stop の hooks。何も出力しないので、記録は stop_hook_summary の行だけになる
export const STOP_HOOK = 'cat > /dev/null';
export const SETTINGS = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: BLOCK_HOOK }] }],
    Stop: [{ hooks: [{ type: 'command', command: STOP_HOOK }] }],
  },
};

// Write で作り、Edit で書き換えるファイル
export const NOTES = 'notes.txt';
const NOTES_BEFORE = 'one\ntwo\nthree\nfour\n';
export const NOTES_AFTER = 'one\ntwo\nTHREE\nthree-and-half\nfour\n';

// モックの API の台本。WORK は作業フォルダに置き換える
const CONVERSATIONS: Conversation[] = [
  // 応答を返すまで長く待つ（その間に Esc で中断する）
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
  {
    match: TOOLS_PROMPT,
    steps: [
      [{ type: 'tool_use', id: 'toolu_fail', name: 'Bash', input: { command: 'echo tanacode-fail && exit 3', description: '失敗するコマンド' } }],
      [{ type: 'tool_use', id: 'toolu_blocked', name: 'Bash', input: { command: 'echo tanacode-forbidden', description: '止められるコマンド' } }],
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

// 中断の行（[Request interrupted by user…]）か、ターンの終わりの行があるか
const ended = (events: ChatEvent[]) => events.some((e) => e.type === 'turn-end');

// 応答の前に Esc で中断したあとの入力欄。Claude Code は、中断した発言を入力欄に戻す
export function checkEarlyDraft(info: Pick<ScreenInfo, 'state' | 'draft'>): void {
  expect(info.state.kind).toBe('prompt');
  expect(info.draft).toBe(EARLY_PROMPT);
}

// 応答の前に Esc で中断したあとのチャット。発言は出たが、ターンは終わる。
// Claude Code は発言を入力欄に戻すだけで、会話ログには何も書かない。アプリ（session-manager）は、入力欄に戻った文字が
// 応答の無い最後の発言と同じなのを見て（pulledBackPrompt）、発言の表示を取り消してターンを終える
export function checkEarlyInterrupt(events: ChatEvent[], draft: string): void {
  const start = events.findIndex((e) => e.type === 'user' && e.text === EARLY_PROMPT);
  expect(start).not.toBe(-1);
  if (ended(events.slice(start))) return;
  expect(pulledBackPrompt(events, draft)).toBe(start);
}

// 2 つ目の応答を待つ間に Esc で中断したあとのチャット。1 つ目のツールは終わり、中断の行でターンが終わる
export function checkWaitInterrupt(entries: TranscriptEntry[], events: ChatEvent[]): void {
  const expected = [
    { type: 'user', text: WAIT_PROMPT },
    { type: 'tool-use', id: 'toolu_wait', name: 'Bash', description: '待つ前のコマンド' },
    { type: 'tool-result', id: 'toolu_wait', isError: false, output: 'tanacode-wait' },
    { type: 'turn-end' },
  ];
  expect(events).toEqual(expected.map((e) => expect.objectContaining(e)));
  expect(entries.some(isInterruption)).toBe(true);
}

// ツールの実行中に Esc で中断したあとのチャット。ツールは失敗（中断）になり、中断の行でターンが終わる
export function checkToolInterrupt(entries: TranscriptEntry[], events: ChatEvent[]): void {
  const expected = [
    { type: 'user', text: TOOL_PROMPT },
    { type: 'tool-use', id: 'toolu_long', name: 'Bash', description: '長く動くコマンド' },
    { type: 'tool-result', id: 'toolu_long', isError: true },
    { type: 'turn-end' },
  ];
  expect(events).toEqual(expected.map((e) => expect.objectContaining(e)));
  expect(entries.some(isInterruption)).toBe(true);
}

// 中断のあと、入力欄に戻った（中断した発言は戻らない）
export function checkPromptBack(info: Pick<ScreenInfo, 'state' | 'draft'>): void {
  expect(info.state.kind).toBe('prompt');
  expect(info.draft).toBe('');
}

function isInterruption(entry: TranscriptEntry): boolean {
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content : (content ?? []).map((b) => b.text ?? '').join('');
  return entry.type === 'user' && !!entry.interruptedMessageId && text.startsWith('[Request interrupted by user');
}

// 中断した会話を --resume で再開したあと。
// history: 読み直した過去の行から作ったイベント。中断したターンは終わったものとして読む（作業中にしない）。
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
  expect(events.at(-1)).toEqual({ type: 'turn-end' });
}

// 529 を返し続けて、再試行をあきらめたあと（isApiErrorMessage の行）
export function checkOverloaded(events: ChatEvent[]): void {
  const errors = events.filter((e) => e.type === 'api-error' && !e.retrying);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ text: expect.stringMatching(/529|overloaded/i) });
  expect(events.some((e) => e.type === 'assistant-text')).toBe(false);
  expect(events.at(-1)).toEqual({ type: 'turn-end' });
}

// 400 を返したあと（再試行しないエラー。isApiErrorMessage の行）
export function checkBadRequest(events: ChatEvent[]): void {
  const errors = events.filter((e) => e.type === 'api-error');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ retrying: false, text: expect.stringContaining('400') });
  expect(errors[0]).toMatchObject({ text: expect.stringContaining(BAD_REQUEST_MESSAGE) });
  expect(events.some((e) => e.type === 'assistant-text')).toBe(false);
  expect(events.at(-1)).toEqual({ type: 'turn-end' });
}

// ツールの失敗・hooks で止めたツール・Write と Edit の差分・Stop の hooks
export function checkToolErrors(events: ChatEvent[], cwd: string): void {
  const file = `${cwd}/${NOTES}`;
  const expected = [
    { type: 'user', text: TOOLS_PROMPT },
    { type: 'tool-use', id: 'toolu_fail', name: 'Bash', description: '失敗するコマンド' },
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
    { type: 'turn-end' },
  ];
  // この順に出る（あいだにほかのイベントがあってもよい）
  let at = 0;
  for (const event of expected) {
    const found = events.findIndex((e, i) => i >= at && expect.objectContaining(event).asymmetricMatch(e));
    expect(found, JSON.stringify(event)).not.toBe(-1);
    at = found + 1;
  }
}
