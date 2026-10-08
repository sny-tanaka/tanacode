import { join } from 'node:path';
import { expect } from 'vitest';
import type { ChatEvent, TranscriptEntry } from '@shared/chat';
import type { Menu, ScreenInfo } from '@shared/screen';
import type { StatusLineInfo } from '@shared/statusline';
import { askQuestionsOf } from '../src/main/screen-parser';
import type { Step } from './cli/mock-api';

// Claude Code との互換性を確かめる台本と、アプリが読み取れるべきもの。
// 本物の claude を動かす確認（test/cli）と、そのとき取った控えを読む確認（test/recorded.test.ts）で共有する。
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

// 控えに残す画面
// workflow-approval（background.test.ts）と rewind-restore（session.test.ts）は、ほかの台本で取る。
// question- で始まるもの（question を除く）は、AskUserQuestion の台本（questions.test.ts）で取る
// interrupt-draft・tool-interrupted は失敗と中断の台本（errors.test.ts）で取る
// effort・draft・pasted-draft・shell-draft（input.test.ts）は、--effort を付けた入力欄・書きかけ・長い貼り付けの目印・! のコマンドを書いている入力欄
export type ScreenName =
  | 'trust'
  | 'prompt'
  | 'bash-permission'
  | 'question'
  | 'write-permission'
  | 'workflow-approval'
  | 'rewind-restore'
  | QuestionScreenName
  | 'interrupt-draft'
  | 'tool-interrupted'
  | InputScreenName;

// AskUserQuestion の台本（test/scenarios/questions.ts）で取る画面
export type QuestionScreenName =
  | 'question-tabs-first'
  | 'question-tabs-multi'
  | 'question-tabs-last'
  | 'question-tabs-review'
  | 'question-multi'
  | 'question-multi-review'
  | 'question-preview'
  | 'question-tall'
  | 'question-tall-moved';

type InputScreenName = 'effort' | 'draft' | 'pasted-draft' | 'shell-draft';

// /rewind で戻す先の発言（session.test.ts）
export const REWOUND = '再開して続けてください';

// ワークフローを始める前の確認。説明の中のフェーズの一覧（番号付き）を、選択肢と取り違えない
export function checkWorkflowApproval(menu: Menu | null): void {
  expect(menu?.kind).toBe('other');
  expect(menu!.title).toMatch(/workflow.*\?$/i);
  expect(menu!.options.map((o) => o.label)).not.toContain('調べる');
  expect(menu!.options.find((o) => /^Yes/.test(o.label))?.pointed).toBe(true);
}

// /rewind で戻す先を選んだあとの「何を戻すか」。戻す先の発言（縦線の枠の引用）は、見出しではなく補足に出る
export function checkRewindRestore(menu: Menu | null): void {
  expect(menu?.kind).toBe('other');
  expect(menu!.title).toMatch(/restore/i);
  expect(menu!.context.join('\n')).toContain(REWOUND);
  expect(menu!.options.some((o) => /^Restore conversation/.test(o.label))).toBe(true);
  expect(menu!.options.some((o) => /Never mind/i.test(o.label))).toBe(true);
  expect(menu!.options.filter((o) => o.pointed)).toHaveLength(1);
}

// 初めてのフォルダで出る、フォルダの信頼の確認（番号の無い選択肢）。問いかけを見出しにする
export function checkTrust(menu: Menu | null): void {
  expect(menu?.kind).toBe('other');
  expect(menu!.title).toContain('trust');
  expect(menu!.options.length).toBeGreaterThanOrEqual(2);
  expect(menu!.options.filter((o) => o.pointed)).toHaveLength(1);
  expect(menu!.options.some((o) => /^Yes/.test(o.label))).toBe(true);
}

// 起動したあとの入力欄（権限モードは --permission-mode manual で起動する）。モデル名は起動時のバナーから読む
export function checkPrompt(info: Pick<ScreenInfo, 'mode' | 'effort' | 'model'>): void {
  expect(info.mode).toBe('manual');
  expect(info.effort).not.toBeNull();
  expect(info.model).toMatch(/^[A-Z][a-z]+ \d/);
}

// target: 確認の見出しか補足（実行しようとしているコマンドなど）に出るはずの文字
export function checkPermission(menu: Menu | null, target: string): void {
  expect(menu?.kind).toBe('permission');
  expect([menu!.title, ...menu!.context].join('\n')).toContain(target);
  // コマンドを囲む点線などの飾りの行は、補足に入れない
  expect(menu!.context.filter((line) => /^[╌┄┈─]{20,}$/.test(line))).toEqual([]);
  expect(menu!.options.some((o) => o.pointed)).toBe(true);
  expect(menu!.options[0].label).toMatch(/^Yes/);
  // 許可の確認の選択肢には説明が無い。Claude Code が選択肢の名前を折り返しても、続きを説明として読まない
  expect(menu!.options.filter((o) => o.description).map((o) => `${o.label} / ${o.description}`)).toEqual([]);
}

// questions を渡したあとの質問のメニュー（ScreenTracker が applyQuestions で組み立てたもの）
export function checkQuestion(menu: Menu | null): void {
  expect(menu?.kind).toBe('question');
  expect(menu!.title).toBe(QUESTION.question);
  expect(menu!.options.slice(0, 2).map((o) => ({ label: o.label, description: o.description }))).toEqual(QUESTION.options);
  expect(menu!.options[0].pointed).toBe(true);
}

// PreToolUse のフックが書いた AskUserQuestion の入力
export function checkAskInput(input: unknown): void {
  expect(askQuestionsOf(input)).toEqual([{ ...QUESTION, options: QUESTION.options.map((o) => ({ ...o, preview: undefined })) }]);
}

export function checkChat(entries: TranscriptEntry[], events: ChatEvent[], cwd: string): void {
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
    { type: 'turn-end' },
  ];
  for (const event of expected) expect(events).toContainEqual(expect.objectContaining(event));
}

export function checkStatusLine(info: StatusLineInfo | null, version: string, transcriptPath: string): void {
  expect(info).not.toBeNull();
  expect(info!.version).toBe(version);
  expect(info!.model).not.toBeNull();
  expect(info!.context).not.toBeNull();
  expect(info!.transcriptPath).toBe(transcriptPath);
}
