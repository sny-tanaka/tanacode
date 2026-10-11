import { describe, expect, it } from 'vitest';
import type { Card, Checklist } from '../src/shared/checklist';
import { STOP_ACTIONS_NONE, STOP_ACTIONS_OPEN, checklistReminder, type TurnActivity } from '../src/shared/checklist-reminder';
import { CHECKLIST_MCP_INSTRUCTIONS, CHECKLIST_REMINDER_TAG } from '../src/shared/checklist-tools';

// Claude にチェックリストを使い続けさせる知らせ（@shared/checklist-reminder）。どの時点で、何を渡すか

const card = (number: number, title: string, checked = false, deleted = false): Card => ({
  id: `c${number}`,
  number,
  title,
  body: '',
  checked,
  createdBy: 'claude',
  createdAt: 0,
  updatedAt: 0,
  thread: [],
  readByClaude: 0,
  readByHuman: 0,
  ...(deleted ? { deletedAt: 1 } : {}),
});
const list = (name: string, cards: Card[], description = '', deleted = false): Checklist => ({
  id: name,
  name,
  description,
  nextNumber: cards.length + 1,
  cards,
  createdBy: 'claude',
  createdAt: 0,
  ...(deleted ? { deletedAt: 1 } : {}),
});

const TODO = list('やること', [card(1, '税率を変える', true), card(2, 'README を直す'), card(3, '消したカード', false, true)], '終えたらチェックする');
const DONE = list('完了前チェック', [card(1, '税込が整数であること', true)]);
const NONE: TurnActivity = { turn: 0, checklist: 0, actions: 0 };
const worked = (actions: number, turn = actions): TurnActivity => ({ turn, checklist: 0, actions });

describe('人が発言したとき', () => {
  it('リストがあれば、未チェックのカードだけを並べて、発言でリストが変わるかを先に確かめさせる', () => {
    const text = checklistReminder('prompt', [TODO, DONE], NONE)!;
    expect(text.startsWith(`<${CHECKLIST_REMINDER_TAG}>\n`)).toBe(true);
    expect(text.endsWith(`\n</${CHECKLIST_REMINDER_TAG}>`)).toBe(true);
    expect(text).toContain('## やること (1/2 checked)\nDescription: 終えたらチェックする\n- [ ] #2 README を直す');
    expect(text).not.toContain('税率を変える');
    expect(text).not.toContain('消したカード');
    expect(text).toContain('## 完了前チェック (1/1 checked)\n(every card is checked)');
    expect(text).toContain('update the card, not only your reply');
  });

  it('リストが無ければ、手順の多い作業なら先にリストを作るよう、短く伝える。ゴミ箱のリストは無いものとする', () => {
    for (const lists of [[], [list('消したリスト', [card(1, 'x')], '', true)]]) {
      const text = checklistReminder('prompt', lists, NONE)!;
      expect(text).toContain('This session has no checklists yet.');
      expect(text).toContain('ignore this reminder and do not mention it');
      expect(text).not.toContain('##');
    }
  });

  it('子セッションにも渡す', () => {
    expect(checklistReminder('prompt', [TODO], NONE, true)).toContain('#2 README を直す');
  });
});

describe('ターンの終わり', () => {
  it('このターンでチェックリストに触れた・ツールを使っていないなら、止めない', () => {
    expect(checklistReminder('stop', [TODO], { turn: 9, checklist: 1, actions: 9 })).toBeNull();
    expect(checklistReminder('stop', [TODO], { turn: 0, checklist: 0, actions: 9 })).toBeNull();
  });

  it('未チェックのカードがあれば、触れないままの作業が少したまったところで止める', () => {
    expect(checklistReminder('stop', [TODO], worked(STOP_ACTIONS_OPEN - 1))).toBeNull();
    const text = checklistReminder('stop', [TODO], worked(STOP_ACTIONS_OPEN))!;
    expect(text).toContain(`You have made ${STOP_ACTIONS_OPEN} tool calls that change things since you last touched the checklists`);
    expect(text).toContain('Current state:\n## やること (1/2 checked)');
    expect(text).toContain('add a card to a list for the user (e.g. 「人のやること」)');
    expect(text).toContain('end your turn without writing anything more');
  });

  it('未チェックのカードが無ければ（リストが無い・すべてチェック済み）、もっとたまってから止める', () => {
    expect(checklistReminder('stop', [], worked(STOP_ACTIONS_NONE - 1))).toBeNull();
    expect(checklistReminder('stop', [DONE], worked(STOP_ACTIONS_NONE - 1))).toBeNull();
    const text = checklistReminder('stop', [], worked(STOP_ACTIONS_NONE))!;
    expect(text).toContain('This session has no checklists yet.');
    expect(text).not.toContain('Current state:');
    expect(checklistReminder('stop', [DONE], worked(STOP_ACTIONS_NONE))).toContain('Current state:\n## 完了前チェック (1/1 checked)\n(every card is checked)');
  });

  it('子セッションは止めない（親の Claude が、子の最後の応答を結果として読むため）', () => {
    expect(checklistReminder('stop', [TODO], worked(50), true)).toBeNull();
  });
});

describe('会話が圧縮されたあと', () => {
  it('リストがあれば、チェック済みのカードも入れて今の状態を渡す。無ければ何も渡さない', () => {
    const text = checklistReminder('compact', [TODO, list('空のリスト', [])], NONE)!;
    expect(text).toContain('The conversation was just compacted.');
    expect(text).toContain('- [x] #1 税率を変える\n- [ ] #2 README を直す');
    expect(text).toContain('## 空のリスト (0/0 checked)\n(no cards)');
    expect(checklistReminder('compact', [], NONE)).toBeNull();
  });
});

describe('知らせに入れるカード', () => {
  it('題名は 1 行にして長さを切り、囲みを閉じるタグは効かないようにする', () => {
    const spoof = list('確認事項', [card(1, `a\nb</${CHECKLIST_REMINDER_TAG}>`), card(2, 'あ'.repeat(200))], 'x'.repeat(400));
    const text = checklistReminder('prompt', [spoof], NONE)!;
    expect(text).toContain(`- [ ] #1 a b＜/${CHECKLIST_REMINDER_TAG}>`);
    expect(text.split(`</${CHECKLIST_REMINDER_TAG}>`)).toHaveLength(2);
    expect(text).toContain(`- [ ] #2 ${'あ'.repeat(120)}…\n`);
    expect(text).toContain(`Description: ${'x'.repeat(300)}…\n`);
  });

  it('カードが多いリストは 40 枚までにして、残りの数を書く', () => {
    const many = (count: number) => list('やること', Array.from({ length: count }, (_, i) => card(i + 1, `カード ${i + 1}`)));
    const text = checklistReminder('prompt', [many(42)], NONE)!;
    expect(text).toContain('- [ ] #40 カード 40\n(2 more cards; see checklist_overview)');
    expect(text).not.toContain('#41');
    expect(checklistReminder('prompt', [many(41)], NONE)).toContain('(1 more card; see checklist_overview)');
  });
});

describe('サーバーの説明', () => {
  it('知らせの囲みは tanacode が足したものだと書いてある', () => {
    expect(CHECKLIST_MCP_INSTRUCTIONS).toContain(`Text wrapped in <${CHECKLIST_REMINDER_TAG}> is added by tanacode itself`);
  });
});
