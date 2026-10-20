import { t, type MessageKey } from './i18n';

// tanacode が人の代わりに Claude に送る文のうち、利用者が変えられるところ（メニューの「Claude に送る文…」）。
// 変えられるのは指示の文だけ。囲み（tanacode が見分けに使う）と、差し込むデータ（カード・発言の原文など）は、tanacode が足し続ける。
// 変えた欄だけを、アプリ全体の設定（settings.json の prompts）に持つ。持っていない欄は、既定の文（画面の言語）。
// usageResume: 利用枠からの再開 / handoff: 最適化圧縮の仕上げの頼み（手動・自動とも）/
// handoffAutoTurnEnd・handoffAutoMidTurn: 自動のときに、仕上げの頼みの終わりに足す文（ターンの終わりに始めた・ターンの途中で止めた）/
// resume: 再開の文（手動・ターンの終わりの自動）/ resumeMidTurn: 再開の文（ターンの途中で止めた自動）/
// resumeSkipped: 仕上げができなかったときに、再開の文の終わりに足す文
export const PROMPT_KEYS = ['usageResume', 'handoff', 'handoffAutoTurnEnd', 'handoffAutoMidTurn', 'resume', 'resumeMidTurn', 'resumeSkipped'] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];
export type CustomPrompts = Partial<Record<PromptKey, string>>;

// 画面での分け方（文ごと）。kind は文言のキーにも使う
export const PROMPT_GROUPS: readonly { kind: 'usageResume' | 'handoff' | 'resume'; keys: readonly PromptKey[] }[] = [
  { kind: 'usageResume', keys: ['usageResume'] },
  { kind: 'handoff', keys: ['handoff', 'handoffAutoTurnEnd', 'handoffAutoMidTurn'] },
  { kind: 'resume', keys: ['resume', 'resumeMidTurn', 'resumeSkipped'] },
];

// 欄ごとに使える差し込みの印。trigger: どう始まったか（手動・自動とそのときのコンテキストの割合）/
// chars: 1 枚のカードの長さの目安（超えるなら分けさせる）
export const PROMPT_PLACEHOLDERS: Record<PromptKey, readonly ('trigger' | 'chars')[]> = {
  usageResume: [],
  handoff: ['trigger', 'chars'],
  handoffAutoTurnEnd: [],
  handoffAutoMidTurn: [],
  resume: ['trigger'],
  resumeMidTurn: ['trigger'],
  resumeSkipped: [],
};

// 1 つの欄の長さの上限。再開の文は全体で RESUME_MAX_CHARS までなので、長すぎると、終わりの差し込むデータが切れる
export const PROMPT_MAX_CHARS = 10_000;

const lines = (keys: MessageKey[]) => keys.map((key) => t(key)).join('\n');

// 再開の文の、ターンの終わり（手動も）と、ターンの途中で止めたときで違うところ
const resumeLines = (midTurn: boolean): MessageKey[] => [
  'chat.compactPrompt.resume.intro',
  'chat.compactPrompt.resume.truth',
  'chat.compactPrompt.resume.permission',
  'chat.compactPrompt.resume.read',
  ...(midTurn ? (['chat.compactPrompt.resume.midTurn'] as const) : []),
  // 続けるか待つかは、この文で一律に決めない。仕上げで「いまの状態」に書かせた、ユーザーの答えを待っているかで決めさせる。
  // 続けるときの歯止め（進めていた作業だけ・許可が要るなら聞く・はっきりしなければ待つ）は、どの場合も同じ
  'chat.compactPrompt.resume.decide',
  // 待つときに、ほかのツール（ファイルの確かめなど）を使わせない。使うと、tanacode が作業を続けたターンと見分けられない（compact-notice.ts）
  'chat.compactPrompt.resume.waiting',
  midTurn ? 'chat.compactPrompt.resume.continueMidTurn' : 'chat.compactPrompt.resume.continue',
  'chat.compactPrompt.resume.underWay',
  'chat.compactPrompt.resume.ask',
  'chat.compactPrompt.resume.unclear',
  midTurn ? 'chat.compactPrompt.resume.verifyMidTurn' : 'chat.compactPrompt.resume.verify',
  // 報告の言語。英語で書いていた頃、何も言わないと、日本語の会話なのに英語で報告することがあった（Haiku で起きた）
  'chat.compactPrompt.resume.language',
];

// 既定の文（画面の言語）。差し込みの印（{trigger}・{chars}）は、印のまま返す（送るときに、tanacode が値に置き換える）
export function defaultPrompt(key: PromptKey): string {
  switch (key) {
    case 'usageResume':
      return lines([
        'schedule.usageResume.intro',
        'schedule.usageResume.check',
        'schedule.usageResume.waiting',
        'schedule.usageResume.continue',
        'schedule.usageResume.ask',
        'schedule.usageResume.verify',
      ]);
    case 'handoff':
      return lines([
        'chat.compactPrompt.handoff.intro',
        'chat.compactPrompt.handoff.start',
        'chat.compactPrompt.handoff.calls',
        'chat.compactPrompt.handoff.decisions',
        'chat.compactPrompt.handoff.stateList',
        'chat.compactPrompt.handoff.state',
        'chat.compactPrompt.handoff.waiting',
        'chat.compactPrompt.handoff.tried',
        'chat.compactPrompt.handoff.pointers',
        'chat.compactPrompt.handoff.todos',
        'chat.compactPrompt.handoff.closing',
      ]);
    case 'handoffAutoTurnEnd':
      return t('chat.compactPrompt.handoff.autoTurnEnd');
    case 'handoffAutoMidTurn':
      return t('chat.compactPrompt.handoff.autoMidTurn');
    case 'resume':
      return lines(resumeLines(false));
    case 'resumeMidTurn':
      return lines(resumeLines(true));
    case 'resumeSkipped':
      return t('chat.compactPrompt.resume.skipped');
  }
}

// 送る文（変えた文。変えていなければ既定の文）。前後の空白・空行は落とす
export function promptOf(custom: CustomPrompts, key: PromptKey): string {
  return (custom[key] ?? defaultPrompt(key)).trim();
}

// 既定の文と同じ欄を外す（変えた欄だけを持つ。既定の文が画面の言語やバージョンで変わっても、変えていない欄はそれに付いていく）
export function changedPrompts(custom: CustomPrompts): CustomPrompts {
  const out: CustomPrompts = {};
  for (const key of PROMPT_KEYS) {
    const text = custom[key];
    if (text !== undefined && text.trim() !== defaultPrompt(key).trim()) out[key] = text;
  }
  return out;
}

// 画面から送る、変えた欄（null は既定に戻す）。ダイアログで変えた欄だけを送り、main が今の保存の値に重ねる
// （2 つの窓でダイアログを開いて保存しても、片方で変えた欄を、もう片方の保存で消さない）
export type PromptChanges = Partial<Record<PromptKey, string | null>>;

// 今の保存の値に、変えた欄を重ねる。空の文は既定に戻す。既定の文と同じになった欄は持たない
export function applyPromptChanges(current: CustomPrompts, changes: PromptChanges): CustomPrompts {
  const next: CustomPrompts = { ...current };
  for (const key of PROMPT_KEYS) {
    if (!Object.hasOwn(changes, key)) continue;
    const text = changes[key];
    if (typeof text === 'string' && text.trim()) next[key] = text.slice(0, PROMPT_MAX_CHARS);
    else delete next[key];
  }
  return changedPrompts(next);
}

// 画面から受け取った、変えた欄。知っている欄の、文字列か null だけにする
export function promptChangesOf(value: unknown): PromptChanges {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: PromptChanges = {};
  for (const key of PROMPT_KEYS) {
    const text = record[key];
    if (typeof text === 'string' || text === null) out[key] = text;
  }
  return out;
}

// 設定のファイル・画面から受け取った値を、知っている欄の、空でない文だけにする（長すぎる文は上限で切る）
export function customPromptsOf(value: unknown): CustomPrompts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: CustomPrompts = {};
  for (const key of PROMPT_KEYS) {
    const text = record[key];
    if (typeof text === 'string' && text.trim()) out[key] = text.slice(0, PROMPT_MAX_CHARS);
  }
  return out;
}
