import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '../src/shared/i18n';
import { toChatEvents, type ChatEvent, type TranscriptEntry } from '../src/shared/chat';
import {
  autoHandoffText,
  compactTriggerOf,
  handoffText,
  HANDOFF_TAG,
  isCompactMessage,
  parseCompactMessage,
  RESUME_MAX_CHARS,
  RESUME_TAG,
  resumeText,
} from '../src/shared/optimized-compact';
import { changedPrompts, customPromptsOf, defaultPrompt, PROMPT_KEYS, PROMPT_MAX_CHARS, promptOf } from '../src/shared/prompts';
import { parseUsageResume, USAGE_RESUME_TAG, usageResumeText } from '../src/shared/usage-limit';
import { AppSettings } from '../src/main/app-settings';
import { turnStarterOf, resumeContinued } from '../src/main/compact-notice';

// tanacode が人の代わりに Claude に送る文のうち、利用者が変えられるもの（メニューの「Claude に送る文…」。shared/prompts.ts）。
// 変えた文が届くこと・既定に戻すと既定の文が届くこと・文を変えても、自動か・ターンの途中で止めたかを囲みの属性で見分けられること

const entry = (content: string): TranscriptEntry => ({ type: 'user', uuid: 'u1', message: { role: 'user', content } }) as TranscriptEntry;
// 会話ログから作った知らせ（chat.ts が、囲みの属性から始まり方を付ける）
const noticeOf = (text: string) => toChatEvents(entry(text), '/w')[0] as Extract<ChatEvent, { type: 'notice' }>;
// 前のバージョンの文（囲みに属性が無い）
const legacy = (text: string) => text.replace(/^<(tanacode-[\w-]+)[^>]*>/, '<$1>');
const EMPTY = { lists: [], messages: [], tasks: [] };

afterEach(() => setLanguage('ja'));

describe('既定の文と、変えた文', () => {
  it('既定の文は画面の言語で、差し込みの印（{trigger}・{chars}）は印のまま', () => {
    for (const lang of ['ja', 'en'] as const) {
      setLanguage(lang);
      expect(defaultPrompt('usageResume').split('\n')[0]).toBe(t('schedule.usageResume.intro'));
      expect(defaultPrompt('handoff')).toContain(t('chat.compactPrompt.handoff.intro'));
      expect(defaultPrompt('handoff')).toContain('{trigger}');
      expect(defaultPrompt('handoff')).toContain('{chars}');
      expect(defaultPrompt('handoffAutoTurnEnd')).toBe(t('chat.compactPrompt.handoff.autoTurnEnd'));
      expect(defaultPrompt('handoffAutoMidTurn')).toBe(t('chat.compactPrompt.handoff.autoMidTurn'));
      expect(defaultPrompt('resume')).toContain(t('chat.compactPrompt.resume.continue'));
      expect(defaultPrompt('resume')).not.toContain(t('chat.compactPrompt.resume.midTurn'));
      expect(defaultPrompt('resumeMidTurn')).toContain(t('chat.compactPrompt.resume.midTurn'));
      expect(defaultPrompt('resumeMidTurn')).toContain(t('chat.compactPrompt.resume.continueMidTurn'));
      expect(defaultPrompt('resumeMidTurn')).toContain(t('chat.compactPrompt.resume.verifyMidTurn'));
      expect(defaultPrompt('resumeSkipped')).toBe(t('chat.compactPrompt.resume.skipped'));
    }
  });

  it('送る文は、変えた欄ならそれ（前後の空白は落とす）、無ければ既定の文', () => {
    expect(promptOf({}, 'usageResume')).toBe(defaultPrompt('usageResume'));
    expect(promptOf({ usageResume: '\n  続けて \n' }, 'usageResume')).toBe('続けて');
    expect(promptOf({ usageResume: '続けて' }, 'handoff')).toBe(defaultPrompt('handoff'));
  });

  it('保存するのは、既定の文と違う欄だけ（前後の空白だけの違いは、変えていないもの）', () => {
    expect(changedPrompts({ usageResume: `${defaultPrompt('usageResume')}\n`, handoff: '仕上げて', resume: defaultPrompt('resume') })).toEqual({ handoff: '仕上げて' });
    expect(changedPrompts({})).toEqual({});
  });

  it('設定のファイル・画面から受けた値は、知っている欄の、空でない文字列だけにする。長すぎる文は上限で切る', () => {
    expect(customPromptsOf(null)).toEqual({});
    expect(customPromptsOf('文')).toEqual({});
    expect(customPromptsOf(['文'])).toEqual({});
    expect(customPromptsOf({ usageResume: '続けて', handoff: '  ', resume: 3, other: '知らない欄', resumeSkipped: 'x'.repeat(PROMPT_MAX_CHARS + 5) })).toEqual({
      usageResume: '続けて',
      resumeSkipped: 'x'.repeat(PROMPT_MAX_CHARS),
    });
    expect(PROMPT_KEYS).toHaveLength(7);
  });
});

describe('アプリの設定（settings.json の prompts）', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'tanacode-prompts-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('変えた欄だけを覚える。無い・読めない値は、既定の文（何も変えていない）', () => {
    const file = join(dir, 'settings.json');
    expect(new AppSettings(file).prompts()).toEqual({});
    new AppSettings(file).setPrompts({ resume: '報告して待って' });
    expect(new AppSettings(file).prompts()).toEqual({ resume: '報告して待って' });
    expect(JSON.parse(readFileSync(file, 'utf8')).prompts).toEqual({ resume: '報告して待って' });
    // 既定に戻した（空にした）
    new AppSettings(file).setPrompts({});
    expect(new AppSettings(file).prompts()).toEqual({});
    writeFileSync(file, JSON.stringify({ version: 1, prompts: { resume: 1, usageResume: '続けて' } }));
    expect(new AppSettings(file).prompts()).toEqual({ usageResume: '続けて' });
    writeFileSync(file, JSON.stringify({ version: 1, prompts: '壊れた値' }));
    expect(new AppSettings(file).prompts()).toEqual({});
  });
});

describe('利用枠からの再開', () => {
  it('変えた文を、囲みに入れて送る。見分けるのは囲みだけなので、変えた文も再開のメッセージとして読める', () => {
    const text = usageResumeText({ usageResume: '枠が戻りました。報告して待ってください。' });
    expect(text).toBe(`<${USAGE_RESUME_TAG}>\n枠が戻りました。報告して待ってください。\n</${USAGE_RESUME_TAG}>`);
    expect(parseUsageResume(text)).toEqual({ body: '枠が戻りました。報告して待ってください。' });
    expect(noticeOf(text)).toMatchObject({ type: 'notice', text: t('chat.transcript.usageLimitResume'), detail: '枠が戻りました。報告して待ってください。' });
    // 既定に戻すと、既定の文
    expect(usageResumeText({})).toBe(`<${USAGE_RESUME_TAG}>\n${defaultPrompt('usageResume')}\n</${USAGE_RESUME_TAG}>`);
  });
});

describe('最適化圧縮の仕上げの頼み', () => {
  it('変えた本文の {trigger}・{chars} を値に置き換えて送る。知らない印はそのまま。自動のときは、変えた「足す文」を終わりに足す', () => {
    const prompts = { handoff: 'リストを最新にして{trigger}。1 枚は {chars} 文字まで。{other}', handoffAutoTurnEnd: '（自動・終わり）', handoffAutoMidTurn: '（自動・途中）' };
    expect(handoffText(prompts)).toBe(`<${HANDOFF_TAG} trigger="manual">\nリストを最新にして${t('chat.compactPrompt.handoff.triggerManual')}。1 枚は 3,000 文字まで。{other}\n</${HANDOFF_TAG}>`);
    expect(autoHandoffText({ percent: 83.4, midTurn: false }, prompts)).toBe(
      `<${HANDOFF_TAG} trigger="auto" percent="83">\nリストを最新にして（自動・コンテキスト 83%）。1 枚は 3,000 文字まで。{other}\n（自動・終わり）\n</${HANDOFF_TAG}>`,
    );
    expect(autoHandoffText({ percent: 91, midTurn: true }, prompts)).toBe(
      `<${HANDOFF_TAG} trigger="auto" percent="91" mid-turn="true">\nリストを最新にして（自動・コンテキスト 91%）。1 枚は 3,000 文字まで。{other}\n（自動・途中）\n</${HANDOFF_TAG}>`,
    );
    // 本文だけ変えたときは、足す文は既定の文
    expect(autoHandoffText({ percent: 83, midTurn: false }, { handoff: '仕上げて' })).toContain(`仕上げて\n${defaultPrompt('handoffAutoTurnEnd')}\n</${HANDOFF_TAG}>`);
  });

  it('既定に戻すと、既定の文を送る', () => {
    expect(handoffText({})).toBe(handoffText());
    expect(parseCompactMessage(handoffText({}))!.body).toContain('tanacode は、この会話を圧縮する代わりに、これから消します（ユーザーが「最適化圧縮」のボタンを押しました）。');
  });
});

describe('最適化圧縮のあとの再開の文', () => {
  const CARRIED = { lists: [], messages: [{ text: '税率を可変にして', fromParent: false }], tasks: [{ kind: 'bash' as const, label: 'npm run dev' }] };

  it('変えた指示の文のあとに、tanacode がデータ（リスト・発言の原文・最後の応答・タスク）を足す', () => {
    const text = resumeText({ ...CARRIED, reply: 'A と B のどちらに？', prompts: { resume: '会話を消しました{trigger}。報告して待ってください。' } });
    const body = parseCompactMessage(text)!.body;
    expect(body.startsWith(`会話を消しました${t('chat.compactPrompt.handoff.triggerManual')}。報告して待ってください。\n\n${t('chat.compactPrompt.resume.cardsHeading')}`)).toBe(true);
    expect(body).toContain(`${t('chat.compactPrompt.resume.messagesHeading')}\n`);
    expect(body).toContain('<user-message>\n税率を可変にして\n</user-message>');
    expect(body).toContain('<your-last-reply>\nA と B のどちらに？\n</your-last-reply>');
    expect(body).toContain('- Bash: npm run dev');
    expect(body).not.toContain(t('chat.compactPrompt.resume.truth'));
  });

  it('ターンの途中で止めたときは、途中で止めたときの本文に替え、止めた場所を足す。仕上げができなかったときは、本文の終わりに足す', () => {
    const prompts = { resume: '手動の本文', resumeMidTurn: '途中の本文{trigger}', resumeSkipped: '（リストが古いかも）' };
    const mid = parseCompactMessage(resumeText({ ...CARRIED, auto: { percent: 91, midTurn: true }, stopped: { text: '直しています', tools: [] }, prompts }))!.body;
    expect(mid.startsWith('途中の本文（自動・コンテキスト 91%）\n\n')).toBe(true);
    expect(mid).toContain(t('chat.compactPrompt.resume.stoppedHeading'));
    expect(mid).not.toContain('手動の本文');
    const skipped = parseCompactMessage(resumeText({ ...CARRIED, auto: { percent: 83, midTurn: false }, handoffSkipped: true, prompts }))!.body;
    expect(skipped.startsWith('手動の本文\n（リストが古いかも）\n\n')).toBe(true);
    // 仕上げができたときは足さない
    expect(parseCompactMessage(resumeText({ ...CARRIED, auto: { percent: 83, midTurn: false }, prompts }))!.body).not.toContain('リストが古いかも');
  });

  it('既定の文で、仕上げができなかったときの文は、指示の終わり（データの前）に入る', () => {
    const body = parseCompactMessage(resumeText({ ...CARRIED, auto: { percent: 83, midTurn: false }, handoffSkipped: true }))!.body;
    const instructions = body.slice(0, body.indexOf('\n\n'));
    expect(instructions.endsWith(`${t('chat.compactPrompt.resume.language')}\n${t('chat.compactPrompt.resume.skipped')}`)).toBe(true);
  });

  it('長い指示の文でも、全体は上限に収める', () => {
    const text = resumeText({ ...CARRIED, prompts: { resume: 'あ'.repeat(PROMPT_MAX_CHARS) }, messages: Array.from({ length: 40 }, (_, i) => ({ text: `${i} ${'い'.repeat(2900)}`, fromParent: false })) });
    expect(text.length).toBeLessThanOrEqual(RESUME_MAX_CHARS);
    expect(text.endsWith(`\n</${RESUME_TAG}>`)).toBe(true);
  });
});

describe('始まり方の見分け（囲みの属性）', () => {
  // 印になる文を 1 つも含まない、変えた文
  const PLAIN = { handoff: '仕上げて', handoffAutoTurnEnd: '自動', handoffAutoMidTurn: '途中', resume: '再開', resumeMidTurn: '途中から再開' };

  it('文を変えても、自動か・そのときの割合・ターンの途中で止めたかを、囲みの属性から読む（チャットの知らせの行も、手動と見分ける）', () => {
    const manual = parseCompactMessage(handoffText(PLAIN))!;
    expect(manual).toEqual({ kind: 'handoff', body: '仕上げて', trigger: null });
    expect(parseCompactMessage(autoHandoffText({ percent: 83, midTurn: false }, PLAIN))!.trigger).toEqual({ percent: 83, midTurn: false });
    expect(parseCompactMessage(autoHandoffText({ percent: 91, midTurn: true }, PLAIN))!.trigger).toEqual({ percent: 91, midTurn: true });
    const midResume = resumeText({ ...EMPTY, auto: { percent: 91, midTurn: true }, stopped: { text: '', tools: [] }, prompts: PLAIN });
    expect(noticeOf(midResume)).toMatchObject({ compact: 'resume', text: t('chat.transcript.compactResumeAuto', { percent: 91 }), trigger: { percent: 91, midTurn: true } });
    expect(noticeOf(resumeText({ ...EMPTY, prompts: PLAIN }))).toMatchObject({ compact: 'resume', text: t('chat.transcript.compactResume'), trigger: null });
    expect(noticeOf(autoHandoffText({ percent: 83, midTurn: false }, PLAIN))).toMatchObject({ compact: 'handoff', text: t('chat.transcript.compactHandoffAuto', { percent: 83 }) });
  });

  it('通知: 変えた文でも、ターンの途中で止めた再開は作業の続き。手動の再開は、ツールを見て決める', () => {
    const mid = noticeOf(resumeText({ ...EMPTY, auto: { percent: 91, midTurn: true }, stopped: { text: '', tools: [] }, prompts: PLAIN }));
    const manual = noticeOf(resumeText({ ...EMPTY, prompts: PLAIN }));
    expect(turnStarterOf(mid)).toBe('other');
    expect(resumeContinued(mid, [])).toBe(true);
    expect(turnStarterOf(manual)).toBe('resume');
    expect(resumeContinued(manual, [])).toBe(false);
  });

  it('属性の無い前のバージョンの文は、本文の目印の文で見分ける。手動の文に、自動の目印に似た文があっても、属性があれば属性で決める', () => {
    expect(parseCompactMessage(legacy(autoHandoffText({ percent: 91, midTurn: true })))!.trigger).toEqual({ percent: 91, midTurn: true });
    expect(parseCompactMessage(legacy(resumeText({ ...EMPTY, auto: { percent: 83, midTurn: false } })))!.trigger).toEqual({ percent: 83, midTurn: false });
    expect(parseCompactMessage(legacy(handoffText()))!.trigger).toBeNull();
    // 変えた文が、たまたま自動の目印と同じ文を含んでいても、属性（手動）で決める
    expect(parseCompactMessage(handoffText({ handoff: `前に${t('chat.compactPrompt.handoff.triggerAuto', { percent: 70 })}で切り替えた` }))!.trigger).toBeNull();
    // 始まり方の付いていない知らせ（会話ログから作っていないもの）は、本文の文で見分ける
    expect(compactTriggerOf({ detail: parseCompactMessage(autoHandoffText({ percent: 88, midTurn: false }))!.body })).toEqual({ percent: 88, midTurn: false });
    expect(compactTriggerOf({ detail: '再開', trigger: { percent: 70, midTurn: true } })).toEqual({ percent: 70, midTurn: true });
    expect(compactTriggerOf({})).toBeNull();
  });

  it('属性の書き方が違う・足りないものは、手動として読む。囲みの名前が違うものは、仕上げの頼み・再開の文ではない', () => {
    expect(parseCompactMessage(`<${RESUME_TAG} trigger="auto">x</${RESUME_TAG}>`)!.trigger).toBeNull();
    expect(parseCompactMessage(`<${RESUME_TAG} trigger="auto" percent="abc">x</${RESUME_TAG}>`)!.trigger).toBeNull();
    expect(parseCompactMessage(`<${RESUME_TAG} trigger="manual" mid-turn="true">x</${RESUME_TAG}>`)!.trigger).toBeNull();
    expect(parseCompactMessage(`<${RESUME_TAG} trigger=auto>x</${RESUME_TAG}>`)).toBeNull();
    expect(parseCompactMessage(`<${RESUME_TAG}-x>x</${RESUME_TAG}-x>`)).toBeNull();
    expect(isCompactMessage(`<${HANDOFF_TAG} trigger="auto" percent="80">\n書きかけ`)).toBe(true);
    expect(isCompactMessage(`<${HANDOFF_TAG}>\n書きかけ`)).toBe(true);
    expect(isCompactMessage(`<${HANDOFF_TAG}-x>`)).toBe(false);
  });
});
