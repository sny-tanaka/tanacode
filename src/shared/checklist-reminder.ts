import { liveCards, liveLists, progressOf, type Checklist } from './checklist';
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

// 知らせに入れるカードの数（リストごと）と、題名の長さ
const MAX_CARDS = 40;
const MAX_TITLE = 120;

// child: 子セッション。ターンの終わりは止めない（親の Claude は子の最後の応答を結果として読むので、チェックリストの話で上書きしない）
export function checklistReminder(event: ReminderEvent, lists: Checklist[], activity: TurnActivity, child = false): string | null {
  const live = liveLists(lists);
  const open = live.some((list) => liveCards(list).some((c) => !c.checked));
  if (event === 'compact') {
    if (live.length === 0) return null;
    return wrap([
      'The conversation was just compacted. The checklists you share with the user (in the side panel of tanacode) are stored apart from it and were not affected. Current state:',
      state(live, true),
      'Keep them up to date as you continue: check each card as you finish it, and add what comes up.',
    ]);
  }
  if (event === 'prompt') {
    if (live.length === 0) {
      return wrap([
        `This session has no checklists yet. If the latest message of the user starts work with several steps, put the plan on a to-do list with the ${CHECKLIST_MCP_SERVER} tools before you start. For a quick one-step task or a plain question, ignore this reminder and do not mention it.`,
      ]);
    }
    return wrap([
      'Current state of the checklists you share with the user (in the side panel of tanacode):',
      state(live, false),
      'Before you work on the latest message of the user, check whether it changes these lists: new work to add, a card it corrects or makes obsolete (update the card, not only your reply), or something the user reports as done. If so, update the lists first, then work, and check each card as you finish it. If the message changes nothing here, do not mention this reminder.',
    ]);
  }
  // ターンの終わり。ツールを使ったのにチェックリストに触れなかったターンは、毎回止める。
  // 調べただけのターンでも、リストに積むものは出る（あとでやること・人に確かめること）ので、ツールの種類や数では分けない。
  // ツールを使っていないターン（返事だけ）は止めない。発言のときに今の状態を渡してあり、そのあとに起きたのは返事だけのため
  if (child || activity.checklist > 0 || activity.turn === 0) return null;
  // 止めた理由は、Claude Code の画面（ターミナルモード）にそのまま出る。長いと画面を埋めるので、短い 1 文にして、
  // 何を直すかはサーバーの説明（CHECKLIST_MCP_INSTRUCTIONS）に書いておく。今の状態は、未チェックの数だけを入れる（中身は発言のときに渡してある）
  const used = `${activity.turn} ${activity.turn === 1 ? 'tool call' : 'tool calls'}`;
  const counts = live.map((list) => ({ name: clip(list.name, 40), open: liveCards(list).filter((c) => !c.checked).length })).filter((l) => l.open > 0);
  const now = live.length === 0 ? 'there are no lists yet' : counts.length === 0 ? 'every card is checked' : `unchecked: ${counts.map((l) => `${l.name} ${l.open}`).join(', ')}`;
  return `<${CHECKLIST_REMINDER_TAG}>Before you end this turn (${used}, checklists not touched; ${now}): bring the checklists up to date as the ${CHECKLIST_MCP_SERVER} instructions say for the end of a turn, then end with one short line on what you changed. If nothing needs to change, reply with exactly ${CHECKLIST_UNCHANGED_MARK} and nothing else.</${CHECKLIST_REMINDER_TAG}>`;
}

function wrap(lines: string[]): string {
  return `<${CHECKLIST_REMINDER_TAG}>\n${lines.join('\n')}\n</${CHECKLIST_REMINDER_TAG}>`;
}

// 今のチェックリスト。all: チェック済みのカードも入れる（圧縮のあと）。ふだんは未チェックのカードだけにして、短くする
function state(lists: Checklist[], all: boolean): string {
  return lists
    .map((list) => {
      const { done, total } = progressOf(list);
      const cards = liveCards(list).filter((c) => all || !c.checked);
      const shown = cards.slice(0, MAX_CARDS).map((c) => `- [${c.checked ? 'x' : ' '}] #${c.number} ${clip(c.title)}`);
      const more = cards.length - shown.length;
      return [
        `## ${clip(list.name)} (${done}/${total} checked)`,
        ...(list.description ? [`Description: ${clip(list.description, 300)}`] : []),
        ...shown,
        ...(more > 0 ? [`(${more} more ${more === 1 ? 'card' : 'cards'}; see checklist_overview)`] : []),
        ...(!all && cards.length === 0 && total > 0 ? ['(every card is checked)'] : []),
        ...(total === 0 ? ['(no cards)'] : []),
      ].join('\n');
    })
    .join('\n\n');
}

// カードの題名などは人や別のセッションが書いたものなので、囲みを閉じるタグを書かれても効かないようにして、1 行にする
function clip(text: string, max = MAX_TITLE): string {
  const line = neutralizeTags(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
