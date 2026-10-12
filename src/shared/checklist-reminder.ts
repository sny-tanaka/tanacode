import { activeCards, liveCards, liveLists, progressOf, traitsOf, type Checklist } from './checklist';
import { CHECKLIST_MCP_SERVER, CHECKLIST_REMINDER_TAG, CHECKLIST_UNCHANGED_MARK } from './checklist-tools';
import { neutralizeTags } from './session-tools';

// Claude にチェックリストを使い続けさせるための知らせ。アプリが起動する Claude Code に足す hooks（src/main/checklist-hook.ts）が、
// 決まった時点で今のチェックリストを Claude に渡す。サーバーの説明（CHECKLIST_MCP_INSTRUCTIONS）は会話の先頭で 1 回読まれるだけなので、
// 作業が長くなると、説明に書いてあっても更新されなくなる（終えたカードがチェックされない・人に頼んだことがチャットにしか残らない）。
// Claude だけが読むので、英語で書く

// 知らせは CHECKLIST_REMINDER_TAG で囲む。サーバーの説明に、この囲みは tanacode が足したものだと書いてある

// prompt: 人が発言した（UserPromptSubmit）/ stop: Claude がターンを終えようとしている（Stop）/ compact: 会話が圧縮された（SessionStart の compact）
export type ReminderEvent = 'prompt' | 'stop' | 'compact';

// このターン（最後の発言のあと）に Claude が使ったツールの数（フックが会話ログから数える）。checklist: そのうちチェックリストのツール
export type TurnActivity = { turn: number; checklist: number };

// 知らせの長さの上限。hooks が差し込める文は 1 万文字まで（超えると、Claude Code がファイルに書いて、先頭の 2,000 文字だけを渡す）
export const MAX_REMINDER_CHARS = 9000;

// いつも出すリスト（決定事項）のほかのリストに、残しておく長さ
const OTHER_LISTS_CHARS = 2000;

// 知らせに入れるカードの数（リストごと）と、題名の長さ。上限に収まらなければ、右のものへ順に減らす
const CARD_LIMITS = [40, 20, 10, 5, 2, 0];
const MAX_TITLE = 120;

// いつも出すリストの題名の長さ。題名は決定そのものなので、収まるかぎり全文（題名は 300 文字まで）を出す。収まらなければ、右のものへ順に切る
const PINNED_TITLE_LIMITS = [300, 120, 60];

// child: 子セッション。ターンの終わりは止めない（親の Claude は子の最後の応答を結果として読むので、チェックリストの話で上書きしない）
export function checklistReminder(event: ReminderEvent, lists: Checklist[], activity: TurnActivity, child = false): string | null {
  const live = liveLists(lists);
  if (event === 'compact') {
    if (live.length === 0) return null;
    return compose(
      'The conversation was just compacted. The checklists you share with the user (in the side panel of tanacode) are stored apart from it and were not affected. Current state:',
      live,
      true,
      'Keep them up to date as you continue: check each card as you finish it, add what comes up, and record what gets decided on the decisions list.',
    );
  }
  if (event === 'prompt') {
    if (live.length === 0) {
      return wrap([
        `This session has no checklists yet. If the latest message of the user starts work with several steps, put the plan on a to-do list with the ${CHECKLIST_MCP_SERVER} tools before you start. If it states a requirement, a constraint, a correction or a permission that must hold beyond this turn, record it on a decisions list (card_add with list_kind "decisions"). For a quick one-step task or a plain question, ignore this reminder and do not mention it.`,
      ]);
    }
    return compose(
      'Current state of the checklists you share with the user (in the side panel of tanacode):',
      live,
      false,
      'Before you work on the latest message of the user, check whether it changes these lists: new work to add, a card it corrects or makes obsolete (update the card, not only your reply), something the user reports as done, or something it decides (a requirement, a constraint, a correction, a permission and its scope, a rejected option: record it on the decisions list now, in words close to the user\'s). If so, update the lists first, then work, and check each card as you finish it. If the message changes nothing here, do not mention this reminder.',
    );
  }
  // ターンの終わり。ツールを使ったのにチェックリストに触れなかったターンは、毎回止める。
  // 調べただけのターンでも、リストに積むものは出る（あとでやること・人に確かめること）ので、ツールの種類や数では分けない。
  // ツールを使っていないターン（返事だけ）は止めない。発言のときに今の状態を渡してあり、そのあとに起きたのは返事だけのため
  if (child || activity.checklist > 0 || activity.turn === 0) return null;
  // 止めた理由は、Claude Code の画面（ターミナルモード）にそのまま出る。長いと画面を埋めるので、短い 1 文にして、
  // 何を直すかはサーバーの説明（CHECKLIST_MCP_INSTRUCTIONS）に書いておく。今の状態は、未チェックの数と、有効な決定の数だけを入れる
  // （中身は発言のときに渡してある）
  const used = `${activity.turn} ${activity.turn === 1 ? 'tool call' : 'tool calls'}`;
  const checkable = live.filter((list) => traitsOf(list).checkable);
  const counts = checkable.map((list) => ({ name: clip(list.name, 40), open: liveCards(list).filter((c) => !c.checked).length })).filter((l) => l.open > 0);
  const inForce = live.filter((list) => traitsOf(list).pinned).reduce((n, list) => n + activeCards(list).length, 0);
  const unchecked = live.length === 0 ? 'there are no lists yet' : counts.length > 0 ? `unchecked: ${counts.map((l) => `${l.name} ${l.open}`).join(', ')}` : checkable.length > 0 ? 'every card is checked' : '';
  const now = [unchecked, inForce > 0 ? `decisions in force: ${inForce}` : ''].filter(Boolean).join('; ');
  return `<${CHECKLIST_REMINDER_TAG}>Before you end this turn (${used}, checklists not touched${now ? `; ${now}` : ''}): bring the checklists up to date as the ${CHECKLIST_MCP_SERVER} instructions say for the end of a turn (that includes recording what was decided in this turn on the decisions list), then end with one short line on what you changed. If nothing needs to change, reply with exactly ${CHECKLIST_UNCHANGED_MARK} and nothing else.</${CHECKLIST_REMINDER_TAG}>`;
}

function wrap(lines: string[]): string {
  return `<${CHECKLIST_REMINDER_TAG}>\n${lines.join('\n')}\n</${CHECKLIST_REMINDER_TAG}>`;
}

// 今の状態を、上限（MAX_REMINDER_CHARS）に収めて組み立てる。いつも出すリスト（決定事項）を先に取り、ほかのリストは残りに収める
function compose(intro: string, live: Checklist[], all: boolean, outro: string): string {
  const pinnedLists = live.filter((list) => traitsOf(list).pinned);
  const others = live.filter((list) => !traitsOf(list).pinned);
  const room = MAX_REMINDER_CHARS - wrap([intro, '', outro]).length;
  const pinnedText = pinned(pinnedLists, room - (others.length > 0 ? OTHER_LISTS_CHARS : 0));
  const otherText = state(others, all, room - pinnedText.length - 2);
  return wrap([intro, [pinnedText, otherText].filter(Boolean).join('\n\n'), outro]);
}

// いつも出すリスト。有効なカード（取り消していないもの）の題名を、チェックに関係なく全部出す。
// 収まらなければ、題名を切り、それでも収まらなければ古いカードから省いて、ツールで読むよう伝える
function pinned(lists: Checklist[], budget: number): string {
  if (lists.length === 0) return '';
  const head = 'Decisions in force. They do not go away when the work is done: follow them until the user removes them or they are revoked (the details are in the body of each card: card_get).';
  const build = (titleMax: number, keep: number) =>
    [
      head,
      ...lists.map((list) => {
        const cards = activeCards(list);
        const revoked = liveCards(list).length - cards.length;
        const shown = cards.slice(Math.max(0, cards.length - keep));
        const omitted = cards.length - shown.length;
        return [
          `## ${clip(list.name)} (decisions; ${cards.length} in force${revoked > 0 ? `, ${revoked} revoked and not shown` : ''})`,
          ...(list.description ? [`Description: ${clip(list.description, 300)}`] : []),
          ...(omitted > 0 ? [`(${omitted} older ${omitted === 1 ? 'card is' : 'cards are'} not shown here but still in force; read them with checklist_overview)`] : []),
          ...shown.map((c) => `- #${c.number} ${clip(c.title, titleMax)}`),
          ...(cards.length === 0 ? ['(no cards in force)'] : []),
        ].join('\n');
      }),
    ].join('\n\n');
  for (const titleMax of PINNED_TITLE_LIMITS) {
    const text = build(titleMax, Infinity);
    if (text.length <= budget) return text;
  }
  // 新しいものを残す（リストごとに同じ数まで）
  const shortest = PINNED_TITLE_LIMITS[PINNED_TITLE_LIMITS.length - 1];
  for (let keep = Math.max(...lists.map((list) => activeCards(list).length)) - 1; keep >= 0; keep--) {
    const text = build(shortest, keep);
    if (text.length <= budget) return text;
  }
  return build(shortest, 0).slice(0, Math.max(0, budget));
}

// ほかのリスト。all: チェック済みのカードも入れる（圧縮のあと）。ふだんは未チェックのカードだけにして、短くする。
// 収まらなければ、リストごとのカードの数を減らす
function state(lists: Checklist[], all: boolean, budget: number): string {
  if (lists.length === 0) return '';
  const build = (maxCards: number) =>
    lists
      .map((list) => {
        const { done, total } = progressOf(list);
        const cards = liveCards(list).filter((c) => all || !c.checked);
        const shown = cards.slice(0, maxCards).map((c) => `- [${c.checked ? 'x' : ' '}] #${c.number} ${clip(c.title)}`);
        const more = cards.length - shown.length;
        return [
          `## ${clip(list.name)} (${done}/${total} checked${traitsOf(list).approves ? '; review list: cards the user checks move to the decisions list' : ''})`,
          ...(list.description ? [`Description: ${clip(list.description, 300)}`] : []),
          ...shown,
          ...(more > 0 ? [`(${more} more ${more === 1 ? 'card' : 'cards'}; see checklist_overview)`] : []),
          ...(!all && cards.length === 0 && total > 0 ? ['(every card is checked)'] : []),
          ...(total === 0 ? ['(no cards)'] : []),
        ].join('\n');
      })
      .join('\n\n');
  for (const maxCards of CARD_LIMITS) {
    const text = build(maxCards);
    if (text.length <= budget) return text;
  }
  const note = '\n(more lists; see checklist_overview)';
  return build(0).slice(0, Math.max(0, budget - note.length)) + note;
}

// カードの題名などは人や別のセッションが書いたものなので、囲みを閉じるタグを書かれても効かないようにして、1 行にする
function clip(text: string, max = MAX_TITLE): string {
  const line = neutralizeTags(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
