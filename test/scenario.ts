import { join } from 'node:path';
import { expect } from 'vitest';
import type { ChatEvent, TranscriptEntry } from '@shared/chat';
import type { PendingPermission, PendingQuestion } from '@shared/questions';
import { EFFORTS } from '@shared/session-tools';
import type { StatusLineInfo } from '@shared/statusline';
import type { Step } from './cli/mock-api';

// Claude Code との互換性を確かめる台本と、アプリが読み取れるべきもの。
// 本物の claude を動かす確認（test/cli）と、画面からの確認（E2E）で共有する。
// 台本: 発言 → Bash を実行（許可の確認）→ AskUserQuestion で質問 → Write でファイルを作る（許可の確認）→ 文章で返事。
// ユーザーの設定に、Bash のあとに動く hooks（PostToolUse）を入れておく

// 控えに書くときの、使い捨てのフォルダのパス（実行のたびに変わるので決まったものに置き換える）
export const FIXTURE_ROOT = '/tmp/tanacode-cli';

export const PROMPT = '確認を始めてください';

// ユーザーの設定（~/.claude/settings.json）。何か出力する hooks だけが会話ログに残る
export const HOOK_COMMAND = 'echo tanacode-hook';
export const SETTINGS = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } };

export const QUESTION = {
  question: 'どちらの書き方にしますか？',
  header: '書き方',
  multiSelect: false,
  options: [
    { label: 'です・ます', description: '丁寧な書き方' },
    { label: 'だ・である', description: '言い切る書き方' },
  ],
};

// モックの API が返す応答。WORK は作業フォルダに置き換える
const STEPS: Step[] = [
  [
    { type: 'text', text: 'コマンドを実行します。' },
    // echo だけだと読むだけのコマンドとして確認なしで動くので、フォルダも作る
    { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'mkdir checked && echo tanacode-check', description: '確認のフォルダを作る' } },
  ],
  [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [QUESTION] } }],
  [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: 'WORK/hello.txt', content: 'こんにちは\n' } }],
  [{ type: 'text', text: 'チェック完了' }],
];

export function stepsFor(cwd: string): Step[] {
  return JSON.parse(JSON.stringify(STEPS).replaceAll('WORK', cwd)) as Step[];
}

// /rewind で戻す先の発言（session.test.ts）
export const REWOUND = '再開して続けてください';

// ワークフローを始める前の確認（stream-json の can_use_tool。ツールは Workflow）
export function checkWorkflowApproval(permission: PendingPermission | null): void {
  expect(permission?.tool).toBe('Workflow');
  expect(permission!.humanOnly).toBeFalsy();
}

// target: 確認の見出し・説明か、ツールの入力（実行しようとしているコマンドなど）に出るはずの文字
export function checkPermission(permission: PendingPermission | null, tool: string, target: string): void {
  expect(permission?.tool).toBe(tool);
  expect([permission!.title, permission!.description, JSON.stringify(permission!.input)].join('\n')).toContain(target);
}

// AskUserQuestion の質問（stream-json の can_use_tool の入力から読んだもの）
export function checkQuestion(question: PendingQuestion | null): void {
  expect(question?.questions).toEqual([{ ...QUESTION, options: QUESTION.options.map((o) => ({ ...o, preview: undefined })) }]);
}

// turnEnd: ターンの終わりも求めるか（-p の会話ログには turn_duration の行が無いので、会話ログだけから組み立てたチャットには出ない）
export function checkChat(entries: TranscriptEntry[], events: ChatEvent[], cwd: string, { turnEnd = true } = {}): void {
  // 画面のモデル名は、会話ログの応答のモデル（session-manager の modelOf）から取る
  expect(entries.find((e) => e.type === 'assistant')?.message?.model).toMatch(/^claude-[a-z]+-\d/);
  const file = join(cwd, 'hello.txt');
  const expected = [
    { type: 'user', text: PROMPT },
    { type: 'assistant-text', text: 'コマンドを実行します。' },
    { type: 'tool-use', id: 'toolu_bash', name: 'Bash', description: '確認のフォルダを作る' },
    { type: 'tool-result', id: 'toolu_bash', isError: false, output: expect.stringContaining('tanacode-check') },
    { type: 'hook', run: expect.objectContaining({ event: 'PostToolUse', command: HOOK_COMMAND, toolUseId: 'toolu_bash' }) },
    { type: 'tool-use', id: 'toolu_ask', name: 'AskUserQuestion' },
    { type: 'tool-result', id: 'toolu_ask', isError: false, answers: [{ header: QUESTION.header, question: QUESTION.question, answer: 'です・ます' }] },
    { type: 'tool-use', id: 'toolu_write', name: 'Write', filePath: file },
    { type: 'tool-result', id: 'toolu_write', isError: false, filePath: file, added: 1 },
    { type: 'assistant-text', text: 'チェック完了' },
    ...(turnEnd ? [{ type: 'turn-end' }] : []),
  ];
  for (const event of expected) expect(events).toContainEqual(expect.objectContaining(event));
}

export function checkStatusLine(info: StatusLineInfo | null, version: string, transcriptPath: string): void {
  expect(info).not.toBeNull();
  expect(info!.version).toBe(version);
  expect(info!.model).not.toBeNull();
  // start_session が、省いたエフォートを呼んだセッションに合わせるのに使う（--effort に渡せる値）
  expect(EFFORTS).toContain(info!.effort);
  expect(info!.context).not.toBeNull();
  expect(info!.transcriptPath).toBe(transcriptPath);
}
