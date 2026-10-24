import type { ChatEvent } from './chat';
import { activeCards, liveCards, liveLists, progressOf, traitsOf, type Card, type Checklist } from './checklist';
import { fill, language, locale, t, tFor, type Language } from './i18n';
import { promptOf, type CustomPrompts } from './prompts';
import { neutralizeTags, unwrapWholePaste } from './session-tools';

// 最適化圧縮。会話を要約にせず、会話を消して（/clear）、チェックリストから再開する。
// 流れは main の OptimizedCompact（src/main/optimized-compact.ts）が動かす。ここは、Claude に送る文と、画面に出す段階の形。
// 1. 仕上げ: 続きに要ることを、チェックリストに書かせる（handoffText）
// 2. 切り替え: /clear を送る
// 3. 再開の文: 新しい会話の最初の発言として送る（resumeText）。決定事項と「いまの状態」の中身・ユーザーの発言の原文・裏で動いているタスク
// どちらも、チャットのお知らせの行を開くと全文が人に見えるので、画面の言語で書く（chat.compactPrompt.*。英語に決め打ちしない）。
// 指示の文（1 と 3 の、データでないところ）は、利用者が変えられる（メニューの「Claude に送る文…」。shared/prompts.ts）。
// そのため、自動か・ターンの途中で止めたかは、本文ではなく囲みの属性に書いて見分ける（tagAttributes）。
// 会話ログから読み戻すときの目印（発言の原文の見出し・落とした件数）と、属性の無い前のバージョンの文の目印（自動の印・途中で止めた印）は、
// どの言語の文も見分ける。前のバージョンが英語で書いた会話ログも、英語の文言が前と同じなので読める

// 仕上げの頼みと、再開の文の囲み。チェックリストの MCP サーバーの説明に、この囲みは tanacode が送るものだと書いてある
export const HANDOFF_TAG = 'tanacode-handoff';
export const RESUME_TAG = 'tanacode-resume';
// アプリがターンの途中で止めて始めた自動の流れを、会話を消さずに取りやめたときに、止めたところから続けるよう頼む文の囲み。
// 止めたままにすると、作業が止まったまま誰も気づかない。本文は画面の言語の決まった文（利用者は変えられない。仕上げの頼みの
// 「作業を続けずにターンを終えて」を打ち消すだけの文なので）。チャットでは知らせとして出す（人の発言に数えない）
export const CANCELLED_TAG = 'tanacode-compact-cancelled';

// 流れの段階。finalizing: 仕上げのターン / clearing: /clear を送って、新しい会話になるのを待っている /
// resuming: 再開の文を送っている / waiting: 再開の文を送れず、入力欄が空くのを待っている
export type CompactPhase = 'finalizing' | 'clearing' | 'resuming' | 'waiting';

// 取りやめた・失敗した理由。interrupted: 仕上げを人が中断した / prompted: 仕上げの間に人が発言した /
// not-used: Claude がチェックリストのツールを 1 回も使わなかった / interleaved: 仕上げのあとに別のターンが続いた /
// not-cleared: /clear を送っても新しい会話にならなかった / exited: セッションが終了した / busy: 仕上げの頼みを送れなかった /
// usage-limit: 仕上げのターンが、プランの利用枠に当たって止まった（会話は消さない。枠が戻ったら、続きを頼む予約が入る）
export type CompactFailure = 'interrupted' | 'prompted' | 'not-used' | 'interleaved' | 'not-cleared' | 'exited' | 'busy' | 'usage-limit';

// 使えない理由。checklist-off: 「MCP の設定」でチェックリストを切っている / no-checklist: このセッションの Claude Code にチェックリストの MCP が足されていない
export type CompactUnavailable = 'checklist-off' | 'no-checklist';

// セッションごとの、最適化圧縮の状態（画面のボタンと「自動」のトグルに出す）。failure は、次に始めるまで残す。
// autoPercent: 自動で始める大きさ（コンテキストの割合。アプリ全体の設定）/ autoPaused: 自動で続けて失敗したので、このセッションでは休んでいる
export type CompactStatus = {
  phase: CompactPhase | null;
  failure: CompactFailure | null;
  unavailable: CompactUnavailable | null;
  autoPercent: number;
  autoPaused: boolean;
};

// 自動で始める大きさの選択肢と既定（コンテキストの割合）
export const AUTO_COMPACT_PERCENTS = [40, 60, 80] as const;
export const DEFAULT_AUTO_COMPACT_PERCENT = 80;
// ターンの途中で止める大きさ。設定より 10 ポイント上（上限 90%）。1 つのターンが長くて、ターンの終わりを待てないとき
export const AUTO_COMPACT_MID_TURN_MARGIN = 10;
export const AUTO_COMPACT_MID_TURN_MAX = 90;
export function midTurnPercent(percent: number): number {
  return Math.min(percent + AUTO_COMPACT_MID_TURN_MARGIN, AUTO_COMPACT_MID_TURN_MAX);
}

export const IDLE_COMPACT_STATUS: CompactStatus = { phase: null, failure: null, unavailable: null, autoPercent: DEFAULT_AUTO_COMPACT_PERCENT, autoPaused: false };

// 自動で始めたときの、始め方。percent: 始めたときのコンテキストの割合 /
// midTurn: ターンの途中で、アプリがツールの切れ目で止めた（止めた場所を再開の文に足す）。
// 切り替えたあとに続けるか待つかは、手動・自動とも、チェックリスト（「いまの状態」の、ユーザーの答えを待っているか）で決めさせる
export type AutoCompactTrigger = { percent: number; midTurn: boolean };

// 文を書ける言語。会話ログから読み戻すときは、どの言語で書いたものも見分ける（書いたときの画面の言語は分からない）
const LANGUAGES: readonly Language[] = ['ja', 'en'];

// 自動の切り替えの目印（仕上げの頼み・再開の文の中に入れる。チャットの知らせの行で、手動と見分ける）
const autoMark = (percent: number) => t('chat.compactPrompt.handoff.triggerAuto', { percent: Math.round(percent) });

// 文言の値（{count} や {percent}）のところを数の取り出しにした正規表現。言語ごとに 1 つ（数の値を印にするので、英語の単数形は入らない）。
// はじめて使うときに作る（t() はモジュールの読み込みでは呼ばない。CONTRIBUTING.md の「画面の言語」）
const patterns = new Map<string, RegExp[]>();
function numberPatterns(key: 'chat.compactPrompt.handoff.triggerAuto' | 'chat.compactPrompt.resume.omitted', name: string, flags = ''): RegExp[] {
  let list = patterns.get(key);
  if (!list) {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    list = LANGUAGES.map((lang) => {
      const [before, after = ''] = tFor(lang, key, { [name]: '\u0000' }).split('\u0000');
      return new RegExp(`${escape(before)}(\\d+)${escape(after)}`, flags);
    });
    patterns.set(key, list);
  }
  return list;
}

// 落とした発言の数の行の、英語の単数形と複数形（前のバージョンの文と同じ）
const ENGLISH_OMITTED = /^\((\d+) older messages? (?:is|are) not shown\.\)$/m;

// 前のバージョンの仕上げの頼み・再開の文（囲みに属性が無い）が、自動の切り替えのものなら、そのときのコンテキストの割合。手動なら null。
// 今の文は、囲みの属性で見分ける（parseCompactMessage・compactTriggerOf）
export function autoPercentOf(body: string): number | null {
  for (const pattern of numberPatterns('chat.compactPrompt.handoff.triggerAuto', 'percent')) {
    const m = pattern.exec(body);
    if (m) return Number(m[1]);
  }
  return null;
}

// ターンの途中で止めて切り替えたときの文の目印（仕上げの頼みの終わり・再開の文の頭に入る）。前のバージョンの英語の文の書き出しと、
// 今の文（言語ごと）。今の英語の文も、前の書き出しで始まる
const MID_TURN_HANDOFF = 'tanacode stopped your turn between tool calls';
const MID_TURN_RESUME = 'This reset happened in the middle of your turn';
const midTurnMarks = (key: 'chat.compactPrompt.handoff.autoMidTurn' | 'chat.compactPrompt.resume.midTurn', legacy: string) => [legacy, ...LANGUAGES.map((lang) => tFor(lang, key))];

// 前のバージョンの仕上げの頼み・再開の文（囲みに属性が無い）が、ターンの途中で止めた切り替えのものか。今の文は、囲みの属性で見分ける。
// カードや発言に同じ文が書かれていても拾わないよう、アプリが書くところ（再開の文は最初の見出しの前・仕上げの頼みは終わり）だけを見る
export function compactMidTurn(body: string): boolean {
  const head = body.indexOf('\n\n# ');
  const top = head === -1 ? body : body.slice(0, head);
  const end = body.slice(-700);
  return (
    midTurnMarks('chat.compactPrompt.resume.midTurn', MID_TURN_RESUME).some((mark) => top.includes(mark)) ||
    midTurnMarks('chat.compactPrompt.handoff.autoMidTurn', MID_TURN_HANDOFF).some((mark) => end.includes(mark))
  );
}

// 仕上げの頼み・再開の文の囲みの属性。自動か・そのときのコンテキストの割合・ターンの途中で止めたかを、本文ではなくここに書く
// （本文は利用者が変えられるので、本文の文では見分けられない）。手動にも trigger="manual" を書いて、属性の無い前のバージョンの文と分ける
function tagAttributes(auto: AutoCompactTrigger | null): string {
  if (!auto) return ' trigger="manual"';
  return ` trigger="auto" percent="${Math.round(auto.percent)}"${auto.midTurn ? ' mid-turn="true"' : ''}`;
}

const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;

// 囲みの属性から読んだ、始まり方（手動なら null）
function triggerOfAttributes(attributes: string): AutoCompactTrigger | null {
  const values = new Map([...attributes.matchAll(ATTRIBUTE)].map((m) => [m[1], m[2]] as const));
  const percent = Number(values.get('percent'));
  if (values.get('trigger') !== 'auto' || !Number.isFinite(percent)) return null;
  return { percent, midTurn: values.get('mid-turn') === 'true' };
}

// 属性の無い前のバージョンの文の始まり方。本文の目印の文で見分ける
function legacyTrigger(body: string): AutoCompactTrigger | null {
  const percent = autoPercentOf(body);
  return percent === null ? null : { percent, midTurn: compactMidTurn(body) };
}

// 知らせ（仕上げの頼み・再開の文）の始まり方（手動なら null）。chat.ts が会話ログの囲みから読んで付けたもの（trigger）を使う。
// 付いていない知らせ（会話ログから作っていないもの）は、本文の文で見分ける。
// 再開の文の始まり方がターンの途中で止めた自動なら、再開のあとは必ず作業の続き（止めたターンは作業の途中）。人への通知と、
// ほかのセッションに状態を返すとき（main の compact-notice.ts・sessions-control.ts）に、再開のあとの応答が作業の続きかどうかを見分ける
export function compactTriggerOf(notice: { detail?: string; trigger?: AutoCompactTrigger | null }): AutoCompactTrigger | null {
  return notice.trigger !== undefined ? notice.trigger : legacyTrigger(notice.detail ?? '');
}

// 自動のときの、仕上げの頼み。本文の始まり方（{trigger}）を「自動で始めた」にし（「ボタンが押された」と書いたまま、
// 終わりで「誰も押していない」と言うと、食い違う）、終わりに、自動であることと、途中で止めたときに書いておくことを足す
export function autoHandoffText(auto: AutoCompactTrigger, prompts: CustomPrompts = {}): string {
  return buildHandoff(prompts, auto);
}

// 再開の文の長さの上限（全体・カード・発言）と、1 つずつの長さ。
// カードの分は、仕上げで詳しく書かせたリスト（試作では、長い会話で全体 6,500〜12,400 文字）が切られない大きさにする
export const RESUME_MAX_CHARS = 40_000;
const CARDS_CHARS = 24_000;
const CARD_BODY_CHARS = 4000;
// 仕上げの頼みで、1 枚のカードをこの長さまでにして、超えるなら分けるよう伝える（CARD_BODY_CHARS より小さく。本文の {chars}）
export const HANDOFF_CARD_CHARS = 3000;
const MESSAGES_CHARS = 12_000;
const MESSAGE_CHARS = 3000;
const MAX_TASKS = 20;
const TASK_CHARS = 200;

// 仕上げの頼み。会話を消す前に、続きに要ることをチェックリストに書かせる。
// 新しい会話の Claude が頼れるのは、ここで書かれたリストと、ユーザーの発言の原文だけ。ざっくり頼むと、リストが短くなり、
// 正確な値（コマンドのオプション・関数の名前・タイムアウトの秒数など）が落ちる（長い会話 3 本・あとで要ったこと 48 問で測って、
// リストだけで答えられたのが 57%。項目を分けて詳しく頼んだ試作は 82%）。そのため、
// - 「いまの状態」のリストに書くものを、いまの状態・答え待ちか・試してやめたこと・場所と手順の 4 つの項目に分けて、別々のカードに書かせる。
//   答え待ちかは、再開のあとに続けるか待つかを、Claude がリストだけで決められるように、待っていないときも書かせる
//   （再開の文にそのまま入るのは、決定事項と「いまの状態」のカードの本文だけなので、別のリストにはしない）
// - 長さの上限は無いと伝える。長くなる話題は、削らずにカードを分けさせる（再開の文は、カードの本文を CARD_BODY_CHARS で切るため）
// - ツールの呼び出しは少なく（呼び出しのたびに、長い会話を読み直す）。card_add は 1 回で何枚も足せる
// 上は既定の文（prompts.ts の defaultPrompt）。利用者が変えた文（prompts）なら、それを送る。変えた文でリストが最新にならなくても、
// Claude がチェックリストのツールを 1 回も使わなければ、会話は消さない（main の OptimizedCompact の not-used）
export function handoffText(prompts: CustomPrompts = {}): string {
  return buildHandoff(prompts, null);
}

// 仕上げの頼みを組み立てる。本文の {trigger} は何で始まったか（手動はボタン・自動はそのときのコンテキストの割合）、{chars} は 1 枚のカードの長さの目安。
// 利用者が書いた文の囲みのタグ（<tanacode-…>）は打ち消す（囲みの本文に囲みのタグは入らない、という見分けの前提を崩さない。chat.ts）
function buildHandoff(prompts: CustomPrompts, auto: AutoCompactTrigger | null): string {
  const trigger = auto ? autoMark(auto.percent) : t('chat.compactPrompt.handoff.triggerManual');
  return [
    `<${HANDOFF_TAG}${tagAttributes(auto)}>`,
    fill(neutralizeTags(promptOf(prompts, 'handoff')), { trigger, chars: HANDOFF_CARD_CHARS.toLocaleString(locale()) }),
    ...(auto ? [neutralizeTags(promptOf(prompts, auto.midTurn ? 'handoffAutoMidTurn' : 'handoffAutoTurnEnd'))] : []),
    `</${HANDOFF_TAG}>`,
  ]
    .filter(Boolean)
    .join('\n');
}

// 引き継ぐ発言。fromParent: 親セッションの Claude からの指示
export type CarriedMessage = { text: string; fromParent: boolean };

// 裏で動いているタスク（アプリが追っているもの）
export type CarriedTask = { kind: 'bash' | 'agent' | 'workflow'; label: string };

// ターンの途中で止めた場所（アプリの記録。モデルには書かせない）。text: 止める直前の応答の文 /
// tools: 直前のツールの呼び出し（古い順）。result: 結果が返ったか（none は、返る前に止まった・記録が無い）
export type StoppedTool = { name: string; target: string; result: 'ok' | 'error' | 'none' };
export type StoppedAt = { text: string; tools: StoppedTool[] };

const STOPPED_TEXT_CHARS = 1000;
const STOPPED_TOOLS = 5;
// 切り替える前の最後の応答（ターンの終わりの切り替え・手動）を、再開の文に入れる長さと、囲み
const LAST_REPLY_CHARS = 3000;
const LAST_REPLY_TAG = 'your-last-reply';
const LAST_REPLY = new RegExp(`<${LAST_REPLY_TAG}>\\n([\\s\\S]*?)\\n</${LAST_REPLY_TAG}>`);

// 今の会話の、仕上げの頼み（知らせ）より前のイベント
function beforeHandoff(events: ChatEvent[]): ChatEvent[] {
  const current = currentConversation(events);
  let end = current.length;
  for (let i = current.length - 1; i >= 0; i--) {
    const event = current[i];
    if (event.type === 'notice' && event.compact === 'handoff') end = i;
    else if (event.type === 'user') break;
  }
  return current.slice(0, end);
}

// 切り替える前の、最後の応答（仕上げの頼みより前の、最後のターンの作業の応答。チェックリストを直した報告しか無ければ、それ）。
// ターンの終わりの応答は、質問や提案で終わることが多い。人は切り替えのあとに「B で」のように短く答えるので、再開の文に入れておく
export function lastReply(events: ChatEvent[]): string {
  const before = beforeHandoff(events);
  let work = '';
  let note = '';
  let stopped = false;
  for (const event of before) {
    if (event.type === 'user' || event.type === 'notice' || event.type === 'turn-start') {
      work = '';
      note = '';
      stopped = false;
    } else if (event.type === 'checklist-stop') stopped = true;
    else if (event.type === 'assistant-text') {
      if (stopped) note = event.text;
      else work = event.text;
    }
  }
  return work || note;
}

// 再開の文に入っている、切り替える前の最後の応答。無ければ null（アプリを起動し直したあと、切り替える前の会話が手元に無いときに使う）
export function lastReplyIn(body: string): string | null {
  return LAST_REPLY.exec(body)?.[1] ?? null;
}

// 会話（今の会話のイベント）から、止めた場所を取り出す。仕上げの頼み（知らせ）より前の、最後の応答の文と、直前のツールの呼び出し
export function stoppedAt(events: ChatEvent[]): StoppedAt {
  const before = beforeHandoff(events);
  const results = new Map<string, boolean>();
  for (const event of before) if (event.type === 'tool-result') results.set(event.id, event.isError);
  const tools: StoppedTool[] = [];
  let text = '';
  for (let i = before.length - 1; i >= 0; i--) {
    const event = before[i];
    // 止めたターンの中だけを見る
    if (event.type === 'user') break;
    if (event.type === 'tool-use' && tools.length < STOPPED_TOOLS) {
      tools.unshift({ name: event.name, target: event.target, result: results.has(event.id) ? (results.get(event.id) ? 'error' : 'ok') : 'none' });
    } else if (event.type === 'assistant-text' && !text) {
      text = event.text;
    }
  }
  return { text, tools };
}

// 発言の原文の見出し（見出しと説明の 2 行）。前の再開の文から発言を取り出すときの目印にもする（どの言語で書いたものも見分ける。
// 前のバージョンの英語の見出しは、今の英語の文言と同じ）
const messagesHead = (lang: Language = language()) => [tFor(lang, 'chat.compactPrompt.resume.messagesHeading'), tFor(lang, 'chat.compactPrompt.resume.messagesNote')];
const messagesHeads = () => LANGUAGES.map((lang) => messagesHead(lang));
const CARRIED_MESSAGE = /<user-message( from="[^"]*")?>\n([\s\S]*?)\n<\/user-message>/g;

// 今の会話（最後の /clear よりあと）のイベント
function currentConversation(events: ChatEvent[]): ChatEvent[] {
  let from = 0;
  events.forEach((e, i) => {
    if (e.type === 'reset') from = i + 1;
  });
  return events.slice(from);
}

// 前の再開の文（今の会話に残っている再開の知らせの全文）の、発言の原文のところ。無ければ null
function carriedSection(event: ChatEvent): string | null {
  if (event.type !== 'notice' || event.compact !== 'resume' || !event.detail) return null;
  // 見出しは 1 つだけ（中に入れる文の、見出しと同じ文は打ち消してある。inertHead）
  const detail = event.detail;
  const at = messagesHeads()
    .map((head) => detail.indexOf(head.join('\n')))
    .find((i) => i !== -1);
  return at === undefined ? null : detail.slice(at);
}

// 会話（今の会話ログのイベント）から、引き継ぐ発言を古い順に取り出す。人の発言と、親セッションからの指示だけ。
// スラッシュコマンド・アプリが送った知らせは入らない。前の /clear（reset）より前の発言は、会話のイベントには無いが、
// 前の再開の文に入っていた分は、今の会話に残っている再開の知らせから取り出して引き継ぐ。何度切り替えても、
// 新しい発言から順に残り、古いものから落ちる（上限は resumeText）
export function carriedMessages(events: ChatEvent[]): CarriedMessage[] {
  const messages: CarriedMessage[] = [];
  for (const event of currentConversation(events)) {
    const section = carriedSection(event);
    if (section !== null) {
      for (const m of section.matchAll(CARRIED_MESSAGE)) messages.push({ text: m[2], fromParent: m[1] !== undefined });
      continue;
    }
    if (event.type !== 'user' || event.command) continue;
    const text = carriedText(event);
    if (text) messages.push({ text, fromParent: !!event.parent });
  }
  return messages;
}

// 引き継ぐ発言の文。入力欄に貼り付けた長い文（札）の中身は入れず、あったことだけを残す。貼り付けはユーザーの言葉とは限らない
// （ログや Web の文章）ので、「ユーザーの発言の原文」に混ぜない。全体が 1 つの貼り付けだった発言（札だけを送ったもの）も同じ
function carriedText(event: Extract<ChatEvent, { type: 'user' }>): string {
  const pastes = event.pasted ? [event.text] : (event.pastes ?? []);
  const notes = pastes.map((paste) => t('chat.compactPrompt.resume.pasted', { count: paste.length }));
  return [event.pasted ? '' : event.text.trim(), ...notes].filter(Boolean).join('\n');
}

// 前の再開の文で、もう入りきらずに落とした発言の数（次の再開の文の件数に足す）
export function carriedOmitted(events: ChatEvent[]): number {
  let omitted = 0;
  for (const event of currentConversation(events)) {
    const section = carriedSection(event);
    const count = section === null ? undefined : [ENGLISH_OMITTED, ...numberPatterns('chat.compactPrompt.resume.omitted', 'count', 'm')].map((pattern) => section.match(pattern)?.[1]).find(Boolean);
    if (count) omitted += Number(count);
  }
  return omitted;
}

// 再開の文。lists: セッションのチェックリスト / messages: 引き継ぐ発言（古い順）/ tasks: 裏で動いているタスク /
// omitted: これまでの切り替えで、もう落とした発言の数 /
// auto: 自動で切り替えたとき（無ければ手動）。auto.midTurn なら、止めた場所（stopped）を足す /
// reply: 切り替える前の最後の応答（ターンの終わりの切り替え・手動のとき。途中で止めたときは stopped に入っている）/
// handoffSkipped: 仕上げができなかった（上限に当たったあとなど）ので、リストは切り替えの前のまま /
// prompts: 利用者が変えた指示の文（変えていなければ既定の文。prompts.ts）。データ（カード・発言の原文など）と囲みは、いつも tanacode が足す
export function resumeText({
  lists,
  messages,
  tasks,
  omitted = 0,
  auto,
  stopped,
  reply = '',
  handoffSkipped = false,
  prompts = {},
}: {
  lists: Checklist[];
  messages: CarriedMessage[];
  tasks: CarriedTask[];
  omitted?: number;
  auto?: AutoCompactTrigger;
  stopped?: StoppedAt;
  reply?: string;
  handoffSkipped?: boolean;
  prompts?: CustomPrompts;
}): string {
  const live = liveLists(lists);
  const midTurn = !!auto?.midTurn;
  const trigger = auto ? autoMark(auto.percent) : t('chat.compactPrompt.handoff.triggerManual');
  const parts = [
    // 指示の文。ターンの途中で止めたときは、止めた場所（下の stoppedSection）を見させる文に替える。
    // 仕上げができなかったときは、リストが古いかもしれないことを終わりに足す。
    // 利用者が書いた文の、囲みのタグと、発言の原文・最後の応答の目印（囲みと見出し）は、カードと同じく打ち消す（inert）。
    // 打ち消さないと、そのあとのデータが囲みの外に見えたり、次の切り替えで、利用者の文が発言の原文や最後の応答として読まれたりする
    [fill(inert(promptOf(prompts, midTurn ? 'resumeMidTurn' : 'resume')), { trigger }), handoffSkipped ? inert(promptOf(prompts, 'resumeSkipped')) : ''].filter(Boolean).join('\n'),
    cardsSection(live),
    otherListsSection(live),
    messagesSection(messages, omitted),
    midTurn ? '' : lastReplySection(reply),
    midTurn && stopped ? stoppedSection(stopped) : '',
    tasksSection(tasks),
  ].filter(Boolean);
  const open = `<${RESUME_TAG}${tagAttributes(auto ?? null)}>`;
  const close = `</${RESUME_TAG}>`;
  const body = clipEnd(parts.join('\n\n'), RESUME_MAX_CHARS - open.length - close.length - 2);
  return `${open}\n${body}\n${close}`;
}

// 決定事項と「いまの状態」のカード（題名と本文）。収まらなければ、古いカードから題名だけにする
function cardsSection(live: Checklist[]): string {
  const pinned = live.filter((list) => traitsOf(list).pinned);
  if (pinned.length === 0) return [t('chat.compactPrompt.resume.cardsHeading'), t('chat.compactPrompt.resume.cardsNone')].join('\n');
  const cardsOf = (list: Checklist) => (traitsOf(list).locked ? activeCards(list) : liveCards(list));
  const titleOnly = new Set<Card>();
  const build = () =>
    pinned
      .map((list) => {
        const cards = cardsOf(list);
        const kind = t(traitsOf(list).locked ? 'chat.compactPrompt.resume.kindDecisions' : 'chat.compactPrompt.resume.kindState');
        return [
          t('chat.compactPrompt.resume.listHeading', { name: line(list.name, 80), kind }),
          ...(list.description ? [t('chat.compactPrompt.resume.description', { text: line(list.description, 300) })] : []),
          ...cards.map((c) => cardText(c, !titleOnly.has(c))),
          ...(cards.length === 0 ? [t('chat.compactPrompt.resume.noCards')] : []),
        ].join('\n');
      })
      .join('\n\n');
  const oldestFirst = pinned.flatMap(cardsOf).sort((a, b) => a.createdAt - b.createdAt);
  let text = build();
  for (const card of oldestFirst) {
    if (text.length <= CARDS_CHARS) break;
    if (!card.body.trim()) continue;
    titleOnly.add(card);
    text = build();
  }
  return clipEnd(text, CARDS_CHARS);
}

function cardText(card: Card, withBody: boolean): string {
  const title = `## #${card.number} ${line(card.title, 300)}`;
  const body = inert(card.body).trim();
  if (!body) return title;
  if (!withBody) return `${title}\n${t('chat.compactPrompt.resume.bodyNotShown')}`;
  return `${title}\n${body.length > CARD_BODY_CHARS ? `${body.slice(0, CARD_BODY_CHARS)}${t('chat.compactPrompt.resume.bodyCut')}` : body}`;
}

// ほかのリストは、名前・説明・枚数だけ。中身はツールで読ませる
function otherListsSection(live: Checklist[]): string {
  const others = live.filter((list) => !traitsOf(list).pinned);
  if (others.length === 0) return '';
  return [
    t('chat.compactPrompt.resume.otherHeading'),
    ...others.map((list) => {
      const { done, total } = progressOf(list);
      const name = line(list.name, 80);
      return list.description
        ? t('chat.compactPrompt.resume.otherListDescribed', { name, done, total, description: line(list.description, 300) })
        : t('chat.compactPrompt.resume.otherList', { name, done, total });
    }),
  ].join('\n');
}

// ユーザーの発言の原文。新しいものから上限まで選び、古い順に並べる。入りきらない分は件数を伝える
function messagesSection(messages: CarriedMessage[], omittedBefore: number): string {
  const head = messagesHead();
  if (messages.length === 0 && omittedBefore === 0) return [...head, t('chat.compactPrompt.resume.noMessages')].join('\n');
  const fromParentAttr = ` from="${t('chat.compactPrompt.resume.fromParent')}"`;
  const chosen: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { text, fromParent } = messages[i];
    // 発言の中の閉じタグでは、発言の囲みを閉じさせない。見出しと同じ文も、次の切り替えで見出しと取り違えないよう打ち消す
    const body = shorten(inertReply(inertHead(neutralizeTags(text))).replaceAll('</user-message', '＜/user-message').trim(), MESSAGE_CHARS);
    const entry = `<user-message${fromParent ? fromParentAttr : ''}>\n${body}\n</user-message>`;
    // いちばん新しい発言は、上限を超えても入れる
    if (chosen.length > 0 && used + entry.length > MESSAGES_CHARS) break;
    chosen.unshift(entry);
    used += entry.length;
  }
  const omitted = messages.length - chosen.length + omittedBefore;
  return [...head, ...(omitted > 0 ? [t('chat.compactPrompt.resume.omitted', { count: omitted })] : []), ...chosen].join('\n');
}

// 切り替える前の、最後の応答。人は、これに答えているかもしれない（「B で」「それで進めて」）
function lastReplySection(reply: string): string {
  const text = inert(reply).trim();
  if (!text) return '';
  return [
    t('chat.compactPrompt.resume.lastReplyHeading'),
    t('chat.compactPrompt.resume.lastReplyNote'),
    `<${LAST_REPLY_TAG}>\n${shorten(text, LAST_REPLY_CHARS)}\n</${LAST_REPLY_TAG}>`,
  ].join('\n');
}

// ターンの途中で止めた場所。アプリが会話ログから機械的に取り出したもの
function stoppedSection(stopped: StoppedAt): string {
  const results = { ok: t('chat.compactPrompt.resume.resultOk'), error: t('chat.compactPrompt.resume.resultError'), none: t('chat.compactPrompt.resume.resultNone') };
  const text = inert(stopped.text).trim();
  const toolLine = (tool: StoppedTool) =>
    tool.target
      ? t('chat.compactPrompt.resume.toolLine', { name: line(tool.name, 80), target: line(tool.target, TASK_CHARS), result: results[tool.result] })
      : t('chat.compactPrompt.resume.toolLineNoTarget', { name: line(tool.name, 80), result: results[tool.result] });
  return [
    t('chat.compactPrompt.resume.stoppedHeading'),
    ...(text ? [t('chat.compactPrompt.resume.stoppedText'), text.length > STOPPED_TEXT_CHARS ? `…${text.slice(-STOPPED_TEXT_CHARS)}` : text] : []),
    ...(stopped.tools.length > 0 ? [t('chat.compactPrompt.resume.stoppedTools'), ...stopped.tools.map(toolLine)] : [t('chat.compactPrompt.resume.stoppedNoTools')]),
  ].join('\n');
}

// /clear のあとの会話には、裏で動いているものがあるとは伝わらないので、ここで伝える
function tasksSection(tasks: CarriedTask[]): string {
  if (tasks.length === 0) return '';
  const names = { bash: t('chat.compactPrompt.resume.taskBash'), agent: t('chat.compactPrompt.resume.taskAgent'), workflow: t('chat.compactPrompt.resume.taskWorkflow') };
  const shown = tasks.slice(0, MAX_TASKS);
  return [
    t('chat.compactPrompt.resume.tasksHeading'),
    t('chat.compactPrompt.resume.tasksNote'),
    ...shown.map((task) => t('chat.compactPrompt.resume.taskLine', { kind: names[task.kind], label: line(task.label, TASK_CHARS) })),
    ...(tasks.length > shown.length ? [t('chat.compactPrompt.resume.tasksMore', { count: tasks.length - shown.length })] : []),
  ].join('\n');
}

// 長い発言は、頭 7 割と終わり 3 割を残す
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n${t('chat.compactPrompt.resume.shortened', { count: text.length - max })}\n${text.slice(text.length - (max - head))}`;
}

// 発言の原文の見出しと同じ文を、見出しとして読めなくする（# を全角にする。どの言語の見出しも）。再開の文の中に、本物の見出しを 1 つだけにする
function inertHead(text: string): string {
  return messagesHeads().reduce((inerted, [heading]) => inerted.replaceAll(heading, `＃${heading.slice(1)}`), text);
}

// 最後の応答の囲みと同じ文を、囲みとして読めなくする（再開の文から最後の応答を取り出すときに、取り違えないように）
function inertReply(text: string): string {
  return text.replace(new RegExp(`<(/?)(${LAST_REPLY_TAG})`, 'gi'), '＜$1$2');
}

// 発言でないところ（カードの題名と本文・リストの名前と説明・タスクの名前）に入れる文。人や別のセッション、Claude が写したページの文が入る。
// 目印の囲み（<tanacode-…>）のほか、発言の囲み（<user-message>）と見出しも打ち消す。打ち消さないと、次の切り替えで
// 前の再開の文から発言を取り出すときに、カードに書かれた文が「ユーザーの発言の原文」として引き継がれる
function inert(text: string): string {
  return inertReply(inertHead(neutralizeTags(text))).replace(/<(\/?)(user-message)/gi, '＜$1$2');
}

function clipEnd(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 20)}\n${t('chat.compactPrompt.resume.cutEnd')}` : text;
}

// 人や別のセッションが書いたもの（リストの名前・題名・タスクの名前）を 1 行にして、囲みを閉じるタグを効かなくする
function line(text: string, max: number): string {
  const flat = inert(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const COMPACT_MESSAGE = new RegExp(`^<(${HANDOFF_TAG}|${RESUME_TAG})((?: [\\w-]+="[^"]*")*)>([\\s\\S]*)</\\1>$`);
const COMPACT_OPEN = new RegExp(`^<(?:${HANDOFF_TAG}|${RESUME_TAG})[ >]`);

// 会話ログの発言が、仕上げの頼みか再開の文なら、どちらかと中身と始まり方（trigger。手動なら null）。
// 始まり方は囲みの属性から読む。属性の無い前のバージョンの文は、本文の目印の文で見分ける。
// 前のアプリは長い文を丸ごと貼り付けで送っていたので、前の会話ログでは、目印のタグごと貼り付けの囲み（<pasted_content>）に
// 入っている。先に外す（今は stream-json の発言として送るので、囲みは付かない）
export function parseCompactMessage(text: string): { kind: 'handoff' | 'resume'; body: string; trigger: AutoCompactTrigger | null } | null {
  const m = unwrapWholePaste(text).trim().match(COMPACT_MESSAGE);
  if (!m) return null;
  const body = m[3].trim();
  return { kind: m[1] === HANDOFF_TAG ? 'handoff' : 'resume', body, trigger: m[2] ? triggerOfAttributes(m[2]) : legacyTrigger(body) };
}

// 自動の最適化圧縮が、ターンの途中（ツールのあとのフック）で止めるときの理由（フックの答えの stopReason。Claude Code の画面に出る）。
// 会話ログには、コマンドの無い「止めた」記録（hook_stopped_continuation）として、この文だけが残る。チャットでユーザーのフックと
// 見分ける目印にするので、文を変えるときは、前の文も見分けられるようにする（isAutoCompactStop）。percent: 分からなければ null
export function autoCompactStopReason(percent: number | null): string {
  return `tanacode: the context is ${percent === null ? 'almost' : `${Math.round(percent)}%`} full, so tanacode stops here to reset the conversation and resume from the checklists (optimized compaction).`;
}

const AUTO_COMPACT_STOP = /^tanacode: the context is (?:almost|\d+%) full, so tanacode stops here to reset the conversation and resume from the checklists \(optimized compaction\)\.$/;

// 止めた理由が、自動の最適化圧縮のものか（文の全体で見る。ユーザーのフックが文を引いていても拾わない）。前のバージョンのアプリも同じ文
export function isAutoCompactStop(reason: string): boolean {
  return AUTO_COMPACT_STOP.test(reason.trim());
}

// ターンの途中で止めた自動の流れを取りやめたときの、続きを頼む文（CANCELLED_TAG）
export function cancelledText(): string {
  return [`<${CANCELLED_TAG}>`, t('chat.compactPrompt.cancelled'), `</${CANCELLED_TAG}>`].join('\n');
}

const CANCELLED_MESSAGE = new RegExp(`^<${CANCELLED_TAG}>([\\s\\S]*)</${CANCELLED_TAG}>$`);

// 会話ログの発言が、取りやめたあとの続きを頼む文なら、その本文
export function parseCompactCancelled(text: string): { body: string } | null {
  const m = unwrapWholePaste(text).trim().match(CANCELLED_MESSAGE);
  return m ? { body: m[1].trim() } : null;
}

// Claude Code の入力欄に残った文字が、仕上げの頼みか再開の文か（順番待ちの行・入力欄の下書きで、人の発言として扱わないため）
export function isCompactMessage(text: string): boolean {
  // 入力欄や順番待ちでは、閉じる側が無いこともあるので、開く側だけを外す
  const head = text.trimStart().replace(/^<pasted_content(?: id="[^"]*")?>\s*/, '');
  return COMPACT_OPEN.test(head);
}
