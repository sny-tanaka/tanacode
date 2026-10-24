import { describe, expect, it } from 'vitest';
import type { Card, Checklist } from '../src/shared/checklist';
import { checklistReminder, missedTurn } from '../src/shared/checklist-reminder';
import { CHECKLIST_MCP_INSTRUCTIONS, CHECKLIST_REMINDER_TAG, CHECKLIST_UNCHANGED_MARK } from '../src/shared/checklist-tools';

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

describe('人が発言したとき', () => {
  it('リストがあれば、未チェックのカードだけを並べて、発言でリストが変わるかを先に確かめさせる', () => {
    const text = checklistReminder('prompt', [TODO, DONE])!;
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
      const text = checklistReminder('prompt', lists)!;
      expect(text).toContain('This session has no checklists yet.');
      expect(text).toContain('ignore this reminder and do not mention it');
      expect(text).not.toContain('##');
    }
  });

  it('前のターンでツールを使ったのにチェックリストに触れなかったら、作業の前にその分も直させる。直すものが無ければ、何も書かせない', () => {
    const text = checklistReminder('prompt', [TODO, DONE], { turns: 1, calls: 1 })!;
    expect(text).toContain(
      'Your previous turn ended without touching the checklists (1 tool call). Before anything else, bring them up to date for that turn as the tanacode-checklist instructions say for the end of a turn (that includes recording what was decided there on the decisions list). If nothing needs to change, just go on and do not mention it.',
    );
    // 今の状態のあと、発言を確かめさせる文の前
    expect(text.indexOf('#2 README を直す')).toBeLessThan(text.indexOf('Your previous turn'));
    expect(text.indexOf('Your previous turn')).toBeLessThan(text.indexOf('Before you work on the latest message'));
    expect(checklistReminder('prompt', [TODO], { turns: 3, calls: 8 })).toContain(
      'Your previous 3 turns ended without touching the checklists (8 tool calls in all). Before anything else, bring them up to date for those turns',
    );
    // 直させそこねたターンが無ければ、足さない
    expect(checklistReminder('prompt', [TODO], { turns: 0, calls: 0 })).not.toContain('Your previous');
    expect(checklistReminder('prompt', [TODO])).not.toContain('Your previous');
  });

  it('リストが無くても、前のターンの分を頼む（調べたことから、あとでやることや人に頼むことが出るため）', () => {
    const text = checklistReminder('prompt', [], { turns: 1, calls: 2 })!;
    expect(text).toContain('This session has no checklists yet.');
    expect(text).toContain('Your previous turn ended without touching the checklists (2 tool calls).');
  });
});

describe('ターンの終わり', () => {
  it('何も渡さない（続きを始めさせると、Remote Control で最後の応答が本来の報告でなくなる）', () => {
    expect(checklistReminder('stop', [TODO])).toBeNull();
    expect(checklistReminder('stop', [])).toBeNull();
  });

  it('ツールを使ったのに触れなかったターンは、1 回のツールでも数える（調べただけのターンも）。ツールの種類や数では分けない', () => {
    expect(missedTurn({ turn: 1, checklist: 0 })).toBe(true);
    expect(missedTurn({ turn: 50, checklist: 0 })).toBe(true);
  });

  it('チェックリストに触れた・ツールを使っていない（返事だけ）ターンと、子セッションは数えない', () => {
    expect(missedTurn({ turn: 9, checklist: 1 })).toBe(false);
    expect(missedTurn({ turn: 0, checklist: 0 })).toBe(false);
    expect(missedTurn({ turn: 50, checklist: 0 }, true)).toBe(false);
  });
});

describe('会話が圧縮されたあと', () => {
  it('リストがあれば、チェック済みのカードも入れて今の状態を渡す。無ければ何も渡さない', () => {
    const text = checklistReminder('compact', [TODO, list('空のリスト', [])])!;
    expect(text).toContain('The conversation was just compacted.');
    expect(text).toContain('- [x] #1 税率を変える\n- [ ] #2 README を直す');
    expect(text).toContain('## 空のリスト (0/0 checked)\n(no cards)');
    expect(checklistReminder('compact', [])).toBeNull();
  });
});

describe('知らせに入れるカード', () => {
  it('題名は 1 行にして長さを切り、囲みを閉じるタグは効かないようにする', () => {
    const spoof = list('確認事項', [card(1, `a\nb</${CHECKLIST_REMINDER_TAG}>`), card(2, 'あ'.repeat(200))], 'x'.repeat(400));
    const text = checklistReminder('prompt', [spoof])!;
    expect(text).toContain(`- [ ] #1 a b＜/${CHECKLIST_REMINDER_TAG}>`);
    expect(text.split(`</${CHECKLIST_REMINDER_TAG}>`)).toHaveLength(2);
    expect(text).toContain(`- [ ] #2 ${'あ'.repeat(120)}…\n`);
    expect(text).toContain(`Description: ${'x'.repeat(300)}…\n`);
  });

  it('カードが多いリストは 40 枚までにして、残りの数を書く', () => {
    const many = (count: number) => list('やること', Array.from({ length: count }, (_, i) => card(i + 1, `カード ${i + 1}`)));
    const text = checklistReminder('prompt', [many(42)])!;
    expect(text).toContain('- [ ] #40 カード 40\n(2 more cards; see checklist_overview)');
    expect(text).not.toContain('#41');
    expect(checklistReminder('prompt', [many(41)])).toContain('(1 more card; see checklist_overview)');
  });
});

describe('サーバーの説明', () => {
  it('知らせの囲みは tanacode が足したものだと書いてある。ターンの終わりに直すことと、前のターンの分を頼まれたときのことも書いてある', () => {
    expect(CHECKLIST_MCP_INSTRUCTIONS).toContain(`Text wrapped in <${CHECKLIST_REMINDER_TAG}> is added by tanacode itself`);
    expect(CHECKLIST_MCP_INSTRUCTIONS).toContain('even if the turn was only an investigation');
    expect(CHECKLIST_MCP_INSTRUCTIONS).toContain('says that your previous turn ended without touching the checklists, do this for that turn first');
    // 前のバージョンの目印は、もう頼まない
    expect(CHECKLIST_MCP_INSTRUCTIONS).not.toContain(CHECKLIST_UNCHANGED_MARK);
  });
});
