import {
  activeCards,
  claudeNumbers,
  claudeUnread,
  eventText,
  formatNumbers,
  isListKind,
  kindOf,
  liveCards,
  liveLists,
  nameKey,
  parseNumbers,
  progressOf,
  traitsOf,
  trashOf,
  type Author,
  type Card,
  type Checklist,
  type ChecklistCopyRequest,
  type ChecklistOp,
  type ListKind,
} from '@shared/checklist';
import { checklistReminder, type ReminderEvent, type TurnActivity } from '@shared/checklist-reminder';
import { checklistEventText, checklistTool, clipNotice, noticeMessage, replyNoticeText, type CardRef } from '@shared/checklist-tools';
import { t } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import { canSee } from '@shared/session-tools';
import { checklistHookEvent } from './checklist-bridge';
import { ChecklistError, type ChecklistStore } from './checklist-store';
import { textResult, type ToolResult } from './mcp-bridge';
import { SessionNotices, type NoticeHost } from './session-notices';

// Claude によるチェックリストの扱い（MCP サーバー tanacode-checklist のツールの実行）と、画面からの書き換え。
// 呼び出し元のセッションは中継の env で渡ってくる。リストは名前で、カードはリストの中の番号で指す。
// 人がスレッドに「Claude に通知する」で返信したとき・ほかのセッションからカードが届いたときは、手の空いた Claude に知らせる。
// 別のセッションとのコピーは、tanacode-sessions と同じく見えるセッション（同じフォルダ・親子・兄弟）のあいだだけ。
// ほかのセッションのチェックリストも、session_id で、見えるセッションのものは読めて、自分の子のものは書き換えられる。
// 書き換えても、そのセッションの Claude には知らせない（要れば親が send_message で伝える）。
// Claude に返す結果とエラーは英語で書く（画面の言語によらない）。人も見る知らせと、画面からのコピーを断る理由は画面の言語（t()）

type Deps = {
  store: ChecklistStore;
  host: NoticeHost;
  // メニューの「Claude にチェックリストを扱わせる」
  enabled: () => boolean;
  // 知らせをまとめるまでの待ち（テストでは短くする）
  notifyDelayMs?: number;
  // チャット（stream-json）で受けた本体の応答から数えた、今か直前のターンのツール（ターミナルモード・まだ受けていなければ null）
  turnTools?: (sessionId: string) => TurnActivity | null;
};

// 知らせの中身。ref: 開くカード
// byHuman: 人が画面で頼んだ知らせ（「Claude に通知する」で返信した・画面からコピーした）。ターミナルモードなら TUI の入力欄に貼る
type Notice = { text: string; refs: CardRef[]; byHuman: boolean };

// 1 回の結果の文字数の上限
const MAX_RESULT_CHARS = 60_000;
// チェックリストのファイルを読めず、変更を保存しないセッションの結果に添える一言
const UNSAVED_NOTE =
  "Note: tanacode could not read this session's saved checklist file (no permission, or written by a newer version of tanacode), so these checklists are not saved: changes are lost when tanacode quits. The original file is kept as it is. Tell the user (this note is given only once, not in every result).";

// 発言の行の時刻（Claude Code が会話ログに書く）と、人の発言のフックがアプリに届いた時刻の、ずれの見込み
const PROMPT_SLACK_MS = 5000;

export class ChecklistControl {
  private readonly notices: SessionNotices<Notice>;
  // セッションごとの、チェックリストのツールを最後に受けた時刻と、人の発言のフックを最後に受けた時刻（ミリ秒）。
  // ターンの終わりのフックが読んだ会話ログが、最後の応答までそろっていなかったときに使う（reminder）
  private readonly usedAt = new Map<string, number>();
  private readonly promptedAt = new Map<string, number>();
  // 保存しないことを結果に添えた、呼んだセッションと対象のセッションの組（\0 でつなぐ）。Claude が呼ぶたびに人へ伝え直さないよう、
  // 組ごとに最初の 1 回だけ添える（画面のチェックリストにも「保存できません」が出ている）
  private readonly unsavedNoted = new Set<string>();

  constructor(private readonly deps: Deps) {
    this.notices = new SessionNotices({
      host: deps.host,
      enabled: deps.enabled,
      // 人がボタンで頼んだ知らせは、ターミナルモードなら TUI の入力欄に貼る（Enter は人が押す）。Claude からの知らせは捨てる
      pasteInTerminal: (notice) => notice.byHuman,
      compose: (_target, items) => {
        const all = [...items.values()];
        const message = noticeMessage(all.map((n) => n.text));
        const refs = new Map(all.flatMap((n) => n.refs).map((r) => [r.cardId, r]));
        return checklistEventText([...refs.values()], message);
      },
      delayMs: deps.notifyDelayMs,
      // 送り先が忙しくて預かっている間にアプリを終えても、次のアプリが戻して、手が空いたら送る
      channel: 'checklist',
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
      this.notices.add(sessionId, `reply:${reply.id}`, { text, refs: [{ listId: list.id, cardId: card.id }], byHuman: true });
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
    if (request.notify && to.id !== from.id) this.notifyCopy(from, to.id, result.list, result.cards, true);
  }

  // --- MCP のツール ---

  async handle(callerId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const hook = checklistHookEvent(name);
    if (hook) return textResult(this.reminder(callerId, hook, args));
    if (!checklistTool(name)) return textResult(`Unknown tool: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult(`The user has turned off "${t('main.menu.checklistControl')}" in the tanacode menu. Ask the user to turn it on.`, true);
    }
    const caller = this.deps.host.list().find((s) => s.id === callerId);
    if (!caller) return textResult('This session is not in tanacode.', true);
    this.usedAt.set(caller.id, Date.now());
    let result: ToolResult;
    try {
      result = textResult(this.runFor(caller, name, args));
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

  // その時刻よりあとに、このセッションの Claude がチェックリストのツールを呼んだか（読むだけでも。最適化圧縮が、仕上げで使ったかを確かめる）
  usedSince(sessionId: string, at: number): boolean {
    const used = this.usedAt.get(sessionId);
    return used !== undefined && used >= at;
  }

  // --- フック ---

  // チェックリストを使い続けさせるフック（checklist-hook.ts）に返す、Claude に渡す文。渡すものが無ければ空。
  // counts: フックが会話ログから読んだもの（ツールの引数ではない）。turn・checklist: Claude が使ったツールの数 /
  // since: このターンのはじまりの時刻 / settled: 会話ログが最後の応答までそろっているのを、フックが確かめた
  private reminder(callerId: string, event: ReminderEvent, counts: Record<string, unknown>): string {
    if (!this.deps.enabled()) return '';
    const caller = this.deps.host.list().find((s) => s.id === callerId);
    if (!caller) return '';
    if (event === 'prompt') this.promptedAt.set(caller.id, Date.now());
    const count = (value: unknown) => (typeof value === 'number' && value > 0 ? Math.floor(value) : 0);
    let checklist = count(counts.checklist);
    // 会話ログは遅れて書かれるので、フックが待っても、最後の応答までそろわないことがある（checklist-hook.ts の冒頭）。
    // そのときフックが数えたのは、読めた分だけ。アプリが自分で受けたもので補う（会話ログがそろったときは、会話ログだけで決める。
    // アプリは、本体の呼び出しとサブエージェントの呼び出しを見分けられないため）
    let turn = count(counts.turn);
    // チャット（stream-json）なら、アプリは本体の応答を会話ログより先に受けていて、このターンのツールを数えてある（SessionManager の turnTools）。
    // 会話ログがそろわなかったときは、それで決める（フックが見たものは、前のターンのものかもしれない）
    const streamed = event === 'stop' && counts.settled !== true ? (this.deps.turnTools?.(caller.id) ?? null) : null;
    if (streamed) {
      turn = streamed.turn;
      checklist = streamed.checklist;
    } else if (event === 'stop' && counts.settled !== true && typeof counts.since === 'number') {
      // このターンの行がまだ 1 つも書かれていなければ、数えたのは前のターン。人の発言のフックを受けた時刻より、
      // はじまりがずっと前なら、止めない（発言の行の時刻と、フックがアプリに届く時刻は、少しずれる）
      const prompted = this.promptedAt.get(caller.id);
      if (prompted !== undefined && counts.since < prompted - PROMPT_SLACK_MS) return '';
      // このターンのはじまりよりあとにチェックリストのツールを受けていれば、その行がまだ書かれていないだけ。触れたものとして止めない
      const used = this.usedAt.get(caller.id);
      if (used !== undefined && used >= counts.since) checklist++;
    }
    const activity = { turn, checklist };
    return checklistReminder(event, this.deps.store.lists(caller.id), activity, !!caller.parentId) ?? '';
  }

  // 対象のセッション（session_id）を決めてから実行する。ほかのセッションのものは、結果と断る文の頭にセッションを書く
  private runFor(caller: SessionSummary, name: string, args: Record<string, unknown>): string {
    const target = this.targetArg(caller, name, args.session_id);
    // チェックリストのファイルを読めず、変更を保存しないセッションなら、そう添える（人に伝えてもらう。最初の 1 回だけ）
    const unsaved = (text: string) => {
      const key = `${caller.id}\0${target.id}`;
      if (!this.deps.store.unsavable(target.id) || this.unsavedNoted.has(key)) return text;
      this.unsavedNoted.add(key);
      return `${text}\n\n${UNSAVED_NOTE}`;
    };
    if (target.id === caller.id) return unsaved(this.run(caller, target, name, args));
    const where = `Session "${nameOf(target)}" (${target.id.slice(0, 8)})`;
    try {
      const text = unsaved(this.run(caller, target, name, args));
      return checklistTool(name)?.kind === 'read' ? `# ${where}\n\n${text}` : `${where}: ${text}`;
    } catch (error) {
      if (error instanceof ChecklistError) throw new ChecklistError(`${where}: ${error.message}`);
      throw error;
    }
  }

  // target: チェックリストを読む・書き換えるセッション（ほとんどは呼び出し元）
  private run(caller: SessionSummary, target: SessionSummary, name: string, args: Record<string, unknown>): string {
    const { store } = this.deps;
    const id = target.id;
    // ほかのセッションのものを読んでも書いても、そのセッションの Claude が読んだことにはしない（未読の数も出さない）
    const own = id === caller.id;
    switch (name) {
      case 'checklist_overview':
        return overview(store.lists(id), own);
      case 'card_get': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        // 未読の印を付けて返してから、読んだことにする
        const text = clip(cards.map((c) => cardText(list, c, own)).join('\n\n---\n\n'), MAX_RESULT_CHARS);
        if (own) for (const card of cards) store.markRead(id, 'claude', list.id, card.id);
        return text;
      }
      case 'checklist_trash':
        return clip(trashText(store.lists(id)), MAX_RESULT_CHARS);
      case 'list_create': {
        const list = store.createList(id, 'claude', stringArg(args.name, 'name'), optionalString(args.description) ?? '', kindArg(args.kind, 'kind'));
        return `Created the list "${list.name}"${kindNote(list)}.`;
      }
      case 'list_update': {
        const list = this.listArg(id, args.list);
        const updated = store.updateList(id, 'claude', list.id, { name: optionalString(args.name), description: optionalString(args.description) });
        return `Updated the list "${updated.name}".`;
      }
      case 'list_delete': {
        const list = this.listArg(id, args.list);
        store.deleteList(id, 'claude', list.id);
        return `Moved the list "${list.name}" to the trash (restore it with list_restore).`;
      }
      case 'list_restore': {
        const list = this.trashedListArg(id, args.list);
        const before = list.name;
        // 決定事項のリストは、book が断る（戻せるのは人だけ）
        store.restoreList(id, 'claude', list.id);
        const cards = liveCards(list);
        // リストより前に 1 枚ずつ消したカードは、ゴミ箱に残る
        const left = list.cards.length - cards.length;
        return [
          `Restored the list "${list.name}" from the trash with ${cardCount(cards.length)}${cards.length > 0 ? ` (${claudeNumbers(cards.map((c) => c.number))})` : ''}.`,
          list.name !== before ? `A list named "${before}" already exists, so the restored list is named "${list.name}".` : '',
          left > 0
            ? `${cardCount(left)} deleted before the list ${left === 1 ? 'stays' : 'stay'} in the trash (restore ${left === 1 ? 'it' : 'them'} with card_restore; checklist_trash shows ${left === 1 ? 'it' : 'them'}).`
            : '',
        ]
          .filter(Boolean)
          .join(' ');
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
          list = store.createList(id, 'claude', String(args.list), description, kindArg(args.list_kind, 'list_kind'));
          note = `Created the list "${list.name}"${kindNote(list)}.`;
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
        const changed = store.setChecked(id, 'claude', list.id, cards.map((c) => c.id), check, comment, own);
        const same = cards.filter((c) => !changed.includes(c));
        const done = changed.length > 0 ? `${check ? 'Checked' : 'Unchecked'} ${claudeNumbers(changed.map((c) => c.number))} in "${list.name}".` : '';
        const skipped = same.length > 0 ? `${claudeNumbers(same.map((c) => c.number))} ${same.length === 1 ? 'was' : 'were'} already ${check ? 'checked' : 'unchecked'}.` : '';
        const { done: checked, total } = progressOf(list);
        const rest = total - checked;
        const left = check ? `${rest} unchecked ${rest === 1 ? 'card' : 'cards'} left in "${list.name}".` : '';
        return [done, skipped, left].filter(Boolean).join(' ');
      }
      case 'card_revoke': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        const revoked = store.revokeCards(id, 'claude', list.id, cards.map((c) => c.id), stringArg(args.reason, 'reason'));
        const same = cards.filter((c) => !revoked.includes(c));
        const them = revoked.length === 1 ? 'it' : 'them';
        const done =
          revoked.length > 0
            ? `Revoked ${claudeNumbers(revoked.map((c) => c.number))} in "${list.name}" and moved ${them} to the trash (no longer in force; the reason stays in the thread, and only the user can restore and reinstate ${them}).`
            : '';
        const skipped = same.length > 0 ? `${claudeNumbers(same.map((c) => c.number))} ${same.length === 1 ? 'was' : 'were'} already revoked.` : '';
        const rest = activeCards(list).length;
        return [done, skipped, `${rest} ${rest === 1 ? 'card' : 'cards'} in force in "${list.name}".`].filter(Boolean).join(' ');
      }
      case 'card_reply': {
        const list = this.listArg(id, args.list);
        const [card] = this.cardsArg(list, args.number);
        store.reply(id, 'claude', list.id, card.id, stringArg(args.text, 'text'), false, own);
        return `Replied in the thread of "${list.name}" #${card.number}.`;
      }
      case 'card_move': {
        const list = this.listArg(id, args.list);
        // numbers に書いた順に並べる（parseNumbers は順番を保つ）
        const cards = this.cardsArg(list, args.numbers);
        // to_list を省くと、同じリストの中で並べ替える（番号はそのまま）
        const toName = optionalString(args.to_list)?.trim() || null;
        const found = toName === null ? list : store.findList(id, toName);
        // 決定事項から外へ移そうとしたら、移す先のリストを作る前に断る
        if (found?.id !== list.id) store.checkMoveOut('claude', list);
        const anchor = this.beforeArg(found, toName, args.before, cards);
        const to = found ?? store.createList(id, 'claude', toName ?? '', '');
        const from = cards.map((c) => c.number);
        const moved = store.moveCards(id, 'claude', list.id, cards.map((c) => c.id), to.id, anchor?.id ?? null);
        const where = anchor ? `before #${anchor.number}` : 'at the end';
        const order = `Order of "${to.name}" now: ${sequence(liveCards(to).map((c) => c.number))}.`;
        if (to.id === list.id) return `Put ${sequence(from)} in "${list.name}" ${where} (the numbers stay). ${order}`;
        const numbers = `new ${moved.length === 1 ? 'number' : 'numbers'}: ${sequence(moved.map((c) => c.number))}`;
        return `Moved ${sequence(from)} from "${list.name}" to "${to.name}"${anchor ? ` ${where}` : ''} (${numbers}).${anchor ? ` ${order}` : ''}`;
      }
      case 'card_delete': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        store.deleteCards(id, 'claude', list.id, cards.map((c) => c.id));
        const them = cards.length === 1 ? 'it' : 'them';
        // 決定事項のカードを戻せるのは人だけ
        const restore = traitsOf(list).locked ? `the user can restore ${them} in the app` : `restore ${them} with card_restore`;
        return `Moved ${claudeNumbers(cards.map((c) => c.number))} in "${list.name}" to the trash (${restore}).`;
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
    const wanted = args.notify !== false && to.id !== caller.id;
    // ターミナルモード（人が Claude Code の画面で操作している）の先には、Claude からの知らせを貼らない（人の入力に割り込むため）
    const terminal = wanted && this.deps.host.stateOf(to.id) === 'terminal';
    const notify = wanted && !terminal;
    if (notify) this.notifyCopy(from, to.id, result.list, result.cards, false);
    const where = to.id === caller.id ? 'this session' : `session "${nameOf(to)}" (${to.id.slice(0, 8)})`;
    return [
      `Copied ${claudeNumbers(cards.map((c) => c.number))} of "${list.name}" in session "${nameOf(from)}" to "${result.list.name}" in ${where} as ${claudeNumbers(result.cards.map((c) => c.number))}.`,
      result.createdList ? `(The list "${result.list.name}" did not exist, so it was created.)` : '',
      notify ? 'Claude in the destination session will be notified when it is idle.' : '',
      terminal ? 'Claude in the destination session was not notified: it is in terminal mode (the user is working in its Claude Code screen). Tell the user if it matters.' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  // 知らせはチャットにも出るので、画面の言語で書く
  private notifyCopy(from: SessionSummary, to: string, list: Checklist, cards: Card[], byHuman: boolean): void {
    const text = t('tools.notice.cardsCopied', {
      session: from.title ?? t('tools.notice.untitledSession'),
      list: list.name,
      numbers: formatNumbers(cards.map((c) => c.number)),
      titles: cards.map((c) => t('tools.notice.cardTitle', { title: c.title })).join(t('main.format.listSeparator')),
    });
    this.notices.add(to, `copy:${cards[0]?.id ?? ''}`, { text: clipNotice(text, 600), refs: cards.slice(0, 20).map((c) => ({ listId: list.id, cardId: c.id })), byHuman });
  }

  // --- 引数 ---

  private listArg(sessionId: string, raw: unknown): Checklist {
    const name = stringArg(raw, 'list');
    const list = this.deps.store.findList(sessionId, name);
    if (list) return list;
    const lists = this.deps.store.lists(sessionId);
    // ゴミ箱にあるリストなら、先に戻すよう伝える（決定事項のリストを戻せるのは人だけ）
    const trashed = trashOf(lists).lists.find((l) => nameKey(l.name) === nameKey(name));
    const hint = !trashed
      ? ''
      : traitsOf(trashed).locked
        ? ` The list "${trashed.name}" is in the trash, and only the user can restore it.`
        : ` The list "${trashed.name}" is in the trash: restore it first with list_restore.`;
    throw new ChecklistError(`There is no list "${name}".${hint} ${listNames(lists)}`);
  }

  // ゴミ箱のリスト。名前か、checklist_trash の id（頭の 8 文字から）で指す。同じ名前のものがいくつもあれば、id を頼む
  private trashedListArg(sessionId: string, raw: unknown): Checklist {
    const ref = stringArg(raw, 'list').trim();
    const lists = this.deps.store.lists(sessionId);
    const trashed = trashOf(lists).lists;
    const byName = trashed.filter((l) => nameKey(l.name) === nameKey(ref));
    const byId = /^[0-9a-f-]{8,}$/i.test(ref) ? trashed.filter((l) => l.id.startsWith(ref.toLowerCase())) : [];
    const found = byName.length > 0 ? byName : byId;
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new ChecklistError(`More than one list in the trash matches "${ref}" (ids: ${found.map((l) => l.id.slice(0, 8)).join(', ')}). Pass the id from checklist_trash.`);
    }
    if (this.deps.store.findList(sessionId, ref)) throw new ChecklistError(`The list "${ref}" is not in the trash.`);
    const names = trashed.map((l) => `"${l.name}" (${l.id.slice(0, 8)})`);
    throw new ChecklistError(`There is no list "${ref}" in the trash. ${names.length > 0 ? `Lists in the trash: ${names.join(', ')}.` : 'The trash has no lists.'}`);
  }

  // card_move の before（移す先のリストの番号）のカード。省くと null（最後に入れる）。
  // 移すカードそのものを指したら、そこから後ろの、移さない最初のカードの前に入れる（無ければ最後）
  private beforeArg(to: Checklist | undefined, toName: string | null, raw: unknown, moving: Card[]): Card | null {
    if (raw === undefined || raw === null) return null;
    const [number, ...rest] = parseNumbers(raw) ?? [];
    if (number === undefined || rest.length > 0) throw new ChecklistError('before must be one card number, like 3.');
    if (!to) throw new ChecklistError(`There is no list "${toName}" yet, so there is no #${number} to put the cards before. Omit before to create the list.`);
    const live = liveCards(to);
    const at = live.findIndex((c) => c.number === number);
    if (at < 0) throw new ChecklistError(`#${number} is not in "${to.name}". Check the numbers with checklist_overview.`);
    return live.slice(at).find((c) => !moving.includes(c)) ?? null;
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

  // ツールの対象のセッション（session_id を受けるツールだけ。cards_copy は、コピー元と先を自分で決める）。
  // 読めるのは見えるセッション（tanacode-sessions と同じ）、書き換えられるのは自分の子だけ（アーカイブしたものは除く）
  private targetArg(caller: SessionSummary, name: string, raw: unknown): SessionSummary {
    const tool = checklistTool(name);
    if (!tool?.inputSchema.properties.session_id) return caller;
    const target = this.sessionArg(caller, raw);
    if (target.id === caller.id || tool.kind === 'read') return target;
    if (target.parentId !== caller.id) {
      throw new ChecklistError(
        `You can read the checklists of session "${nameOf(target)}" (${target.id.slice(0, 8)}), but you can change only those of this session and of your child sessions.`,
      );
    }
    if (target.archived) throw new ChecklistError(`Can't change the checklists of "${nameOf(target)}" because it is an archived session.`);
    return target;
  }
}

// --- 結果の文 ---

// own: 呼び出し元のセッションのもの（ほかのセッションのものには、未読の数を出さない。未読は、そのセッションの Claude にとってのもの）
function overview(lists: Checklist[], own: boolean): string {
  const live = liveLists(lists);
  if (live.length === 0) return own ? 'This session has no checklists yet. You can create one with list_create.' : 'No checklists yet.';
  return live
    .map((list) => {
      const traits = traitsOf(list);
      const { done, total } = progressOf(list);
      const cards = liveCards(list).map((c) => {
        const unread = own ? claudeUnread(c) : 0;
        // チェックの無いリストは、チェック欄の代わりに、取り消したかどうかを出す
        const mark = traits.checkable ? `[${c.checked ? 'x' : ' '}] ` : c.revoked ? `(revoked${c.revoked.reason ? `: ${oneLine(c.revoked.reason, 200)}` : ''}) ` : '';
        return `- ${mark}#${c.number} ${c.title}${unread > 0 ? ` (${unread} unread ${unread === 1 ? 'reply' : 'replies'})` : ''}`;
      });
      const inForce = activeCards(list).length;
      const state = traits.checkable
        ? `${done}/${total} checked${traits.approves ? '; review list: cards the user checks move to the decisions list' : ''}`
        : traits.locked
          ? `decisions list: permanent, no checks; ${inForce} in force${total > inForce ? `, ${total - inForce} revoked` : ''}`
          : `state list: no checks, keep it current by rewriting its cards; ${total} ${total === 1 ? 'card' : 'cards'}`;
      return [`## ${list.name} (${state})`, `Description: ${list.description || '(none)'}`, ...(cards.length > 0 ? cards : ['(no cards)'])].join('\n');
    })
    .join('\n\n');
}

// own は overview と同じ（ほかのセッションのカードには、未読の印を付けない）
function cardText(list: Checklist, card: Card, own: boolean): string {
  const checked = card.checked ? `checked (by ${card.checkedBy === 'claude' ? 'Claude' : 'the user'}, ${time(card.checkedAt ?? 0)})` : 'not checked';
  const revoked = card.revoked
    ? `revoked, no longer in force (by ${card.revoked.by === 'claude' ? 'Claude' : 'the user'}, ${time(card.revoked.at)}${card.revoked.reason ? `: ${card.revoked.reason}` : ''})`
    : 'in force';
  const traits = traitsOf(list);
  const state = traits.checkable ? checked : traits.locked ? revoked : 'no checks (state list: rewrite the card when it is no longer true)';
  const thread = card.thread.map((e) => {
    const who = e.author === 'human' ? 'The user' : 'Claude';
    if (e.kind === 'event') return `- ${time(e.at)} ${eventText(e.event, who)}`;
    const unread = own && e.author === 'human' && e.at > card.readByClaude ? ' (unread)' : '';
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

// ゴミ箱の中身（画面のゴミ箱と同じもの）。決定事項のものには、戻せるのは人だけと添える
function trashText(lists: Checklist[]): string {
  const trash = trashOf(lists);
  if (trash.lists.length === 0 && trash.cards.length === 0) return 'The trash is empty.';
  const sections: string[] = [];
  if (trash.lists.length > 0) {
    const items = trash.lists.map((list) => {
      const cards = liveCards(list);
      // リストより前に 1 枚ずつ消したカード。リストを戻しても、ゴミ箱に残る
      const earlier = list.cards.length - cards.length;
      const restore = traitsOf(list).locked ? 'only the user can restore it' : 'restore it with list_restore';
      const head = `- "${list.name}" (id ${list.id.slice(0, 8)}; ${kindName(list)}; deleted${deleted(list.deletedBy, list.deletedAt)}; ${restore}): ${cardCount(cards.length)}`;
      const rest = earlier > 0 ? [`  - (${cardCount(earlier)} deleted before the list ${earlier === 1 ? 'stays' : 'stay'} in the trash after list_restore)`] : [];
      return [head, ...cards.map((c) => `  - #${c.number} ${c.title}`), ...rest].join('\n');
    });
    sections.push(['## Lists in the trash', ...items].join('\n'));
  }
  if (trash.cards.length > 0) {
    const items = trash.cards.map(({ list, card }) => {
      // 消した人は、スレッドの最後の「消した」の記録
      const by = card.thread.filter((e) => e.kind === 'event' && e.event.type === 'deleted').at(-1)?.author;
      const notes = [`deleted${deleted(by, card.deletedAt)}`, ...(card.revoked ? ['revoked'] : []), ...(traitsOf(list).locked ? ['only the user can restore it'] : [])];
      return `- "${list.name}" #${card.number} ${card.title} (${notes.join('; ')})`;
    });
    sections.push(['## Cards in the trash (restore them with card_restore)', ...items].join('\n'));
  }
  return sections.join('\n\n');
}

// 「deleted by Claude, 2026-10-15 10:00」の「 by Claude, 2026-10-15 10:00」（消した人が分からないものは時刻だけ）
function deleted(by: Author | undefined, at: number | undefined): string {
  return `${by ? ` by ${by === 'claude' ? 'Claude' : 'the user'},` : ''} ${time(at ?? 0)}`;
}

function kindName(list: Checklist): string {
  const kind = kindOf(list);
  return kind === 'normal' ? 'ordinary list' : `${kind} list`;
}

function cardCount(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

// 番号を並びのまま書く（[5, 6, 7, 2] → "#5-7, #2"）。並べ替えの結果に使う（claudeNumbers は小さい順に並べ直す）
function sequence(numbers: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    parts.push(j - i >= 2 ? `#${numbers[i]}-${numbers[j]}` : numbers.slice(i, j + 1).map((n) => `#${n}`).join(', '));
    i = j;
  }
  return parts.join(', ');
}

// 作ったリストの種類（ふつうのリストでは何も足さない）
function kindNote(list: Checklist): string {
  const kind = kindOf(list);
  if (kind === 'decisions') return ' as a decisions list (permanent, no checks; you can add cards and revoke them with card_revoke)';
  if (kind === 'state') return ' as a state list (no checks; keep it current by rewriting its cards with card_update)';
  return kind === 'review' ? ' as a review list (cards the user checks move to the decisions list)' : '';
}

// 種類の引数。省くと、ふつうのリスト
function kindArg(value: unknown, name: string): ListKind {
  if (value === undefined || value === null || value === '') return 'normal';
  if (!isListKind(value)) throw new ChecklistError(`${name} must be "decisions", "state" or "review" (omit it for an ordinary list).`);
  return value;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
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
