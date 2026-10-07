import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type { ScreenLine } from '@shared/screen';
import { findMode, findModel, isStreaming, parseMenu, parseRewind, parseSpinner, promptRange } from '../src/main/screen-parser';

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
