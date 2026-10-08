import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTranscriptEntry, toChatEvents } from '@shared/chat';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type { AskQuestion, ScreenInfo, ScreenLine } from '@shared/screen';
import { transcriptPath } from '../src/main/claude-session';
import { applyQuestions, askQuestionsOf, findEffort, findMode, findModel, parseMenu, promptRange } from '../src/main/screen-parser';
import { ScreenTracker } from '../src/main/screen-tracker';
import { DEFAULT_PTY_SIZE } from '../src/main/session-manager';
import { parseStatusLine } from '../src/main/statusline';
import {
  FIXTURE_ROOT,
  QUESTION,
  checkAskInput,
  checkChat,
  checkPermission,
  checkPrompt,
  checkQuestion,
  checkRewindRestore,
  checkStatusLine,
  checkTrust,
  checkWorkflowApproval,
  type ScreenName,
} from './scenario';
import { checkEarlyDraft, checkPromptBack } from './scenarios/errors';
import { DRAFT, EFFORT, LONG_PASTE, SHELL_COMMAND, checkDraft, checkEffort, checkPastedDraft } from './scenarios/input';
import {
  ASK_MULTI,
  ASK_PREVIEW,
  ASK_TABS,
  ASK_TALL,
  checkMulti,
  checkMultiReview,
  checkPreview,
  checkTabsFirst,
  checkTabsLast,
  checkTabsMulti,
  checkTabsReview,
  checkTall,
} from './scenarios/questions';

// 本物の Claude Code から取った控え（test/fixtures/claude-code/<版>/）を、アプリの読み取りにかける。
// 控えは、互換性の確認（npm run test:cli）に TANACODE_RECORD=1 を付けて取る。古い版の控えも残し、読めるままかを確かめ続ける

const DIR = join(__dirname, 'fixtures', 'claude-code');
const versions = existsSync(DIR) ? readdirSync(DIR) : [];

if (versions.length === 0) it.skip('控えがまだありません（TANACODE_RECORD=1 npm run test:cli で取る）', () => {});
// ステータスバーで「動作確認済のバージョン」とする版（VERIFIED_CLAUDE_CODE_VERSION）は、控えで確かめられる版にする
else it('動作確認済のバージョンの控えがある', () => expect(versions).toContain(VERIFIED_CLAUDE_CODE_VERSION));

describe.each(versions)('Claude Code %s の控え', (version) => {
  const dir = join(DIR, version);
  const screen = (name: ScreenName) => JSON.parse(readFileSync(join(dir, 'screens', `${name}.json`), 'utf8')) as ScreenLine[];
  // 控えを取ったあとに足した台本の画面は、古い版の控えには無い
  const has = (name: ScreenName) => existsSync(join(dir, 'screens', `${name}.json`));
  // 文字の属性ごと書き出した画面を、アプリと同じ ScreenTracker に流し込んで読む（書きかけは薄い字を見分ける）
  const replay = async (name: ScreenName): Promise<ScreenInfo> => {
    const tracker = new ScreenTracker(DEFAULT_PTY_SIZE.cols, DEFAULT_PTY_SIZE.rows, () => {}, () => {});
    tracker.feed(readFileSync(join(dir, 'screens', `${name}.ansi`), 'utf8'));
    // 描画が落ち着いてから読み、入力欄が出て少し経つと ready になる（screen-tracker.ts の SETTLE_MS・READY_AFTER_MS）
    await new Promise((resolve) => setTimeout(resolve, 500));
    const info = tracker.current;
    tracker.dispose();
    return info;
  };
  // AskUserQuestion の画面は、アプリと同じく会話ログの質問で組み立て直す
  const question = (name: ScreenName, questions: AskQuestion[]) => {
    const menu = parseMenu(screen(name));
    return menu && applyQuestions(menu, questions, new Map());
  };
  const askInput = () => (JSON.parse(readFileSync(join(dir, 'ask.json'), 'utf8')) as { tool_input?: unknown }).tool_input;
  const entries = readFileSync(join(dir, 'transcript.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isTranscriptEntry);
  const cwd = join(FIXTURE_ROOT, 'work');

  // transcriptPath は homedir() を見るので、控えを取ったときの HOME にする
  const oldHome = process.env.HOME;
  beforeAll(() => {
    process.env.HOME = join(FIXTURE_ROOT, 'home');
  });
  afterAll(() => {
    process.env.HOME = oldHome;
  });

  it('フォルダの信頼の確認が読める', () => {
    checkTrust(parseMenu(screen('trust')));
  });

  it('入力欄と、入力欄のまわりの表示が読める', () => {
    const lines = screen('prompt');
    expect(promptRange(lines)).not.toBeNull();
    checkPrompt({ mode: findMode(lines), effort: findEffort(lines), model: findModel(lines) });
  });

  it('Bash の許可の確認が読める', () => {
    checkPermission(parseMenu(screen('bash-permission')), 'mkdir checked');
    // 操作の案内は、前後の空白を除いて読む
    expect(parseMenu(screen('bash-permission'))?.hint).toBe('Esc to cancel · Tab to amend');
    // 2.1.292 は、2 つめの選択肢の名前を、端末の幅より手前（フォルダのあと）で折り返す。続きの「from this project」も名前
    expect(parseMenu(screen('bash-permission'))?.options.map((o) => o.label)).toContain(`Yes, and always allow access to ${cwd} from this project`);
  });

  it('AskUserQuestion の質問が読める', () => {
    const menu = parseMenu(screen('question'));
    const questions = askQuestionsOf(askInput());
    expect(menu).not.toBeNull();
    expect(questions).not.toBeNull();
    checkQuestion(applyQuestions(menu!, questions!, new Map()));
  });

  it('フックが書いた AskUserQuestion の入力が読める', () => {
    checkAskInput(askInput());
  });

  it('Write の許可の確認が読める', () => {
    checkPermission(parseMenu(screen('write-permission')), 'hello.txt');
  });

  it('ワークフローを始める前の確認が読める', () => {
    checkWorkflowApproval(parseMenu(screen('workflow-approval')));
  });

  it('/rewind の「何を戻すか」が読める', () => {
    checkRewindRestore(parseMenu(screen('rewind-restore')));
  });

  it.skipIf(!has('question-tabs-first'))('複数の質問のページ送りと、回答の確認画面が読める', () => {
    checkTabsFirst(question('question-tabs-first', ASK_TABS));
    checkTabsMulti(question('question-tabs-multi', ASK_TABS));
    checkTabsLast(question('question-tabs-last', ASK_TABS));
    checkTabsReview(question('question-tabs-review', ASK_TABS));
  });

  it.skipIf(!has('question-multi'))('複数選択だけの質問が読める', () => {
    checkMulti(question('question-multi', ASK_MULTI));
    checkMultiReview(question('question-multi-review', ASK_MULTI));
  });

  it.skipIf(!has('question-preview'))('プレビュー付きの選択肢が読める', () => {
    checkPreview(question('question-preview', ASK_PREVIEW));
  });

  it.skipIf(!has('question-tall'))('説明が長く、上が切れて見える質問が読める', () => {
    checkTall(question('question-tall', ASK_TALL));
    checkTall(question('question-tall-moved', ASK_TALL), '3');
  });

  // 質問のメニューは、アプリでは会話ログの質問で組み立て直す（applyQuestions）。
  // 質問が届く前（と、質問ではないメニュー）は、画面だけから読んだものを出す
  it('会話ログの質問で組み立て直す前に、画面だけから質問と選択肢（名前・説明・カーソル・自由記述）と操作の案内が読める', () => {
    expect(parseMenu(screen('question'))).toEqual({
      kind: 'question',
      tabs: [{ label: QUESTION.header, answered: false }],
      title: QUESTION.question,
      context: [],
      options: [
        { id: '1', label: 'です・ます', description: '丁寧な書き方', pointed: true, checked: null, textInput: false },
        { id: '2', label: 'だ・である', description: '言い切る書き方', pointed: false, checked: null, textInput: false },
        { id: '3', label: 'Type something.', description: '', pointed: false, checked: null, textInput: true },
        { id: '4', label: 'Chat about this', description: '', pointed: false, checked: null, textInput: false },
      ],
      multiSelect: false,
      hint: expect.stringContaining('Esc to cancel'),
      previewLayout: false,
    });
  });

  it.skipIf(!has('question-multi'))('複数選択の質問は、画面だけからチェックと確定の行（最後の質問は Submit、途中の質問は Next）が読める', () => {
    const menu = parseMenu(screen('question-multi'));
    expect(menu?.multiSelect).toBe(true);
    // 確定の行は、自由記述と「Chat about this」の間にある
    expect(menu!.options).toEqual([
      { id: '1', label: '型チェック', description: 'tsc で確かめる', pointed: false, checked: true, textInput: false },
      { id: '2', label: '単体テスト', description: 'vitest で確かめる', pointed: false, checked: false, textInput: false },
      { id: '3', label: 'リンター', description: 'eslint で確かめる', pointed: true, checked: true, textInput: false },
      { id: '4', label: 'Type something', description: '', pointed: false, checked: false, textInput: true },
      { id: 'submit', label: 'Submit', description: '', pointed: false, checked: null, textInput: false },
      { id: '5', label: 'Chat about this', description: '', pointed: false, checked: null, textInput: false },
    ]);
    expect(parseMenu(screen('question-tabs-multi'))?.options.filter((o) => o.id === 'submit')).toEqual([
      { id: 'submit', label: 'Next', description: '', pointed: false, checked: null, textInput: false },
    ]);
    // 回答の確認画面には、操作の案内が出ない
    expect(parseMenu(screen('question-multi-review'))?.hint).toBe('');
  });

  it.skipIf(!has('question-preview'))('プレビュー付きの質問は、画面だけでも、プレビューの枠より左の列から選択肢の名前が読める（折り返した名前はつなぐ）', () => {
    const menu = parseMenu(screen('question-preview'));
    expect(menu).toMatchObject({ kind: 'question', previewLayout: true, hint: expect.stringContaining('Esc to cancel') });
    // 縦線の枠の質問文は、折り返した行を空白でつなぐ
    expect(menu!.title.replaceAll(' ', '')).toBe(ASK_PREVIEW[0].question);
    // この形には、説明・自由記述・番号付きの「Chat about this」が出ない
    expect(menu!.options).toEqual(
      ASK_PREVIEW[0].options.map((o, i) => ({ id: String(i + 1), label: o.label, description: '', pointed: i === 0, checked: null, textInput: false })),
    );
  });

  it.skipIf(!has('question-tall'))('上が切れて見える質問は、画面だけでは見えている選択肢を読み、何行にもわたる説明は行をつないで 1 つにする', () => {
    const shown = (name: ScreenName) => parseMenu(screen(name))?.options.map((o) => ({ id: o.id, pointed: o.pointed, textInput: o.textInput }));
    // カーソルのある 1 つめは画面の外。カーソルを 3 つめに送ると見える
    expect(shown('question-tall')).toEqual(['2', '3', '4', '5', '6'].map((id) => ({ id, pointed: false, textInput: id === '5' })));
    expect(shown('question-tall-moved')).toEqual(['2', '3', '4', '5', '6'].map((id) => ({ id, pointed: id === '3', textInput: id === '5' })));
    const third = parseMenu(screen('question-tall'))!.options.find((o) => o.id === '3')!;
    expect(third.label).toBe(ASK_TALL[0].options[2].label);
    // 行と行の間は空白 1 つでつなぐ（行頭の字下げは除く）
    const rows = third.description.split(' ');
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row).toMatch(/^(進め方3の説明です。)+$/);
    expect(rows.join('')).toBe(ASK_TALL[0].options[2].description);
  });

  it.skipIf(!has('effort'))('--effort を付けた入力欄のエフォートとモデル名が読める', async () => {
    checkEffort(await replay('effort'), EFFORT);
  });

  it.skipIf(!has('draft'))('入力欄の書きかけが読める', async () => {
    checkDraft(await replay('draft'), DRAFT);
    checkPastedDraft(await replay('pasted-draft'), LONG_PASTE.split('\n').length);
    checkDraft(await replay('shell-draft'), `!${SHELL_COMMAND}`);
  });

  it.skipIf(!has('interrupt-draft'))('中断のあとの入力欄が読める', async () => {
    checkEarlyDraft(await replay('interrupt-draft'));
    checkPromptBack(await replay('tool-interrupted'));
  });

  it('会話ログからチャットを組み立てられる', () => {
    checkChat(entries, entries.flatMap((e) => toChatEvents(e, cwd)), cwd);
  });

  it('statusLine の JSON が読める', () => {
    const sessionId = (entries.find((e) => e.type === 'user') as { sessionId?: string } | undefined)?.sessionId;
    expect(sessionId).toBeTruthy();
    checkStatusLine(parseStatusLine(readFileSync(join(dir, 'statusline.json'), 'utf8'), Date.now()), version, transcriptPath(cwd, sessionId!));
  });
});
