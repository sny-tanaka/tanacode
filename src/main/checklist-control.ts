import { claudeNumbers, claudeUnread, eventText, formatNumbers, liveCards, liveLists, parseNumbers, progressOf, type Card, type Checklist, type ChecklistCopyRequest, type ChecklistOp } from '@shared/checklist';
import { checklistEventText, checklistTool, clipNotice, noticeMessage, replyNoticeText, type CardRef } from '@shared/checklist-tools';
import { t } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import { canSee } from '@shared/session-tools';
import { ChecklistError, type ChecklistStore } from './checklist-store';
import { textResult, type ToolResult } from './mcp-bridge';
import { SessionNotices, type NoticeHost } from './session-notices';

// Claude によるチェックリストの扱い（MCP サーバー tanacode-checklist のツールの実行）と、画面からの書き換え。
// 呼び出し元のセッションは中継の env で渡ってくる。リストは名前で、カードはリストの中の番号で指す。
// 人がスレッドに「Claude に通知する」で返信したとき・ほかのセッションからカードが届いたときは、手の空いた Claude に知らせる。
// 別のセッションとのコピーは、tanacode-sessions と同じく見えるセッション（同じフォルダ・親子・兄弟）のあいだだけ。
// Claude に返す結果とエラーは英語で書く（画面の言語によらない）。人も見る知らせと、画面からのコピーを断る理由は画面の言語（t()）

type Deps = {
  store: ChecklistStore;
  host: NoticeHost;
  // メニューの「Claude にチェックリストを扱わせる」
  enabled: () => boolean;
  // 知らせをまとめるまでの待ち（テストでは短くする）
  notifyDelayMs?: number;
};

// 知らせの中身。ref: 開くカード
type Notice = { text: string; refs: CardRef[] };

// 1 回の結果の文字数の上限
const MAX_RESULT_CHARS = 60_000;

export class ChecklistControl {
  private readonly notices: SessionNotices<Notice>;

  constructor(private readonly deps: Deps) {
    this.notices = new SessionNotices({
      host: deps.host,
      enabled: deps.enabled,
      compose: (_target, items) => {
        const all = [...items.values()];
        const message = noticeMessage(all.map((n) => n.text));
        const refs = new Map(all.flatMap((n) => n.refs).map((r) => [r.cardId, r]));
        return checklistEventText([...refs.values()], message);
      },
      delayMs: deps.notifyDelayMs,
    });
  }

  dispose(): void {
    this.notices.dispose();
  }

  // --- 画面から ---

  // 画面からの書き換え。「Claude に通知する」で返信したら、手の空いた Claude に知らせる
  apply(sessionId: string, op: ChecklistOp): void {
    this.deps.store.apply(sessionId, op, 'human');
    if (op.type === 'card-reply' && op.notify) {
      const list = this.deps.store.lists(sessionId).find((l) => l.id === op.listId);
      const card = list?.cards.find((c) => c.id === op.cardId);
      if (!list || !card) return;
      const text = replyNoticeText(list.name, card.number, card.title, op.text);
      // 返信ごとに 1 つ。続けて返信したものは、1 つの知らせにまとめて送る
      const reply = card.thread[card.thread.length - 1];
      this.notices.add(sessionId, `reply:${reply.id}`, { text, refs: [{ listId: list.id, cardId: card.id }] });
    }
  }

  // 画面からの、別のセッションへのコピー。断る理由は画面に出す
  copy(request: ChecklistCopyRequest): void {
    const sessions = this.deps.host.list();
    const from = sessions.find((s) => s.id === request.fromSession);
    const to = sessions.find((s) => s.id === request.toSession);
    if (!from || !to) throw new ChecklistError(t('tools.checklistCopy.sessionNotFound'));
    // Claude と同じく、同じフォルダと親子・兄弟のセッションのあいだだけ
    if (!canSee(from, to)) throw new ChecklistError(t('tools.checklistCopy.notVisible'));
    if (to.archived) throw new ChecklistError(t('tools.checklistCopy.archived'));
    const result = this.deps.store.copyCards(
      { sessionId: from.id, title: nameOf(from), listId: request.listId, cardIds: request.cardIds },
      to.id,
      'human',
      request.toList,
    );
    if (request.notify && to.id !== from.id) this.notifyCopy(from, to.id, result.list, result.cards);
  }

  // --- MCP のツール ---

  async handle(callerId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!checklistTool(name)) return textResult(`Unknown tool: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult(`The user has turned off "${t('main.menu.checklistControl')}" in the tanacode menu. Ask the user to turn it on.`, true);
    }
    const caller = this.deps.host.list().find((s) => s.id === callerId);
    if (!caller) return textResult('This session is not in tanacode.', true);
    let result: ToolResult;
    try {
      result = textResult(this.run(caller, name, args));
    } catch (error) {
      if (!(error instanceof ChecklistError)) throw error;
      result = textResult(error.message, true);
    }
    // 前回の呼び出しから人が変えたものを添える
    const activity = this.deps.store.takeHumanActivity(caller.id);
    if (activity.length > 0) {
      const lines = activity.slice(-30).map((a) => `- ${a}`);
      result.content.push({ type: 'text', text: `(Since your previous tool call, the user changed the checklists)\n${lines.join('\n')}` });
    }
    return result;
  }

  private run(caller: SessionSummary, name: string, args: Record<string, unknown>): string {
    const { store } = this.deps;
    const id = caller.id;
    switch (name) {
      case 'checklist_overview':
        return overview(store.lists(id));
      case 'card_get': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        // 未読の印を付けて返してから、読んだことにする
        const text = clip(cards.map((c) => cardText(list, c)).join('\n\n---\n\n'), MAX_RESULT_CHARS);
        for (const card of cards) store.markRead(id, 'claude', list.id, card.id);
        return text;
      }
      case 'list_create': {
        const list = store.createList(id, 'claude', stringArg(args.name, 'name'), optionalString(args.description) ?? '');
        return `Created the list "${list.name}".`;
      }
      case 'list_update': {
        const list = this.listArg(id, args.list);
        const updated = store.updateList(id, 'claude', list.id, { name: optionalString(args.name), description: optionalString(args.description) });
        return `Updated the list "${updated.name}".`;
      }
      case 'list_delete': {
        const list = this.listArg(id, args.list);
        store.deleteList(id, 'claude', list.id);
        return `Moved the list "${list.name}" to the trash (the user can restore it in the app).`;
      }
      case 'card_add': {
        const raw = Array.isArray(args.cards) ? (args.cards as { title?: unknown; body?: unknown }[]) : [];
        if (raw.length === 0) throw new ChecklistError('Pass at least one card to add in cards.');
        const cards = raw.map((c) => ({ title: typeof c?.title === 'string' ? c.title : '', body: typeof c?.body === 'string' ? c.body : undefined }));
        let list = store.findList(id, stringArg(args.list, 'list'));
        let note = '';
        if (!list) {
          const description = optionalString(args.list_description);
          if (description === undefined) {
            throw new ChecklistError(`There is no list "${args.list}". ${listNames(store.lists(id))} To create it, also pass list_description (the rules for using the list).`);
          }
          list = store.createList(id, 'claude', String(args.list), description);
          note = `Created the list "${list.name}".`;
        }
        const added = store.addCards(id, 'claude', list.id, cards);
        return [note, `Added ${added.map((c) => `#${c.number} "${c.title}"`).join(', ')} to "${list.name}".`].filter(Boolean).join(' ');
      }
      case 'card_update': {
        const list = this.listArg(id, args.list);
        const [card] = this.cardsArg(list, args.number);
        const updated = store.updateCard(id, 'claude', list.id, card.id, { title: optionalString(args.title), body: optionalString(args.body) });
        return `Updated "${list.name}" #${updated.number}.`;
      }
      case 'card_check':
      case 'card_uncheck': {
        const check = name === 'card_check';
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        const comment = check ? optionalString(args.comment) : stringArg(args.reason, 'reason');
        const changed = store.setChecked(id, 'claude', list.id, cards.map((c) => c.id), check, comment);
        const same = cards.filter((c) => !changed.includes(c));
        const done = changed.length > 0 ? `${check ? 'Checked' : 'Unchecked'} ${claudeNumbers(changed.map((c) => c.number))} in "${list.name}".` : '';
        const skipped = same.length > 0 ? `${claudeNumbers(same.map((c) => c.number))} ${same.length === 1 ? 'was' : 'were'} already ${check ? 'checked' : 'unchecked'}.` : '';
        const { done: checked, total } = progressOf(list);
        const rest = total - checked;
        const left = check ? `${rest} unchecked ${rest === 1 ? 'card' : 'cards'} left in "${list.name}".` : '';
        return [done, skipped, left].filter(Boolean).join(' ');
      }
      case 'card_reply': {
        const list = this.listArg(id, args.list);
        const [card] = this.cardsArg(list, args.number);
        store.reply(id, 'claude', list.id, card.id, stringArg(args.text, 'text'));
        return `Replied in the thread of "${list.name}" #${card.number}.`;
      }
      case 'card_move': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        const toName = stringArg(args.to_list, 'to_list');
        const to = store.findList(id, toName) ?? store.createList(id, 'claude', toName, '');
        if (to.id === list.id) throw new ChecklistError('The destination is the same list.');
        const before = cards.map((c) => c.number);
        const moved = store.moveCards(id, 'claude', list.id, cards.map((c) => c.id), to.id);
        return `Moved ${claudeNumbers(before)} from "${list.name}" to "${to.name}" (new ${moved.length === 1 ? 'number' : 'numbers'}: ${claudeNumbers(moved.map((c) => c.number))}).`;
      }
      case 'card_delete': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        store.deleteCards(id, 'claude', list.id, cards.map((c) => c.id));
        return `Moved ${claudeNumbers(cards.map((c) => c.number))} in "${list.name}" to the trash (restore ${cards.length === 1 ? 'it' : 'them'} with card_restore).`;
      }
      case 'card_restore': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers, true);
        const restored = store.restoreCards(id, 'claude', list.id, cards.map((c) => c.id));
        return restored.length > 0 ? `Restored ${claudeNumbers(restored.map((c) => c.number))} in "${list.name}".` : 'None of the cards were in the trash.';
      }
      case 'cards_copy':
        return this.copyByClaude(caller, args);
      default:
        throw new ChecklistError(`Unknown tool: ${name}`);
    }
  }

  private copyByClaude(caller: SessionSummary, args: Record<string, unknown>): string {
    const from = this.sessionArg(caller, args.from_session);
    const to = this.sessionArg(caller, args.to_session);
    if (from.id === to.id) throw new ChecklistError('The source and destination are the same session. To move cards within a session, use card_move.');
    if (to.archived) throw new ChecklistError(`Can't copy to "${nameOf(to)}" because it is an archived session.`);
    const list = this.listArg(from.id, args.from_list);
    const cards = this.cardsArg(list, args.numbers);
    const result = this.deps.store.copyCards(
      { sessionId: from.id, title: nameOf(from), listId: list.id, cardIds: cards.map((c) => c.id) },
      to.id,
      'claude',
      optionalString(args.to_list),
    );
    const notify = args.notify !== false && to.id !== caller.id;
    if (notify) this.notifyCopy(from, to.id, result.list, result.cards);
    const where = to.id === caller.id ? 'this session' : `session "${nameOf(to)}" (${to.id.slice(0, 8)})`;
    return [
      `Copied ${claudeNumbers(cards.map((c) => c.number))} of "${list.name}" in session "${nameOf(from)}" to "${result.list.name}" in ${where} as ${claudeNumbers(result.cards.map((c) => c.number))}.`,
      result.createdList ? `(The list "${result.list.name}" did not exist, so it was created.)` : '',
      notify ? 'Claude in the destination session will be notified when it is idle.' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  // 知らせはチャットにも出るので、画面の言語で書く
  private notifyCopy(from: SessionSummary, to: string, list: Checklist, cards: Card[]): void {
    const text = t('tools.notice.cardsCopied', {
      session: from.title ?? t('tools.notice.untitledSession'),
      list: list.name,
      numbers: formatNumbers(cards.map((c) => c.number)),
      titles: cards.map((c) => t('tools.notice.cardTitle', { title: c.title })).join(t('main.format.listSeparator')),
    });
    this.notices.add(to, `copy:${cards[0]?.id ?? ''}`, { text: clipNotice(text, 600), refs: cards.slice(0, 20).map((c) => ({ listId: list.id, cardId: c.id })) });
  }

  // --- 引数 ---

  private listArg(sessionId: string, raw: unknown): Checklist {
    const name = stringArg(raw, 'list');
    const list = this.deps.store.findList(sessionId, name);
    if (!list) throw new ChecklistError(`There is no list "${name}". ${listNames(this.deps.store.lists(sessionId))}`);
    return list;
  }

  // 番号の指定から、カード（ゴミ箱のものは trashed のときだけ）。無い番号があれば、そう返す
  private cardsArg(list: Checklist, raw: unknown, trashed = false): Card[] {
    const numbers = parseNumbers(raw);
    if (!numbers || numbers.length === 0) throw new ChecklistError('Write the numbers like "3", "5-8" or "5,7,9".');
    const pool = trashed ? list.cards.filter((c) => c.deletedAt) : liveCards(list);
    const found = numbers.map((n) => pool.find((c) => c.number === n));
    const missing = numbers.filter((_, i) => !found[i]);
    if (missing.length > 0) {
      const where = trashed ? `the trash of "${list.name}"` : `"${list.name}"`;
      throw new ChecklistError(`${claudeNumbers(missing)} ${missing.length === 1 ? 'is' : 'are'} not in ${where}. Check the numbers with checklist_overview.`);
    }
    return found as Card[];
  }

  // 見えるセッション（tanacode-sessions と同じ）。省くと呼び出し元
  private sessionArg(caller: SessionSummary, raw: unknown): SessionSummary {
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!id) return caller;
    if (id.length < 8) throw new ChecklistError('Pass at least the first 8 characters of the session ID.');
    const matches = this.deps.host.list().filter((s) => canSee(caller, s) && s.id.startsWith(id));
    if (matches.length === 0) throw new ChecklistError(`No visible session has the ID ${id} (check with list_sessions of tanacode-sessions).`);
    if (matches.length > 1) throw new ChecklistError(`More than one session has an ID starting with ${id}. Pass a longer ID.`);
    return matches[0];
  }
}

// --- 結果の文 ---

function overview(lists: Checklist[]): string {
  const live = liveLists(lists);
  if (live.length === 0) return 'This session has no checklists yet. You can create one with list_create.';
  return live
    .map((list) => {
      const { done, total } = progressOf(list);
      const cards = liveCards(list).map((c) => {
        const unread = claudeUnread(c);
        return `- [${c.checked ? 'x' : ' '}] #${c.number} ${c.title}${unread > 0 ? ` (${unread} unread ${unread === 1 ? 'reply' : 'replies'})` : ''}`;
      });
      return [`## ${list.name} (${done}/${total} checked)`, `Description: ${list.description || '(none)'}`, ...(cards.length > 0 ? cards : ['(no cards)'])].join('\n');
    })
    .join('\n\n');
}

function cardText(list: Checklist, card: Card): string {
  const state = card.checked ? `checked (by ${card.checkedBy === 'claude' ? 'Claude' : 'the user'}, ${time(card.checkedAt ?? 0)})` : 'not checked';
  const thread = card.thread.map((e) => {
    const who = e.author === 'human' ? 'The user' : 'Claude';
    if (e.kind === 'event') return `- ${time(e.at)} ${eventText(e.event, who)}`;
    const unread = e.author === 'human' && e.at > card.readByClaude ? ' (unread)' : '';
    return `- ${time(e.at)} ${who} replied${unread}:\n${indent(e.text)}`;
  });
  return [
    `## "${list.name}" #${card.number} ${card.title}`,
    `- Status: ${state}`,
    `- Created by: ${card.createdBy === 'human' ? 'the user' : 'Claude'}`,
    '',
    '### Body',
    card.body || '(none)',
    '',
    '### Thread',
    ...thread,
  ].join('\n');
}

function listNames(lists: Checklist[]): string {
  const names = liveLists(lists).map((l) => `"${l.name}"`);
  return names.length > 0 ? `Existing lists: ${names.join(', ')}.` : 'There are no lists yet.';
}

// 題名の無いセッションの名前は、画面の言語で（コピーしたカードのコピー元として保存され、スレッドに出る）
function nameOf(s: SessionSummary): string {
  return s.title ?? t('tools.notice.untitledSession');
}

function time(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ChecklistError(`${name} is required.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clip(text: string, max: number): string {
  const omitted = text.length - max;
  return omitted > 0 ? `${text.slice(0, max)}\n…(${omitted} ${omitted === 1 ? 'character' : 'characters'} omitted)` : text;
}
