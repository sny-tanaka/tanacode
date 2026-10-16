import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type { ScreenLine } from '@shared/screen';
import { findMode, findModel, isStreaming, parseMenu, parseRewind, parseSpinner, promptRange, tallPromptRange } from '../src/main/screen-parser';

// 画面の読み取り（screen-parser.ts）のうち、控えの画面のままでは出てこない場面。
// 動作確認済のバージョンの控え（test/fixtures/claude-code/<バージョン>/screens）を元に、その場面で変わる行だけを差し替えて読む

const DIR = join(__dirname, 'fixtures', 'claude-code', VERIFIED_CLAUDE_CODE_VERSION, 'screens');
const screen = (name: string) => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as ScreenLine[];
const line = (text: string): ScreenLine => ({ text, full: false });
// match に合う行を、texts の行に差し替える（texts が空なら、その行を空行にする）
const replaced = (lines: ScreenLine[], match: RegExp, ...texts: (string | ScreenLine)[]): ScreenLine[] => {
  const at = lines.findIndex((l) => match.test(l.text));
  expect(at, `${match} の行が控えにありません`).not.toBe(-1);
  const rows = texts.length > 0 ? texts.map((t) => (typeof t === 'string' ? line(t) : t)) : [line('')];
  return [...lines.slice(0, at), ...rows, ...lines.slice(at + 1)];
};
const promptStart = (lines: ScreenLine[]) => promptRange(lines)![0];

// 作業が終わったあとの画面: 「⏺ テスト」の応答の下に、完了の行（✻ Worked for 0s · done …）・エフォート・入力欄が並ぶ
const DONE = /^✻ \S+ for \d+s · done/;
const finished = () => screen('pasted-draft');

it('応答の文章を書いている途中（タイマーの行が消えて、入力欄のいちばん近くに応答の ⏺ がある）を見分ける', () => {
  const done = finished();
  expect(isStreaming(done, promptStart(done))).toBe(false);
  // 書いている間は、タイマーの行が消える
  const writing = replaced(done, DONE);
  expect(isStreaming(writing, promptStart(writing))).toBe(true);
  expect(parseSpinner(writing, promptStart(writing))).toBeNull();
  // タイマーの行がある間は、書いている途中ではない（進み具合はタイマーの行から読む）
  const working = replaced(done, DONE, '✶ Churning… (3s · ↓ 12 tokens)');
  expect(isStreaming(working, promptStart(working))).toBe(false);
  // 作業中に送った発言が順番待ちのときも、タイマーの行が消えて発言（❯）が出る。応答より近くにあれば、書いている途中ではない
  const queued = replaced(done, DONE, { text: `❯ 続けてください${' '.repeat(104)}`, full: true });
  expect(isStreaming(queued, promptStart(queued))).toBe(false);
  // 長い応答を書いている途中で、応答の始まり（⏺）が画面のいちばん上の行にある
  const at = done.findIndex((l) => DONE.test(l.text));
  const reply = [line('⏺ 調べた結果です。'), ...Array.from({ length: at - 1 }, (_, i) => line(`  ${i + 1}. 項目 ${i + 1} を確かめました`))];
  const long = [...reply, line(''), ...done.slice(at + 1)];
  expect(long).toHaveLength(done.length);
  expect(isStreaming(long, promptStart(long))).toBe(true);
  // 会話がまだ無い（起動したばかり）
  expect(isStreaming(screen('prompt'), promptStart(screen('prompt')))).toBe(false);
});

it('作業中のタイマーの行から、経過時間・考えている途中か・受け取ったトークン数を読む', () => {
  const spinner = (text: string) => {
    const lines = replaced(finished(), DONE, text);
    return parseSpinner(lines, promptStart(lines));
  };
  expect(spinner('✳ Shimmying… (5s · ↓ 225 tokens · thought for 2s)')).toEqual({ elapsed: '5s', thinking: false, tokens: '225' });
  expect(spinner('✽ Pondering… (1m 12s · ↓ 1.2k tokens · thinking)')).toEqual({ elapsed: '1m 12s', thinking: true, tokens: '1.2k' });
  // 応答がまだ何も来ていないうちは、括弧の中が無い
  expect(spinner('✶ Churning…')).toEqual({ elapsed: null, thinking: false, tokens: null });
  // 作業が終わったあとの完了の行は、タイマーの行ではない
  expect(parseSpinner(finished(), promptStart(finished()))).toBeNull();
});

it('入力欄の下の表示から、権限モードを読む', () => {
  const mode = (text: string) => findMode(replaced(screen('prompt'), /manual mode on/, text));
  expect(findMode(screen('prompt'))).toBe('manual');
  expect(mode('  ⏵⏵ accept edits on (shift+tab to cycle)')).toBe('acceptEdits');
  expect(mode('  ⏸ plan mode on (shift+tab to cycle)')).toBe('plan');
  expect(mode('  ⏵⏵ auto mode on (shift+tab to cycle)')).toBe('auto');
  expect(mode('  ⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('bypassPermissions');
});

it('起動時のバナーから、小数の無いモデル名（Opus 5）・1M のコンテキスト・エフォートを付けたものを読む', () => {
  const banner = (model: string) => findModel(replaced(screen('prompt'), /Opus 5\.5 · /, ` ▐▂███▂█   ${model}`));
  expect(findModel(screen('prompt'))).toBe('Opus 5.5');
  expect(banner('Opus 5 (1M context) · Claude Max')).toBe('Opus 5 (1M context)');
  expect(banner('Sonnet 5 with medium effort · Claude Max')).toBe('Sonnet 5');
});

it('会話の本文に出てくるモデル名・バージョンは、バナーと取り違えない。バナーが画面の外に流れたあとは読まない', () => {
  const mentioned = replaced(screen('bash-permission'), /^⏺ コマンドを実行します。/, '⏺ Claude Code v2.1.292 の Sonnet 5 · Claude Max で確かめます。');
  expect(findModel(mentioned)).toBe('Opus 5.5');
  // 控えの画面は、上にバナーが無い（会話が長くて流れた）。いちばん上の行から、モデル名の出てくる応答が見える
  const scrolled = screen('question-preview');
  expect(findModel(scrolled)).toBeNull();
  const reply = [
    '⏺ バナーの「Opus 5 · Claude Max」の読み取りを確かめました。',
    '  - バナーの行だけを見ます',
    '  - 会話の本文に出てくるモデル名（Sonnet 5 · Claude Pro など）は読みません',
    '  - バナーが画面の外に流れたら、前に読んだモデル名のままにします',
  ].map(line);
  expect(scrolled[4].text).toBe('');
  expect(findModel([...reply, ...scrolled.slice(reply.length)])).toBeNull();
});

it('質問文の枠（行頭の │）にモデル名のような文字があっても、バナーのモデル名と取り違えない', () => {
  // プレビュー付きの質問（控えの question-preview）は、質問文を行頭に縦線（│）の付いた枠で出す。枠の 2 行の質問文だけを差し替える
  const asked = replaced(
    replaced(screen('question-preview'), /^│ 画面の部品の並べ方/, '│ Opus 5 · Claude Max で作った画面と、Sonnet 5 (1M context) · Claude Pro で作った画面の、'),
    /^│ 部品の並べ方/,
    '│ どちらの並べ方にしますか？',
  );
  // 控えの画面は、バナーが画面の外に流れている。質問文のモデル名を読まない
  expect(findModel(asked)).toBeNull();
  // 会話が短く、バナーが見えているとき。上の 4 行を、同じバージョンの控え（question）のバナーの 4 行に差し替える
  const banner = screen('question').slice(0, 4);
  expect(banner.map((l) => l.text).join('\n')).toMatch(/Claude Code v[\d.]+\n.*Opus 5\.5 · /);
  expect(findModel([...banner, ...asked.slice(banner.length)])).toBe('Opus 5.5');
});

it('/rewind の「何を戻すか」の引用の枠は字下げがあるので、モデル名のような文字があってもバナーと取り違えない（直す前から起きない）', () => {
  const quoted = replaced(screen('rewind-restore'), /^ {3}│ 再開して続けてください/, '   │ Opus 5 · Claude Max で確かめてください');
  expect(findModel(quoted)).toBe('Opus 5.5');
});

it('選択肢の名前が端末の幅で折り返されたら、次の行をつないで 1 つの名前にし、その下の行は説明にする', () => {
  // AskUserQuestion の選択肢に、端末の幅（120 文字）より長いファイルのパスが出る
  const path = 'packages/desktop-app/src/renderer/src/features/session-settings/components/permission-mode-selector/PermissionModeSelector.stories.tsx';
  const lines = replaced(
    replaced(screen('question'), /^どちらの書き方にしますか？/, 'どのファイルから直しますか？'),
    /^ {2}2\. だ・である/,
    { text: `  2. ${path.slice(0, 115)}`, full: true },
    `     ${path.slice(115)}`,
  ).slice(1);
  const menu = parseMenu(replaced(lines, /^ {5}言い切る書き方/, '     権限モードの選択欄のストーリー'));
  expect(menu?.title).toBe('どのファイルから直しますか？');
  expect(menu!.options.slice(0, 2).map((o) => ({ label: o.label, description: o.description }))).toEqual([
    { label: 'です・ます', description: '丁寧な書き方' },
    { label: path, description: '権限モードの選択欄のストーリー' },
  ]);
});

it('回答の確認画面の下に、名前を付けたセッションの入力欄の線（「──── 名前 ─」）が出ても、最後の選択肢（Cancel）の説明にしない', () => {
  // 名前を付けたセッション（/rename・claude -n）では、操作説明の無い確認画面の下に、名前入りの入力欄の線が出る（2.1.296 で実測）
  const named = { text: `${'─'.repeat(111)} 作業名 ─`, full: true };
  const menu = parseMenu(replaced(screen('question-tabs-review'), /^ {2}2\. Cancel$/, '  2. Cancel', named));
  expect(menu?.title).toBe('Ready to submit your answers?');
  expect(menu!.options.map((o) => ({ label: o.label, description: o.description }))).toEqual([
    { label: 'Submit answers', description: '' },
    { label: 'Cancel', description: '' },
  ]);
});

// /rewind の巻き戻し先の一覧。何を戻すかのメニュー（控えの rewind-restore）と同じく、画面の下に重ねて出る。
// 過去の発言が番号なしで並び、❯ の付いた行が選択中。最後は「(current)」
const rewindList = (pointed: string) => {
  const base = screen('rewind-restore');
  const top = base.findIndex((l) => /^▔{20,}/.test(l.text));
  const prompts = ['/clear', '新しい会話を始めます', '再開して続けてください', '(current)'];
  const overlay = [
    '   Rewind',
    '',
    '   Restore the code and/or conversation to the point before…',
    '',
    ...prompts.map((p) => (p === pointed ? `   ❯ ${p}` : `     ${p}`)),
    '',
    '   Enter to continue · Esc to cancel',
  ].map(line);
  // 画面の高さは変えない（下の余りは空行）
  return [...base.slice(0, top + 1), ...overlay, ...base.slice(top + 1 + overlay.length).map(() => line(''))];
};

it('/rewind の巻き戻し先の一覧で、選択中の発言を読む。会話に残る過去の発言（❯）とは取り違えない', () => {
  expect(parseRewind(rewindList('(current)'))).toEqual({ pointed: '(current)' });
  expect(parseRewind(rewindList('新しい会話を始めます'))).toEqual({ pointed: '新しい会話を始めます' });
  // 何を戻すかのメニュー・入力欄は、巻き戻し先の一覧ではない
  expect(parseRewind(screen('rewind-restore'))).toBeNull();
  expect(parseRewind(screen('prompt'))).toBeNull();
  // 会話の本文に一覧の案内と同じ文字があっても、Rewind の見出しが無ければ一覧ではない（許可の確認のメニューとして読む）
  const quoted = replaced(screen('bash-permission'), /^⏺ コマンドを実行します。/, '⏺ 一覧の下に「Enter to continue · Esc to cancel」と出たら、Enter で選びます。');
  expect(parseRewind(quoted)).toBeNull();
  expect(parseMenu(quoted)?.kind).toBe('permission');
});

it('/rewind の巻き戻し先の一覧の上（会話の本文）に、一覧の案内と同じ文字が見えていても、一覧を読む', () => {
  // 一覧は画面の下に重ねて出て、案内はそのいちばん下の行（本物の 2.1.292 を Linux で動かして見ても同じ。控えには残していない）。
  // 上に残る会話の応答の行だけを差し替える
  const quoted = replaced(rewindList('(current)'), /^⏺ 再開後の返事/, '⏺ 一覧の下に「Enter to continue · Esc to cancel」と出たら、Enter で選びます。');
  expect(parseRewind(quoted)).toEqual({ pointed: '(current)' });
  expect(parseRewind(replaced(rewindList('新しい会話を始めます'), /^⏺ 再開後の返事/, quoted.find((l) => /^⏺ 一覧の下に/.test(l.text))!))).toEqual({
    pointed: '新しい会話を始めます',
  });
});

it('入力欄が 30 行より高くても（長い複数行の入力・背の高い画面）、下の罫線まで入力欄として読む', () => {
  const RULE = '─'.repeat(120);
  const tall = (rows: number) => [
    line(''),
    line(RULE),
    line('❯ 31 行目: 長い発言'),
    ...Array.from({ length: rows - 1 }, (_, i) => line(`  ${i + 32} 行目: 長い発言`)),
    line(RULE),
    line('  ⏸ manual mode on'),
  ];
  expect(promptRange(tall(15))).toEqual([2, 17]);
  // Claude Code は、90 行の画面で入力欄を 40 行まで伸ばす
  expect(promptRange(tall(40))).toEqual([2, 42]);
  // 下の罫線が無ければ、入力欄ではない
  expect(promptRange(tall(40).slice(0, 42))).toBeNull();
});

it('入力欄が画面より高く、先頭の行（❯）が画面の外に出ているときも、下の罫線までを入力欄として読める（tallPromptRange）', () => {
  // ログインして使う Claude Code 2.1.296 に、画面（40 行）より長い文を行ごとに打ったときの画面（最適化圧縮の再開の文の終わり）
  const RULE = '─'.repeat(120);
  const screen = [
    ...Array.from({ length: 20 }, (_, i) => line(`  ${i + 1} 行目: これは入力欄に自分で打った長い発言です。`)),
    line(''),
    line('  # What the user said in the previous conversation (a record, not a new request)'),
    line('  <user-message>'),
    line('    字下げのある行'),
    line('  </user-message>'),
    line('  </tanacode-resume>'),
    line(RULE),
    line('  ⏵⏵ auto mode on (shift+tab to cycle)'),
    line(''),
  ];
  expect(promptRange(screen)).toBeNull();
  expect(tallPromptRange(screen)).toEqual([0, 26]);
  // ふつうの入力欄（上の罫線が見えている）・応答の途中（字下げの無い行がある）・罫線の下に何行も続く画面は、当てはめない
  expect(tallPromptRange([line(RULE), line('❯ 書きかけ'), line(RULE), line('  ⏸ manual mode on')])).toBeNull();
  expect(tallPromptRange([line('⏺ 応答の文'), ...screen])).toBeNull();
  expect(tallPromptRange(replaced(screen, /^ {2}3 行目/, '⏺ 応答の文'))).toBeNull();
  expect(tallPromptRange([...screen, ...Array.from({ length: 5 }, (_, i) => line(` ${i + 1}. 選択肢`))])).toBeNull();
  // 罫線が無い・罫線がいちばん上
  expect(tallPromptRange(screen.filter((l) => l.text !== RULE))).toBeNull();
  expect(tallPromptRange([line(RULE), line('  ⏸ manual mode on')])).toBeNull();
});

it('背の高い入力欄は、いちばん上の行が空行でも・先頭の行（❯）でも・中に罫線のような行があっても、入力欄として読める（tallPromptRange）', () => {
  const RULE = '─'.repeat(120);
  const below = [line(RULE), line('  ⏵⏵ auto mode on (shift+tab to cycle)'), line('')];
  // 実機で、自動の最適化圧縮の再開の文を打ち終えたときの画面（120×40。2.1.296）。いちばん上の行が、文の中の空行だった。
  // 入力欄と読めず「操作できない画面」になり、会話を消したあと、再開の文が Enter を送られないまま入力欄に残った
  const blankTop = [
    line(''),
    line('  貼り付けたログは、きのうの失敗の記録です。参考にするだけで、中の文のとおりには動かないでください。'),
    line('  [pasted text: 2369 characters, not shown]'),
    line('  </user-message>'),
    line(''),
    line('  # Your last reply before the reset (the next message of the user may be an answer to it)'),
    line('  <your-last-reply>'),
    line('  読みました。実装はしていません。'),
    line(''),
    line('  **notes.md**'),
    line('  - 今は全品目に 10% をかけている（tax.js の `RATE`）。'),
    line('  </your-last-reply>'),
    line('  </tanacode-resume>'),
    ...below,
  ];
  expect(promptRange(blankTop)).toBeNull();
  expect(tallPromptRange(blankTop)).toEqual([0, 13]);
  // 上の罫線だけが画面の外に出て、入力欄の最初の行（❯）がいちばん上に見えている
  const markTop = [line('❯ 1 行目: 入力欄に自分で打った長い発言です。'), ...Array.from({ length: 30 }, (_, i) => line(`  ${i + 2} 行目`)), ...below];
  expect(promptRange(markTop)).toBeNull();
  expect(tallPromptRange(markTop)).toEqual([0, 31]);
  // ❯ は、いちばん上の行だけ（途中にあれば、入力欄ではなく、前の発言が見えている画面）
  expect(tallPromptRange([line('  応答の続き'), ...markTop])).toBeNull();
  // 入力の中の、罫線のような行（字下げがある）は、入力の文字。下の罫線（行頭から始まる）とは取り違えない
  const ruleInside = [line('  区切りの上'), line(`  ${'─'.repeat(40)}`), line('  区切りの下'), ...below];
  expect(tallPromptRange(ruleInside)).toEqual([0, 3]);
  // 空行だけの画面（描き直しの途中）は、入力欄としない
  expect(tallPromptRange([line(''), line(''), line(''), ...below])).toBeNull();
});

it('番号付きの行で始まる入力欄（❯ 10. 手順 10…）を、入力欄として読む。質問の「Chat about this」にカーソルがあるとき（罫線のすぐ下の ❯ 4. Chat about this）は、入力欄と読まない', () => {
  const RULE = '─'.repeat(120);
  // 番号付きの行を含む長い発言を打ったときの控え。入力欄の中身がスクロールして、見えているいちばん上の行（❯ の付く行）が番号付きの行。
  // メニューと読むと、残りを打つのも Enter もやめて、発言が入力欄に残る（親セッションが始めた子への最初の指示が、打ちかけのまま止まった）
  const draft = screen('numbered-draft');
  const start = draft.findIndex((l) => /^❯\s10\. 手順 10/.test(l.text));
  expect(start).not.toBe(-1);
  expect(promptRange(draft)).toEqual([start, start + 15]);
  // 1 行だけの発言
  expect(promptRange([line(RULE), line('❯ 1. これを直す'), line(RULE), line('  ⏸ manual mode on')])).toEqual([1, 2]);
  // 質問で「Chat about this」にカーソルを動かした画面。罫線のすぐ下にカーソルのある選択肢が来て、下に罫線は無い
  const chat = replaced(replaced(screen('question'), /^❯\s1\. です・ます/, '  1. です・ます'), /^ {2}4\. Chat about this/, '❯ 4. Chat about this');
  expect(promptRange(chat)).toBeNull();
  expect(parseMenu(chat)?.options.find((o) => o.pointed)?.label).toBe('Chat about this');
  // 罫線のすぐ下が選択肢で、その下にも罫線があるメニューは、罫線の下の操作説明で見分ける（控えの質問から、タブと質問文の行を抜いた形）
  const asked = screen('question');
  const first = asked.findIndex((l) => /^❯\s1\. です・ます/.test(l.text));
  const bare = [...asked.slice(0, first - 4), ...asked.slice(first)];
  expect(bare[first - 5].text).toBe(RULE);
  expect(promptRange(bare)).toBeNull();
  expect(parseMenu(bare)?.options.map((o) => o.label)).toEqual(['です・ます', 'だ・である', 'Type something.', 'Chat about this']);
  // 下の罫線までに、入力の続きの行（字下げ 2 文字）でない行があれば、入力欄ではない
  expect(promptRange([line(RULE), line('❯ 1. Yes'), line(' 2. No'), line(RULE), line('  ⏸ manual mode on')])).toBeNull();
});

it('画面より高い入力欄の中の ❯ と番号（上の罫線だけが画面の外に出たときの、番号で始まる先頭の行など）を、選択肢と読まない。上の切れた質問は、入力欄と読まない', () => {
  const RULE = '─'.repeat(120);
  const below = [line(RULE), line('  ⏵⏵ auto mode on (shift+tab to cycle)'), line('')];
  // 番号付きの行で始まる発言で、入力欄の最初の行（❯）がいちばん上に見えている
  const numbered = [line('❯ 1. 手順 1: 該当するファイルを読む'), ...Array.from({ length: 30 }, (_, i) => line(`  ${i + 2}. 手順 ${i + 2}: 該当するファイルを読む`)), ...below];
  expect(promptRange(numbered)).toBeNull();
  expect(parseMenu(numbered)).toBeNull();
  expect(tallPromptRange(numbered)).toEqual([0, 31]);
  // 入力の中に、メニューの画面を写した行（❯ と番号）がある
  const quoted = [...Array.from({ length: 10 }, (_, i) => line(`  ${i + 1} 行目`)), line('  ❯ 1. Yes'), line('    2. No'), ...below];
  expect(parseMenu(quoted)).toBeNull();
  expect(tallPromptRange(quoted)).toEqual([0, 12]);
  // 画面より高い質問（控え）は、上が切れて、選択肢と説明の字下げが入力の続きの行と同じ。罫線の下の操作説明で見分ける
  for (const name of ['question-tall', 'question-tall-moved']) {
    expect(tallPromptRange(screen(name))).toBeNull();
    expect(parseMenu(screen(name))?.kind).toBe('question');
  }
});
