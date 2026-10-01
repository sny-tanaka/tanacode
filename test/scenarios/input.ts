import { expect } from 'vitest';
import { transcriptTitle, type ChatEvent, type TranscriptEntry } from '@shared/chat';
import type { DiscoveredSession } from '@shared/ipc';
import type { SessionKnowledge } from '@shared/knowledge';
import type { ScreenInfo } from '@shared/screen';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { Step } from '../cli/mock-api';

// 入力まわりと、まだ確かめていなかった読み取りの台本（test/cli/input.test.ts）と、アプリが読み取れるべきもの。
// - 入力欄: 書きかけ・--effort の表示・会話の最初の /context・複数行の貼り付け・! のコマンド・/rename と AI のタイトル
// - 読み取り: @ で添付したファイル・Read・サブフォルダの CLAUDE.md・思考・画像・セッションの一覧
// - バックグラウンド: 実行中のサブエージェントの直近のツールと会話ログ・止めたバックグラウンドの Bash

// 入力欄の台本 ------------------------------------------------------------

// 起動の引数に付けるエフォート（既定の値とは違うもの）
export const EFFORT = 'low';
// 打つだけで送らない文字（全角の文字も入れる）
export const DRAFT = '書きかけの文 abc';
// 複数行の貼り付け。短いものは入力欄にそのまま出て、長いものは [Pasted text #1 +29 lines] の目印になる
export const PASTE = '貼り付けの 1 行目\n2 行目\n3 行目';
export const LONG_PASTE = Array.from({ length: 30 }, (_, i) => `長い貼り付けの ${i + 1} 行目`).join('\n');
// 入力欄で ! を付けて実行するコマンドと、その出力
export const SHELL_COMMAND = 'echo tanacode-shell';
export const SHELL_OUTPUT = 'tanacode-shell';
export const RENAMED = 'tanacode の確認';
// タイトル作りの呼び出し（ツールの一覧が付いていない）にモックが返す JSON の title
export const AI_TITLE = 'AI が付けたタイトル';
export const AI_TITLE_REPLY = { match: 'Write the title', text: JSON.stringify({ title: AI_TITLE }) };

// --effort を付けて起動したときの入力欄のまわり。エフォートは入力欄の上の表示から、モデル名はバナーから読む
// （バナーは「Opus 5.5 with low effort · …」になる）
export function checkEffort(info: Pick<ScreenInfo, 'effort' | 'model'>, effort: string): void {
  expect(info.effort).toBe(effort);
  expect(info.model).toMatch(/^[A-Z][a-z]+ \d+(?:\.\d+)?(?: \(1M context\))?$/);
}

// 入力欄の書きかけ（送っていない文字）。前後の空白と、先頭の「❯ 」は含めない
export function checkDraft(info: Pick<ScreenInfo, 'state' | 'draft'>, typed: string): void {
  expect(info.state.kind).toBe('prompt');
  expect(info.draft).toBe(typed);
}

// 長い貼り付けは入力欄で目印になる（ClaudePane は、この目印を除いて送った文字と比べる）
export function checkPastedDraft(info: Pick<ScreenInfo, 'state' | 'draft'>, lines: number): void {
  expect(info.state.kind).toBe('prompt');
  expect(info.draft).toMatch(new RegExp(`^\\[Pasted text #\\d+ \\+${lines - 1} lines\\]$`));
}

// 貼り付けた発言は、改行を含めてそのまま 1 つの発言になる（<pasted_content> の囲みや端末の制御文字を残さない）
export function checkPasted(events: ChatEvent[], text: string): void {
  const users = events.filter((e): e is Extract<ChatEvent, { type: 'user' }> => e.type === 'user');
  expect(users.map((e) => e.text)).toContain(text);
  for (const e of users) expect(e.text).not.toMatch(/<\/?pasted_content|\x1b/);
}

// 会話の最初の /context などのローカルのコマンドは、system の local_command の行に残る。
// コマンドは発言として出し、出力（<local-command-stdout>）や、Claude 向けに書かれた結果（isMeta の user 行）は出さない
export function checkLocalCommand(entries: TranscriptEntry[], events: ChatEvent[], command: string): void {
  expect(entries.some((e) => e.type === 'system' && e.subtype === 'local_command' && e.content?.includes(`<command-name>${command.split(' ')[0]}</command-name>`))).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ type: 'user', text: command }));
  for (const e of events) if (e.type === 'user') expect(e.text).not.toMatch(/<local-command-|<command-name>|^## Context Usage/);
}

// ! のコマンド。コマンドと出力は別の user 行に分かれて残る（<bash-input> と <bash-stdout>）。
// shell のイベントになり、出力のタグを発言として出さない
export function checkShell(events: ChatEvent[], command: string, output: string): void {
  expect(events).toContainEqual(expect.objectContaining({ type: 'shell', command }));
  const outputs = events.flatMap((e) => (e.type === 'shell' || e.type === 'shell-output' ? [e.output] : []));
  expect(outputs.join('\n')).toContain(output);
  for (const e of events) if (e.type === 'user') expect(e.text).not.toMatch(/<\/?bash-(?:input|stdout|stderr)>/);
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
      { type: 'thinking', thinking: THINKING },
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

// 思考の本文があれば、thinking のイベントになる
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
