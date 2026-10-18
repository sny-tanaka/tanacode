import type { ChatEvent } from './chat';
import { activeCards, liveCards, liveLists, progressOf, traitsOf, type Card, type Checklist } from './checklist';
import type { Language } from './i18n';
import { neutralizeTags, unwrapWholePaste } from './session-tools';

// 最適化圧縮。会話を要約にせず、会話を消して（/clear）、チェックリストから再開する。
// 流れは main の OptimizedCompact（src/main/optimized-compact.ts）が動かす。ここは、Claude に送る文と、画面に出す段階の形。
// 1. 仕上げ: 続きに要ることを、チェックリストに書かせる（handoffText）
// 2. 切り替え: /clear を送る
// 3. 再開の文: 新しい会話の最初の発言として送る（resumeText）。決定事項と「いまの状態」の中身・ユーザーの発言の原文・裏で動いているタスク
// Claude だけが読む文なので、英語で書く

// 仕上げの頼みと、再開の文の囲み。チェックリストの MCP サーバーの説明に、この囲みは tanacode が送るものだと書いてある
export const HANDOFF_TAG = 'tanacode-handoff';
export const RESUME_TAG = 'tanacode-resume';

// 流れの段階。finalizing: 仕上げのターン / clearing: /clear を送って、新しい会話になるのを待っている /
// resuming: 再開の文を送っている / waiting: 再開の文を送れず、入力欄が空くのを待っている
export type CompactPhase = 'finalizing' | 'clearing' | 'resuming' | 'waiting';

// 取りやめた・失敗した理由。interrupted: 仕上げを人が中断した / prompted: 仕上げの間に人が発言した /
// not-used: Claude がチェックリストのツールを 1 回も使わなかった / interleaved: 仕上げのあとに別のターンが続いた /
// not-cleared: /clear を送っても新しい会話にならなかった / exited: セッションが終了した / busy: 仕上げの頼みを送れなかった
export type CompactFailure = 'interrupted' | 'prompted' | 'not-used' | 'interleaved' | 'not-cleared' | 'exited' | 'busy';

// 使えない理由。checklist-off: 「Claude にチェックリストを扱わせる」がオフ / no-checklist: このセッションの Claude Code にチェックリストの MCP が足されていない
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

// 自動の切り替えの目印（仕上げの頼み・再開の文の中に入れる。チャットの知らせの行で、手動と見分ける）
const autoMark = (percent: number) => `(automatic; context ${Math.round(percent)}% full)`;
const AUTO_MARK = /\(automatic; context (\d+)% full\)/;

// 仕上げの頼み・再開の文が、自動の切り替えのものなら、そのときのコンテキストの割合。手動なら null
export function autoPercentOf(body: string): number | null {
  const m = AUTO_MARK.exec(body);
  return m ? Number(m[1]) : null;
}

// ターンの途中で止めて切り替えたときの文の目印（仕上げの頼みの終わり・再開の文の頭に入る）
const MID_TURN_HANDOFF = 'tanacode stopped your turn between tool calls';
const MID_TURN_RESUME = 'This reset happened in the middle of your turn';

// 仕上げの頼み・再開の文が、ターンの途中で止めた切り替えのものか（止めたターンは作業の途中なので、再開のあとは必ず作業の続き）。
// 人への通知とほかのセッションに状態を返すとき（main の compact-notice.ts・sessions-control.ts）に、再開のあとの応答が作業の続きかどうかを見分ける。
// カードや発言に同じ文が書かれていても拾わないよう、アプリが書くところ（再開の文は最初の見出しの前・仕上げの頼みは終わり）だけを見る
export function compactMidTurn(body: string): boolean {
  const head = body.indexOf('\n\n# ');
  return (head === -1 ? body : body.slice(0, head)).includes(MID_TURN_RESUME) || body.slice(-700).includes(MID_TURN_HANDOFF);
}

// 自動のときの、仕上げの頼み。アプリの仕上げの頼み（handoffText）の書き出しを「自動で始めた」に替え（「ボタンが押された」と書いたまま、
// 終わりで「誰も押していない」と言うと、食い違う）、終わりに、自動であることと、途中で止めたときに書いておくことを足す
export function autoHandoffText(auto: AutoCompactTrigger): string {
  const note = [
    'This reset is automatic: the user did not press anything and is not watching for a question.',
    auto.midTurn
      ? `${MID_TURN_HANDOFF}, and after the reset you will continue the same work. So, in the state list, also write exactly where you stopped: the step that was in progress, whether your last tool calls finished and what they returned, and the very next action to take.`
      : 'After the reset you will pick the work up from the state list: you will continue it, unless the list says that you are waiting for an answer.',
  ].join(' ');
  const closing = `</${HANDOFF_TAG}>`;
  const text = handoffText(autoMark(auto.percent));
  const at = text.lastIndexOf(closing);
  return `${text.slice(0, at)}${note}\n${closing}`;
}

// 再開の文の長さの上限（全体・カード・発言）と、1 つずつの長さ。
// カードの分は、仕上げで詳しく書かせたリスト（試作では、長い会話で全体 6,500〜12,400 文字）が切られない大きさにする
export const RESUME_MAX_CHARS = 40_000;
const CARDS_CHARS = 24_000;
const CARD_BODY_CHARS = 4000;
// 仕上げの頼みで、1 枚のカードをこの長さまでにして、超えるなら分けるよう伝える（CARD_BODY_CHARS より小さく）
const HANDOFF_CARD_CHARS = 3000;
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
// trigger: 何で始まったか（手動はボタン。自動は autoHandoffText が、そのときのコンテキストの割合の目印に替える）
export function handoffText(trigger = '(the user pressed the "optimized compaction" button)'): string {
  return [
    `<${HANDOFF_TAG}>`,
    `tanacode is about to reset this conversation instead of compacting it ${trigger}. Nothing from this conversation will be kept, and no summary is made. After the reset you start like a new session: the project instructions are loaded again, and you are given only the checklists (tanacode-checklist), the messages of the user verbatim, and the list of background tasks. So bring the checklists up to date now, with the checklist tools, and write down everything that is needed to continue the work without this conversation. Do not continue the task itself, and do not ask the user anything.`,
    'Start by calling checklist_overview, even if you think the lists are already up to date or you read them a moment ago: if you do not use a checklist tool in this turn, tanacode cancels the reset. Then compare the lists with this conversation, and add what is missing and fix what is out of date.',
    'Use few tool calls, because every call re-reads this whole conversation: card_add takes many cards at once, and card_delete, card_check and card_revoke take several numbers at once. Write all the new cards of a list in one card_add call instead of one call per card. Do not write less to save calls.',
    '- Decisions list (kind "decisions"): what the user asked for, required, corrected or approved, with the scope of each approval or permission, and the options that were rejected and why. Quote the user\'s own words where the wording matters. Add what is missing, and revoke what no longer holds.',
    '- State list (kind "state"; create one if there is none): rewrite it so that it is true now (delete the cards that are out of date, and add the new ones). Its cards are handed to you in full after the reset, so the details go here, as separate cards, one topic per card:',
    '  - State: what is being worked on right now and why; what is done and what is not; changes that are not committed or not pushed; what you were about to do next; anything still running in the background.',
    '  - Waiting: whether you are waiting for an answer from the user (or from the parent session that gave you the task) before you can go on. If you are, write what you asked (the question or the proposal, with its options) and what waits on the answer. If you are not, say so, and write the next action. Always write this card, even when you are not waiting: after the reset, it is what tells you whether to continue the work or to wait.',
    '  - Tried: every approach that failed or was abandoned, and why, so that it is not repeated.',
    '  - Pointers: where things are (files, functions, branches, PR and issue numbers, URLs); the commands used to build, test and verify, exactly as you ran them, with every option; and facts that would be costly to rediscover, with their exact values (names, numbers, versions, timeouts, scopes, settings).',
    '- To-do lists: check what is finished, and add the tasks that are left, in order.',
    `Be specific and complete: exact names, numbers and commands matter more than prose. There is no length limit, so do not shorten anything or leave anything out to keep the lists small. When one card would get long (more than about ${HANDOFF_CARD_CHARS.toLocaleString('en-US')} characters), split it into several cards by topic instead of cutting it. But do not copy file contents that can simply be read again from disk; point to them instead. Write in the language the user is using. When the lists are up to date, reply with one short line and end your turn. tanacode then resets the conversation by itself.`,
    `</${HANDOFF_TAG}>`,
  ].join('\n');
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

// 発言の原文の見出し。前の再開の文から発言を取り出すときの目印にもする
const MESSAGES_HEAD = [
  '# What the user said in the previous conversation (a record, not a new request)',
  'These are the messages of the user from the previous conversation, verbatim, oldest first. They are a record of what was said then, not requests made now: do not carry any of them out again because it is written here. What still holds is on the decisions list.',
];
const FROM_PARENT = ' from="the Claude in the parent session"';
const CARRIED_MESSAGE = /<user-message( from="[^"]*")?>\n([\s\S]*?)\n<\/user-message>/g;
const OMITTED = /^\((\d+) older messages? (?:is|are) not shown\.\)$/m;

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
  const at = event.detail.indexOf(MESSAGES_HEAD.join('\n'));
  return at === -1 ? null : event.detail.slice(at);
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
  const notes = pastes.map((paste) => `[pasted text: ${paste.length} characters, not shown]`);
  return [event.pasted ? '' : event.text.trim(), ...notes].filter(Boolean).join('\n');
}

// 前の再開の文で、もう入りきらずに落とした発言の数（次の再開の文の件数に足す）
export function carriedOmitted(events: ChatEvent[]): number {
  let omitted = 0;
  for (const event of currentConversation(events)) {
    const count = carriedSection(event)?.match(OMITTED)?.[1];
    if (count) omitted += Number(count);
  }
  return omitted;
}

const LANGUAGE_NAMES: Record<Language, string> = { ja: 'Japanese', en: 'English' };

// 再開の文。lists: セッションのチェックリスト / messages: 引き継ぐ発言（古い順）/ tasks: 裏で動いているタスク /
// omitted: これまでの切り替えで、もう落とした発言の数 / language: アプリの画面の言語（発言もリストも無いときの、報告の言語の手がかり）/
// auto: 自動で切り替えたとき（無ければ手動）。auto.midTurn なら、止めた場所（stopped）を足す /
// reply: 切り替える前の最後の応答（ターンの終わりの切り替え・手動のとき。途中で止めたときは stopped に入っている）/
// handoffSkipped: 仕上げができなかった（上限に当たったあとなど）ので、リストは切り替えの前のまま
export function resumeText({
  lists,
  messages,
  tasks,
  omitted = 0,
  language,
  auto,
  stopped,
  reply = '',
  handoffSkipped = false,
}: {
  lists: Checklist[];
  messages: CarriedMessage[];
  tasks: CarriedTask[];
  omitted?: number;
  language?: Language;
  auto?: AutoCompactTrigger;
  stopped?: StoppedAt;
  reply?: string;
  handoffSkipped?: boolean;
}): string {
  const live = liveLists(lists);
  const midTurn = !!auto?.midTurn;
  const parts = [
    [
      `tanacode reset the conversation instead of compacting it ${auto ? autoMark(auto.percent) : '(the user pressed the "optimized compaction" button)'}. No summary was made. Below is everything that was carried over from the previous conversation.`,
      ...(handoffSkipped
        ? [
            '- The wrap-up before this reset could not run (the request failed, most likely because the context was full). So the lists were NOT brought up to date: they are as they were before, and may be out of date or incomplete. Use the messages of the user below as well, check against the files, and ask the user when something that matters is missing.',
          ]
        : []),
      '- The checklists (tanacode-checklist) are the source of truth. Where things disagree, follow them in this order: the decisions list, then the project instructions (CLAUDE.md and the like).',
      '- A permission the user gave in the previous conversation carries over only if it is written on the decisions list.',
      '- First read all the lists with checklist_overview, and read the cards whose bodies are not shown in full below with card_get.',
      ...(midTurn
        ? [
            `- ${MID_TURN_RESUME}: tanacode stopped you between tool calls because the context was filling up. The user did not interrupt you and is not waiting to be asked. "Where the turn was stopped" below shows where you were.`,
          ]
        : []),
      // 続けるか待つかは、この文で一律に決めない。仕上げで「いまの状態」に書かせた、ユーザーの答えを待っているかで決めさせる。
      // 続けるときの歯止め（進めていた作業だけ・許可が要るなら聞く・はっきりしなければ待つ）は、どの場合も同じ
      '- Then decide from the state list whether you are waiting for an answer from the user (or from the parent session that gave you the task):',
      // 待つときに、ほかのツール（ファイルの確かめなど）を使わせない。使うと、tanacode が作業を続けたターンと見分けられない（compact-notice.ts）
      '  - If you are (you asked a question or made a proposal, and it has not been answered), tell the user briefly what you carried over and what you are waiting for, and wait for the answer. Do not use other tools for this (checking the files can wait until you go on).',
      `  - If you are not, tell the user in one line that the conversation was reset and what you are picking up, then continue the work that was in progress from where it stopped (the state list${midTurn ? ', and "Where the turn was stopped" below' : ''}).`,
      '- Continue only the work that was already under way. Do not start anything new.',
      '- If the next step needs a permission or a decision that is not on the decisions list, stop and ask the user.',
      '- If the state list does not make clear whether you are waiting or what was in progress, or the work is already finished, do not guess: tell the user briefly what you carried over (what the work is, where it stands and what comes next), and wait.',
      `- When you continue, a step may have taken effect without the lists saying so (a commit, a push, a file write)${midTurn ? ', above all a tool call listed below without a result' : ''}. Check the actual state before you do it again.`,
      // この文は英語なので、何も言わないと英語で報告することがある（Haiku で起きた）
      `- Write to the user in the language the user is using: the language of their messages below and of the lists, not the language of this message (tanacode writes it in English).${language ? ` If neither tells you, use ${LANGUAGE_NAMES[language]}, the language of the user's tanacode.` : ''}`,
    ].join('\n'),
    cardsSection(live),
    otherListsSection(live),
    messagesSection(messages, omitted),
    midTurn ? '' : lastReplySection(reply),
    midTurn && stopped ? stoppedSection(stopped) : '',
    tasksSection(tasks),
  ].filter(Boolean);
  const body = clipEnd(parts.join('\n\n'), RESUME_MAX_CHARS - RESUME_TAG.length * 2 - 10);
  return `<${RESUME_TAG}>\n${body}\n</${RESUME_TAG}>`;
}

// 決定事項と「いまの状態」のカード（題名と本文）。収まらなければ、古いカードから題名だけにする
function cardsSection(live: Checklist[]): string {
  const pinned = live.filter((list) => traitsOf(list).pinned);
  if (pinned.length === 0) return '# Decisions and state\n(There is no decisions list and no state list. Read what there is with checklist_overview.)';
  const cardsOf = (list: Checklist) => (traitsOf(list).locked ? activeCards(list) : liveCards(list));
  const titleOnly = new Set<Card>();
  const build = () =>
    pinned
      .map((list) => {
        const cards = cardsOf(list);
        const kind = traitsOf(list).locked ? 'decisions in force' : 'state, as you last wrote it';
        return [
          `# ${line(list.name, 80)} (${kind})`,
          ...(list.description ? [`Description: ${line(list.description, 300)}`] : []),
          ...cards.map((c) => cardText(c, !titleOnly.has(c))),
          ...(cards.length === 0 ? ['(no cards)'] : []),
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
  if (!withBody) return `${title}\n(body not shown; read it with card_get)`;
  return `${title}\n${body.length > CARD_BODY_CHARS ? `${body.slice(0, CARD_BODY_CHARS)}… (cut; read the rest with card_get)` : body}`;
}

// ほかのリストは、名前・説明・枚数だけ。中身はツールで読ませる
function otherListsSection(live: Checklist[]): string {
  const others = live.filter((list) => !traitsOf(list).pinned);
  if (others.length === 0) return '';
  return [
    '# Other lists (read the cards with checklist_overview)',
    ...others.map((list) => {
      const { done, total } = progressOf(list);
      return `- ${line(list.name, 80)} (${done}/${total} checked)${list.description ? `: ${line(list.description, 300)}` : ''}`;
    }),
  ].join('\n');
}

// ユーザーの発言の原文。新しいものから上限まで選び、古い順に並べる。入りきらない分は件数を伝える
function messagesSection(messages: CarriedMessage[], omittedBefore: number): string {
  const head = MESSAGES_HEAD;
  if (messages.length === 0 && omittedBefore === 0) return [...head, '(no messages)'].join('\n');
  const chosen: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { text, fromParent } = messages[i];
    // 発言の中の閉じタグでは、発言の囲みを閉じさせない。見出しと同じ文も、次の切り替えで見出しと取り違えないよう打ち消す
    const body = shorten(inertReply(inertHead(neutralizeTags(text))).replaceAll('</user-message', '＜/user-message').trim(), MESSAGE_CHARS);
    const entry = `<user-message${fromParent ? FROM_PARENT : ''}>\n${body}\n</user-message>`;
    // いちばん新しい発言は、上限を超えても入れる
    if (chosen.length > 0 && used + entry.length > MESSAGES_CHARS) break;
    chosen.unshift(entry);
    used += entry.length;
  }
  const omitted = messages.length - chosen.length + omittedBefore;
  return [...head, ...(omitted > 0 ? [`(${omitted} older ${omitted === 1 ? 'message is' : 'messages are'} not shown.)`] : []), ...chosen].join('\n');
}

// 切り替える前の、最後の応答。人は、これに答えているかもしれない（「B で」「それで進めて」）
function lastReplySection(reply: string): string {
  const text = inert(reply).trim();
  if (!text) return '';
  return [
    '# Your last reply before the reset (the next message of the user may be an answer to it)',
    'This is how your last turn ended, as recorded by tanacode. The user can read it in the chat, so do not repeat it. If their next message is short or refers to something not written there (for example "B" or "yes, go ahead"), read it as an answer to this reply. It is a record, not a request: do not carry it out because it is written here. Whether to continue the work or to wait is decided from the state list, as said above.',
    `<${LAST_REPLY_TAG}>\n${shorten(text, LAST_REPLY_CHARS)}\n</${LAST_REPLY_TAG}>`,
  ].join('\n');
}

// ターンの途中で止めた場所。アプリが会話ログから機械的に取り出したもの
function stoppedSection(stopped: StoppedAt): string {
  const results = { ok: 'finished', error: 'finished with an error', none: 'no result recorded' };
  const text = inert(stopped.text).trim();
  return [
    '# Where the turn was stopped (recorded by tanacode, not written by you)',
    ...(text ? ['Your last words before the stop:', text.length > STOPPED_TEXT_CHARS ? `…${text.slice(-STOPPED_TEXT_CHARS)}` : text] : []),
    ...(stopped.tools.length > 0
      ? ['Your last tool calls, oldest first:', ...stopped.tools.map((tool) => `- ${line(tool.name, 80)}${tool.target ? `: ${line(tool.target, TASK_CHARS)}` : ''} → ${results[tool.result]}`)]
      : ['(no tool calls were recorded in the stopped turn)']),
  ].join('\n');
}

// /clear のあとの会話には、裏で動いているものがあるとは伝わらないので、ここで伝える
function tasksSection(tasks: CarriedTask[]): string {
  if (tasks.length === 0) return '';
  const names = { bash: 'Bash', agent: 'Subagent', workflow: 'Workflow' };
  const shown = tasks.slice(0, MAX_TASKS);
  return [
    '# Background tasks',
    'These were running in the background when the conversation was reset, and keep running. A notice arrives when one of them finishes.',
    ...shown.map((task) => `- ${names[task.kind]}: ${line(task.label, TASK_CHARS)}`),
    ...(tasks.length > shown.length ? [`(${tasks.length - shown.length} more)`] : []),
  ].join('\n');
}

// 長い発言は、頭 7 割と終わり 3 割を残す
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n[… ${text.length - max} characters cut …]\n${text.slice(text.length - (max - head))}`;
}

// 発言の原文の見出しと同じ文を、見出しとして読めなくする（# を全角にする）。再開の文の中に、本物の見出しを 1 つだけにする
function inertHead(text: string): string {
  return text.replaceAll(MESSAGES_HEAD[0], `＃${MESSAGES_HEAD[0].slice(1)}`);
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
  return text.length > max ? `${text.slice(0, max - 20)}\n… (cut)` : text;
}

// 人や別のセッションが書いたもの（リストの名前・題名・タスクの名前）を 1 行にして、囲みを閉じるタグを効かなくする
function line(text: string, max: number): string {
  const flat = inert(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const COMPACT_MESSAGE = new RegExp(`^<(${HANDOFF_TAG}|${RESUME_TAG})>([\\s\\S]*)</\\1>$`);

// 会話ログの発言が、仕上げの頼みか再開の文なら、どちらかと中身。
// 前のアプリは長い文を丸ごと貼り付けで送っていたので、前の会話ログでは、目印のタグごと貼り付けの囲み（<pasted_content>）に
// 入っている。先に外す（今は stream-json の発言として送るので、囲みは付かない）
export function parseCompactMessage(text: string): { kind: 'handoff' | 'resume'; body: string } | null {
  const m = unwrapWholePaste(text).trim().match(COMPACT_MESSAGE);
  return m ? { kind: m[1] === HANDOFF_TAG ? 'handoff' : 'resume', body: m[2].trim() } : null;
}

// Claude Code の入力欄に残った文字が、仕上げの頼みか再開の文か（順番待ちの行・入力欄の下書きで、人の発言として扱わないため）
export function isCompactMessage(text: string): boolean {
  // 入力欄や順番待ちでは、閉じる側が無いこともあるので、開く側だけを外す
  const head = text.trimStart().replace(/^<pasted_content(?: id="[^"]*")?>\s*/, '');
  return head.startsWith(`<${HANDOFF_TAG}>`) || head.startsWith(`<${RESUME_TAG}>`);
}
