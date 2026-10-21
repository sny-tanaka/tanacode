import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatEvents, type ChatEvent } from '@shared/chat';
import type { AskQuestion } from '@shared/screen';
import { ASK_PREVIEW, ASK_TABS, TABS_ANSWERS, TYPED_COLOR } from '../scenarios/questions';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、Claude Code が答えを待つ要求（stream-json の can_use_tool）に、カードと同じ答え方
// （session-manager の replyQuestion・replyPermission）で返せるかを確かめる（設計書 8 節「カード」）。
// 返事の形（質問の答えは updatedInput の answers・annotations、理由を添えて断るのは deny の message、止めるのは interrupt、
// 今後は聞かないのは updatedPermissions、プランの承認して編集を自動では setMode）を、本物の Claude Code が受け付け、Claude（API）まで届くか

const version = claudeVersion();

const SIMPLE: AskQuestion[] = [
  {
    question: 'どちらで進めますか？',
    header: '進め方',
    multiSelect: false,
    options: [
      { label: 'A 案', description: '速い' },
      { label: 'B 案', description: '確実' },
    ],
  },
];
// プレビュー付きの質問に、選択肢に無い答えを書く
const TYPED_LAYOUT = 'TYPED-格子に並べる\n2 列で';
// 選択肢と一緒に送る補足（カードの入力欄に書いてから選択肢を押す・チェックして次へ進む）
const NOTE_STYLE = 'NOTE-語尾は\nやわらかく';
const NOTE_LANGUAGE = 'NOTE-Zig も少し';
const NOTE_LAYOUT = 'NOTE-余白を広めに';
const DENIED = 'DENY-代わりに echo で確かめてください';
const PLAN = '# 計画\n\n1. 価格の表記を直す\n2. テストを足す';

// 発言の目印 → Claude（モック）が返すツールの呼び出し
const ask = (id: string, questions: AskQuestion[]): Block[] => [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }];
const bash = (id: string, command: string): Block[] => [{ type: 'tool_use', id, name: 'Bash', input: { command, description: command } }];
const SCRIPT: Record<string, Block[]> = {
  'CARD-TABS-NOTES': ask('toolu_tabs_notes', ASK_TABS),
  'CARD-TABS': ask('toolu_tabs', ASK_TABS),
  'CARD-PREVIEW-NOTES': ask('toolu_preview_notes', ASK_PREVIEW),
  'CARD-PREVIEW-TYPED': ask('toolu_preview_typed', ASK_PREVIEW),
  'CARD-PREVIEW': ask('toolu_preview', ASK_PREVIEW),
  'CARD-CANCEL': ask('toolu_cancel', SIMPLE),
  'CARD-ALLOW': bash('toolu_allow', 'touch allowed.txt'),
  'CARD-DENY': bash('toolu_deny', 'touch denied.txt'),
  'CARD-STOP': bash('toolu_stop', 'touch stopped.txt'),
  'CARD-ALWAYS-AGAIN': bash('toolu_again', 'mkdir -p always-dir'),
  'CARD-ALWAYS': bash('toolu_always', 'mkdir -p always-dir'),
};

// 目印の発言にはツールの呼び出しを、ツールの結果には受け取ったことを返す。中断で終わったターンの結果は、次の発言と同じ
// user の発言にまとめて届くので、目印を先に見る
function script(prompt: string, results: string[]): Block[] | null {
  const key = Object.keys(SCRIPT).find((k) => prompt.includes(k));
  if (key) return SCRIPT[key];
  if (results.length > 0) return [{ type: 'text', text: `受け取りました: ${results.join(' / ').slice(0, 200)}` }];
  return [{ type: 'text', text: 'はい' }];
}

describe(`Claude Code ${version} の、答えを待つ要求とカード`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const events = (): ChatEvent[] => run.entries.flatMap((e) => toChatEvents(e, run.cwd));
  const resultOf = (toolUseId: string) => {
    const found = events().find((e) => e.type === 'tool-result' && e.id === toolUseId);
    return found?.type === 'tool-result' ? found : null;
  };
  const turnEnds = () => run.chatEvents.filter((e) => e.type === 'turn-end');
  // 送ってから、そのターンが終わるのを待つ
  const finished = async (before: number) => {
    await run.waitUntil('ターンの終わり', () => turnEnds().length > before);
    await run.untilState('待機中', (state) => state === 'idle');
    return turnEnds().at(-1)!;
  };

  beforeAll(async () => {
    api = new MockApi();
    api.intercept = script;
    // 許可の確認を出させる（manual）
    run = new ClaudeRun(await api.start(), { mode: 'manual' });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('質問（複数の質問・複数選択・自由記述）に答えると、答えが会話ログに残り、Claude に届く', async () => {
    const before = turnEnds().length;
    await run.send('CARD-TABS');
    const question = await run.question('質問');
    expect(question.questions).toEqual(ASK_TABS);
    expect(run.manager.stateOf(run.sessionId!)).toBe('question');
    expect(run.manager.pendingPermission(run.sessionId!)).toBeNull();
    run.replyQuestion(question, { kind: 'answer', answers: Object.fromEntries(ASK_TABS.map((q, i) => [q.question, TABS_ANSWERS[i]])) });
    await finished(before);
    expect(resultOf('toolu_tabs')?.answers).toEqual(ASK_TABS.map((q, i) => ({ header: q.header, question: q.question, answer: TABS_ANSWERS[i] })));
    expect(api.toolResults.some((r) => r.includes(TYPED_COLOR))).toBe(true);
    expect(run.manager.pendingQuestion(run.sessionId!)).toBeNull();
  });

  // 選択肢と書いた文を一緒に送る形は、答えの文につなげず、annotations の notes にした。どちらの形も届くが、notes なら Claude に
  // 「"質問"="選択肢" notes: 補足」と届き、選んだ案と書き足した文の区別がつく（答えの文につなげると「"質問"="選択肢, 補足"」になる）
  it('選択肢と一緒に送る補足（annotations の notes）は、プレビューの無い質問・複数選択でも、選択肢と分かれて Claude に届き、会話ログにも残る', async () => {
    const before = turnEnds().length;
    await run.send('CARD-TABS-NOTES');
    const question = await run.question('質問');
    const [style, languages, color] = ASK_TABS;
    run.replyQuestion(question, {
      kind: 'answer',
      answers: { [style.question]: 'だ・である', [languages.question]: 'TypeScript, Go', [color.question]: TYPED_COLOR },
      annotations: { [style.question]: { notes: NOTE_STYLE }, [languages.question]: { notes: NOTE_LANGUAGE } },
    });
    await finished(before);
    const result = api.toolResults.find((r) => r.includes(NOTE_LANGUAGE));
    expect(result).toContain(`"${style.question}"="だ・である" notes: ${NOTE_STYLE}`);
    expect(result).toContain(`"${languages.question}"="TypeScript, Go" notes: ${NOTE_LANGUAGE}`);
    // 入力だけで答えた質問には、補足を付けない
    expect(result).toContain(`"${color.question}"="${TYPED_COLOR}".`);
    expect(resultOf('toolu_tabs_notes')?.answers).toEqual([
      { header: style.header, question: style.question, answer: 'だ・である', notes: NOTE_STYLE },
      { header: languages.header, question: languages.question, answer: 'TypeScript, Go', notes: NOTE_LANGUAGE },
      { header: color.header, question: color.question, answer: TYPED_COLOR },
    ]);
  });

  it('プレビュー付きの質問で選んだ案のプレビューと補足（annotations）が、答えと一緒に Claude に届く', async () => {
    const before = turnEnds().length;
    await run.send('CARD-PREVIEW-NOTES');
    const question = await run.question('プレビュー付きの質問');
    const [asked] = ASK_PREVIEW;
    const picked = asked.options[0];
    run.replyQuestion(question, { kind: 'answer', answers: { [asked.question]: picked.label }, annotations: { [asked.question]: { preview: picked.preview!, notes: NOTE_LAYOUT } } });
    await finished(before);
    const result = api.toolResults.find((r) => r.includes(NOTE_LAYOUT));
    expect(result).toContain(`"${asked.question}"="${picked.label}" selected preview:\n${picked.preview} notes: ${NOTE_LAYOUT}`);
    expect(resultOf('toolu_preview_notes')?.answers).toEqual([{ header: asked.header, question: asked.question, answer: picked.label, notes: NOTE_LAYOUT }]);
  });

  it('プレビュー付きの質問で選んだ案のプレビュー（annotations）も、答えと一緒に Claude に届く', async () => {
    const before = turnEnds().length;
    await run.send('CARD-PREVIEW');
    const question = await run.question('プレビュー付きの質問');
    const [asked] = ASK_PREVIEW;
    const picked = asked.options[1];
    run.replyQuestion(question, { kind: 'answer', answers: { [asked.question]: picked.label }, annotations: { [asked.question]: { preview: picked.preview! } } });
    await finished(before);
    const result = api.toolResults.find((r) => r.includes(picked.label));
    expect(result).toContain(`selected preview:\n${picked.preview}`);
  });

  it('プレビュー付きの質問に自由記述で答えても、答えが会話ログに残り、Claude に届く', async () => {
    const before = turnEnds().length;
    await run.send('CARD-PREVIEW-TYPED');
    const question = await run.question('プレビュー付きの質問');
    const [asked] = ASK_PREVIEW;
    run.replyQuestion(question, { kind: 'answer', answers: { [asked.question]: TYPED_LAYOUT } });
    await finished(before);
    expect(resultOf('toolu_preview_typed')?.answers).toEqual([{ header: asked.header, question: asked.question, answer: TYPED_LAYOUT }]);
    expect(api.toolResults.some((r) => r.includes(TYPED_LAYOUT))).toBe(true);
  });

  it('質問のキャンセル（×）は、作業を止める（中断で終わる）', async () => {
    const before = turnEnds().length;
    const results = api.toolResults.length;
    await run.send('CARD-CANCEL');
    const question = await run.question('質問');
    run.replyQuestion(question, { kind: 'cancel' });
    expect(await finished(before)).toEqual({ type: 'turn-end', interrupted: true });
    // Claude には続きを頼まない（API を呼ばない）
    expect(api.toolResults).toHaveLength(results);
  });

  it('許可の確認: ツールの名前と入力の全文がカードに出て、許すとツールが動く', async () => {
    const before = turnEnds().length;
    await run.send('CARD-ALLOW');
    const permission = await run.permission('Bash の許可');
    expect(permission).toMatchObject({ tool: 'Bash', input: { command: 'touch allowed.txt' }, plan: null, agent: null });
    expect(run.manager.stateOf(run.sessionId!)).toBe('permission');
    expect(run.manager.pendingQuestion(run.sessionId!)).toBeNull();
    run.replyPermission(permission, { kind: 'allow' });
    await finished(before);
    expect(existsSync(join(run.cwd, 'allowed.txt'))).toBe(true);
    expect(run.manager.pendingPermission(run.sessionId!)).toBeNull();
  });

  it('許可の確認: 理由を伝えて断ると、ツールは動かず、理由が Claude に届いて作業が続く', async () => {
    const before = turnEnds().length;
    await run.send('CARD-DENY');
    const permission = await run.permission('Bash の許可');
    run.replyPermission(permission, { kind: 'deny', message: DENIED });
    const end = await finished(before);
    expect(end).not.toHaveProperty('interrupted');
    expect(existsSync(join(run.cwd, 'denied.txt'))).toBe(false);
    expect(api.toolResults.some((r) => r.includes(DENIED))).toBe(true);
  });

  it('許可の確認: ×（断って止める）は、ツールを動かさずに作業を止める', async () => {
    const before = turnEnds().length;
    await run.send('CARD-STOP');
    const permission = await run.permission('Bash の許可');
    run.replyPermission(permission, { kind: 'stop' });
    expect(await finished(before)).toEqual({ type: 'turn-end', interrupted: true });
    expect(existsSync(join(run.cwd, 'stopped.txt'))).toBe(false);
  });

  it('許可の確認: 「今後は聞かない」は、Claude Code が出した候補の許可を足す。同じ操作は、次から聞かない', async () => {
    let before = turnEnds().length;
    await run.send('CARD-ALWAYS');
    const permission = await run.permission('Bash の許可');
    expect(permission.always).not.toBeNull();
    run.replyPermission(permission, { kind: 'allow', always: true });
    await finished(before);
    expect(existsSync(join(run.cwd, 'always-dir'))).toBe(true);
    before = turnEnds().length;
    const attentions = run.attentions.length;
    await run.send('CARD-ALWAYS-AGAIN');
    await finished(before);
    expect(run.attentions).toHaveLength(attentions);
    expect(resultOf('toolu_again')?.isError).toBe(false);
  });
});

describe(`Claude Code ${version} の、プランの承認のカード`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  // Claude（モック）が、プランモードでプランのファイルに書いてから ExitPlanMode を呼ぶ（本物と同じ流れ。ExitPlanMode の入力には本文を入れない）
  let planStep = 0;

  beforeAll(async () => {
    api = new MockApi();
    api.intercept = (prompt, results, context) => {
      if (prompt.includes('CARD-PLAN')) {
        planStep = 1;
        // プランのファイルの場所は、Claude Code がプランモードの案内に書く
        const file = context.match(/\/[^\s"'`]+\/\.claude\/plans\/[^\s"'`]+\.md/)?.[0];
        if (!file) return [{ type: 'text', text: 'プランのファイルの場所がありません' }];
        return [{ type: 'tool_use', id: 'toolu_plan_write', name: 'Write', input: { file_path: file, content: PLAN } }];
      }
      if (planStep === 1 && results.length > 0) {
        planStep = 2;
        return [{ type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input: {} }];
      }
      return script(prompt, results);
    };
    run = new ClaudeRun(await api.start(), { mode: 'plan' });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('プランの承認は、プランのファイルの本文つきでカードに出て、「承認して、編集を自動で進める」で acceptEdits になる', async () => {
    expect(run.manager.modeOf(run.sessionId!)).toBe('plan');
    await run.send('CARD-PLAN');
    let permission = await run.permission('プランの承認');
    // プランのファイルへの書き込みを聞かれたら、許す（プランモードでも、プランのファイルだけは書ける）
    if (permission.tool === 'Write') {
      run.replyPermission(permission, { kind: 'allow' });
      permission = await run.waitUntil('プランの承認', () => {
        const next = run.manager.pendingPermission(run.sessionId!);
        return next?.tool === 'ExitPlanMode' ? next : null;
      });
    }
    expect(permission).toMatchObject({ tool: 'ExitPlanMode', input: {}, plan: PLAN });
    run.replyPermission(permission, { kind: 'accept-edits' });
    await run.waitUntil('acceptEdits', () => run.manager.modeOf(run.sessionId!) === 'acceptEdits');
    await run.untilState('待機中', (state) => state === 'idle');
    expect(api.toolResults.some((r) => /approved/i.test(r))).toBe(true);
    // 会話ログを承認の結果の行まで読み終えても、acceptEdits のまま（会話ログは stream より遅れて読むことがあり、
    // 承認より前に書かれた発言の行の plan で戻していた）
    await run.waitUntil('承認の結果の行', () => run.entries.some((e) => JSON.stringify(e).includes('"tool_use_id":"toolu_plan"')));
    expect(run.manager.modeOf(run.sessionId!)).toBe('acceptEdits');
  });
});
