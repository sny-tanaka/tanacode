import { expect } from 'vitest';
import { transcriptTitle, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import type { DiscoveredSession } from '@shared/ipc';
import type { SessionKnowledge } from '@shared/knowledge';
import type { SessionContext } from '@shared/context';
import type { StatusLineInfo } from '@shared/statusline';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { Step } from '../cli/mock-api';

// 入力まわりと、まだ確かめていなかった読み取りの台本（test/cli/input.test.ts）と、アプリが読み取れるべきもの。
// - 発言: --effort・会話の最初の /context・複数行と長い発言・札・! で始まる発言・親からの指示・/rename と AI のタイトル
// - 読み取り: @ で添付したファイル・Read・サブフォルダの CLAUDE.md・思考・画像・セッションの一覧
// - バックグラウンド: 実行中のサブエージェントの直近のツールと会話ログ・止めたバックグラウンドの Bash

// 発言の台本 --------------------------------------------------------------

// 起動の引数に付けるエフォート（既定の値とは違うもの）
export const EFFORT = 'low';
// 複数行の発言
export const PASTE = '貼り付けの 1 行目\n2 行目\n3 行目';
export const LONG_PASTE = Array.from({ length: 30 }, (_, i) => `長い貼り付けの ${i + 1} 行目`).join('\n');
// 入力欄の札（貼り付けた長い文）を添えた発言。アプリは、札を発言の文のあとに足して送る（SessionManager.submit の pastes。
// ログインして使う Claude Code は <pasted_content> の囲みに入れる。モックの API で動かすここでは、囲みは付かない）
export const CHIP_TEXT = '次のログを見て、原因を教えてください。';
export const LONG_LINE = `1 行の長い貼り付け ${'x'.repeat(900)}`;
// 長い複数行の発言。stream-json の発言の行で、そのまま送る。TUI の入力欄で意味を持つ文字で始まる行（/ @ ! #）・空行・字下げ・
// コードブロック・絵文字・長い行を混ぜる。どれもコマンドやファイルの指定にならず、そのまま届く
export const LONG_LINES = [
  '長い複数行の発言の 1 行目です。',
  '',
  '/api で始まる行は、コマンドではありません。',
  '@src/main/index.ts で始まる行は、ファイルの指定ではありません。',
  '!ls で始まる行は、シェルのコマンドではありません。',
  '# で始まる行は、見出しのつもりです。',
  '',
  '- 箇条書き  ',
  '  - 入れ子（行末に空白 2 つ）  ',
  '```ts',
  'function f(a: number) {',
  '\treturn `${a}`; // タブで字下げ',
  '}',
  '```',
  '',
  '',
  `${'x'.repeat(299)}🎉${'y'.repeat(350)}👍${'z'.repeat(40)}`,
  ...Array.from({ length: 30 }, (_, i) => `${i + 18} 行目: 長い複数行の発言が、そのまま届くかを確かめる文です。`),
  '最後の行（このあとに改行は無い）',
].join('\n');
const sentences = (count: number, label: string) => Array.from({ length: count }, (_, i) => `これは${label}の ${i + 1} 文めで、途中で欠けずに届くかを確かめます。`).join('');
// 改行なしで 2,000 文字ほどの 1 行（1 段落の長い発言）
export const ONE_LONG_LINE = sentences(60, '改行のない長い段落');
// 複数行の中に、1,500 文字ほどの行が 1 つ
export const LINES_WITH_LONG_LINE = ['長い行を含む発言の 1 行目です。', sentences(48, '途中の長い行'), '', '最後の行です。'].join('\n');
// 親セッションから子への指示の形（見出し・番号付きの手順・箇条書き）
const steps = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}. 手順 ${i + 1}: 該当するファイルを読んで、直すところを洗い出す`);
export const NUMBERED_PROMPT = [
  'あなたは worktree で動く子セッションです。次の作業を 1 件だけ担当します。',
  '',
  '## 進め方',
  ...steps(40),
  '',
  '## 禁止事項',
  '- 担当のファイルのほかは編集しない',
  '- 開発用のサーバーを、決まったポートで起動しない',
  '',
  '終わったら、変えたファイルと確かめた結果を報告してください。',
].join('\n');
// ! で始まる発言。チャットの入力欄では、シェルで動かさず、そのまま Claude への発言として送る
export const SHELL_COMMAND = 'echo tanacode-shell';
export const RENAMED = 'tanacode の確認';
// タイトル作りの呼び出し（ツールの一覧が付いていない）にモックが返す JSON の title
export const AI_TITLE = 'AI が付けたタイトル';
export const AI_TITLE_REPLY = { match: 'Write the title', text: JSON.stringify({ title: AI_TITLE }) };

// --effort を付けて起動したときの、アプリが stream から組み立てた状態（statusLine の代わり）
export function checkEffort(info: StatusLineInfo | null, effort: string): void {
  expect(info?.effort).toBe(effort);
  expect(info?.model).not.toBeNull();
}

// 送った発言は、改行を含めてそのまま 1 つの発言になる（<pasted_content> の囲みや端末の制御文字を残さない）
export function checkPasted(events: ChatEvent[], text: string): void {
  const users = events.filter((e): e is Extract<ChatEvent, { type: 'user' }> => e.type === 'user');
  expect(users.map((e) => e.text)).toContain(text);
  for (const e of users) expect(e.text).not.toMatch(/<\/?pasted_content|\x1b/);
}

// 会話の最初の /context などのローカルのコマンド。-p では、コマンドは user の行（<command-name>）に、出力は system の
// local_command の行（<local-command-stdout>）に残る（TUI では、コマンドも system の local_command の行だった）。
// コマンドは発言として出し、出力や、Claude 向けに書かれた結果（isMeta の user 行）は出さない
export function checkLocalCommand(entries: TranscriptEntry[], events: ChatEvent[], command: string): void {
  const name = `<command-name>${command.split(' ')[0]}</command-name>`;
  const textOf = (e: TranscriptEntry) => (typeof e.message?.content === 'string' ? e.message.content : (e.content ?? ''));
  expect(entries.some((e) => (e.type === 'user' || (e.type === 'system' && e.subtype === 'local_command')) && textOf(e).includes(name))).toBe(true);
  expect(entries.some((e) => e.type === 'system' && e.subtype === 'local_command' && textOf(e).includes('<local-command-stdout>'))).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ type: 'user', text: command }));
  for (const e of events) if (e.type === 'user') expect(e.text).not.toMatch(/<local-command-|<command-name>|^## Context Usage/);
}

// ! で始まる発言は、シェルで動かず、そのまま発言になる（コマンドの行・出力の行にならない）
export function checkBangPrompt(events: ChatEvent[], command: string): void {
  expect(events).toContainEqual(expect.objectContaining({ type: 'user', text: `!${command}` }));
  expect(events.filter((e) => e.type === 'shell' || e.type === 'shell-output')).toEqual([]);
}

// /rename で付けた名前（custom-title）は、ほかのタイトルより優先される
export function checkRenamed(entries: TranscriptEntry[], name: string): void {
  const titles = entries.map(transcriptTitle).filter((t) => t !== null);
  expect(titles).toContainEqual({ title: name, priority: 3 });
  expect(Math.max(...titles.map((t) => t.priority))).toBe(3);
}

// AI が付けたタイトル（ai-title）。/rename の名前よりは下、最初の発言よりは上
export function checkAiTitle(entries: TranscriptEntry[], title: string): void {
  const titles = entries.map(transcriptTitle).filter((t) => t !== null);
  expect(titles).toContainEqual({ title, priority: 2 });
}

// セッションの一覧（アプリの外で作られた会話を ~/.claude/projects から探す）に、会話ログの cwd とタイトルで出る
export function checkDiscovered(found: DiscoveredSession[], claudeSessionId: string, cwd: string, title: string): void {
  expect(found).toContainEqual(expect.objectContaining({ claudeSessionId, cwd, title }));
}

// 読み取りの台本 ----------------------------------------------------------

export const READ_PROMPT = 'ファイルを読んでください';
// 発言に @ で添付するファイル
export const ATTACHED = 'notes.txt';
// Read で読むファイル。サブフォルダに CLAUDE.md があるので、読むと nested_memory として一緒に渡される
export const READ_FILE = 'sub/code.txt';
export const NESTED_MEMORY = 'sub/CLAUDE.md';
export const IMAGE_FILE = 'dot.png';
// 1×1 の png
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
export const THINKING = 'どのファイルから読むか考えています';
export const READ_FILES = { [ATTACHED]: 'メモ\n', [READ_FILE]: 'コード\n', [NESTED_MEMORY]: '# サブフォルダの決まり\n' };

export function readSteps(cwd: string): Step[] {
  return [
    [
      // 実際の思考は末尾に改行が付くことがある
      { type: 'thinking', thinking: `${THINKING}\n` },
      { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: `${cwd}/${READ_FILE}` } },
    ],
    [{ type: 'tool_use', id: 'toolu_image', name: 'Read', input: { file_path: `${cwd}/${IMAGE_FILE}` } }],
    [{ type: 'text', text: '読みました' }],
  ];
}

// KnowledgeTracker が集めた、Claude が知っているファイルとコンテキストの使用量
export function checkKnowledge(knowledge: SessionKnowledge): void {
  for (const file of [ATTACHED, READ_FILE, NESTED_MEMORY, IMAGE_FILE]) expect(knowledge.files[file], file).toBe('read');
  expect(knowledge.contextTokens).toBeGreaterThan(0);
}

// ContextTracker が集めた、コンテキストの中身。添付・Read で読んだファイル（画像も）・サブフォルダの CLAUDE.md がファイルの行に、
// 発言とその応答が発言のやりとりの行になる
export function checkContext(context: SessionContext, prompt: string): void {
  for (const file of [ATTACHED, READ_FILE, NESTED_MEMORY, IMAGE_FILE]) {
    expect(context.items.find((i) => i.label === file), file).toMatchObject({ kind: 'file', compacted: false });
  }
  const topic = context.items.find((i) => i.kind === 'topic' && i.label === prompt);
  expect(topic?.tokens).toBeGreaterThan(0);
  expect(context.items.every((i) => Number.isFinite(i.tokens) && i.tokens >= 0)).toBe(true);
}

// 思考の本文があれば、前後の改行を除いて thinking のイベントになる
export function checkThinking(events: ChatEvent[]): void {
  expect(events).toContainEqual(expect.objectContaining({ type: 'thinking', text: THINKING }));
}

// Read で読んだ画像は、ツールの結果の画像として受け取れる（onImage に中身が届き、イベントには鍵が載る）
export function checkImage(events: ChatEvent[], images: Map<string, string>): void {
  const result = events.find((e): e is Extract<ChatEvent, { type: 'tool-result' }> => e.type === 'tool-result' && e.id === 'toolu_image');
  expect(result).toBeDefined();
  expect(result!.isError).toBe(false);
  expect(result!.images).toHaveLength(1);
  expect(images.get(result!.images![0])).toBe(`data:image/png;base64,${PNG_BASE64}`);
}

// バックグラウンドの台本 ----------------------------------------------------

export const SUBAGENT_PROMPT = 'サブエージェントに頼んでください';
export const AGENT_PROMPT = '入力の確認のサブエージェントです';
export const SUBAGENT_COMMAND = 'echo tanacode-sub';
export const SUBAGENT_RESULT = 'サブエージェントの答え';

export const subagentSteps: Step[] = [
  [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: '確認の手伝い', prompt: AGENT_PROMPT, subagent_type: 'general-purpose' } }],
  [{ type: 'text', text: '頼みました' }],
  // サブエージェントが終わった知らせへの返事
  [{ type: 'text', text: '受け取りました' }],
];

export const agentSteps: Step[] = [
  [{ type: 'tool_use', id: 'toolu_sub_bash', name: 'Bash', input: { command: SUBAGENT_COMMAND, description: 'サブの作業' } }],
  [{ type: 'text', text: SUBAGENT_RESULT }],
];

// 実行中のサブエージェント。会話ログから、直近のツールを読む
export function checkRecent(run: SubagentRun): void {
  expect(run.state).toBe('running');
  expect(run.agentId).toBeTruthy();
  expect(run.recent).toContainEqual({ name: 'Bash', target: SUBAGENT_COMMAND });
}

// サブエージェントの会話ログから作ったチャット（タスクの中身の表示）
export function checkAgentLog(events: ChatEvent[]): void {
  const expected = [
    { type: 'user', text: AGENT_PROMPT },
    { type: 'tool-use', id: 'toolu_sub_bash', name: 'Bash', target: SUBAGENT_COMMAND },
    { type: 'tool-result', id: 'toolu_sub_bash', isError: false, output: expect.stringContaining('tanacode-sub') },
    { type: 'assistant-text', text: SUBAGENT_RESULT },
  ];
  for (const event of expected) expect(events).toContainEqual(expect.objectContaining(event));
}

export const STOP_PROMPT = 'バックグラウンドで待ってください';
export const STOP_AGAIN = '止めてください';
export const LONG_COMMAND = 'sleep 120';

export const stopSteps: Step[] = [
  [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: LONG_COMMAND, description: '長く待つ', run_in_background: true } }],
  [{ type: 'text', text: '待っています' }],
];

// バックグラウンドの Bash を止めるツール。今の Claude Code は TaskStop（task_id）、前は KillShell（shell_id）
export function stopStep(tools: ReadonlySet<string>, taskId: string): Step {
  if (tools.has('TaskStop')) return [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: taskId } }];
  return [{ type: 'tool_use', id: 'toolu_stop', name: 'KillShell', input: { shell_id: taskId } }];
}

// 止めたバックグラウンドの Bash
export function checkKilled(task: BashTask): void {
  expect(task).toMatchObject({ toolUseId: 'toolu_long', command: LONG_COMMAND, state: 'killed' });
  expect(task.endedAt).not.toBeNull();
}
