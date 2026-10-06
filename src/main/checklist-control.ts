import { claudeUnread, withParticle, eventText, formatNumbers, liveCards, liveLists, parseNumbers, progressOf, type Card, type Checklist, type ChecklistCopyRequest, type ChecklistOp } from '@shared/checklist';
import { checklistEventText, checklistTool, clipNotice, noticeMessage, replyNoticeText, type CardRef } from '@shared/checklist-tools';
import type { SessionSummary } from '@shared/ipc';
import { canSee } from '@shared/session-tools';
import { ChecklistError, type ChecklistStore } from './checklist-store';
import { textResult, type ToolResult } from './mcp-bridge';
import { SessionNotices, type NoticeHost } from './session-notices';

// Claude によるチェックリストの扱い（MCP サーバー tanacode-checklist のツールの実行）と、画面からの書き換え。
// 呼び出し元のセッションは中継の env で渡ってくる。リストは名前で、カードはリストの中の番号で指す。
// 人がスレッドに「Claude に通知する」で返信したとき・ほかのセッションからカードが届いたときは、手の空いた Claude に知らせる。
// 別のセッションとのコピーは、tanacode-sessions と同じく見えるセッション（同じフォルダ・親子・兄弟）のあいだだけ

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

  // 画面からの、別のセッションへのコピー
  copy(request: ChecklistCopyRequest): void {
    const sessions = this.deps.host.list();
    const from = sessions.find((s) => s.id === request.fromSession);
    const to = sessions.find((s) => s.id === request.toSession);
    if (!from || !to) throw new ChecklistError('セッションが見つかりません');
    // Claude と同じく、同じフォルダと親子・兄弟のセッションのあいだだけ
    if (!canSee(from, to)) throw new ChecklistError('コピーできるのは、同じフォルダのセッションと、親子・兄弟のセッションだけです');
    if (to.archived) throw new ChecklistError('アーカイブしたセッションにはコピーできません');
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
    if (!checklistTool(name)) return textResult(`知らないツールです: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult('ユーザーが tanacode のメニューで「Claude にチェックリストを扱わせる」をオフにしています。使うには、ユーザーにオンにしてもらってください', true);
    }
    const caller = this.deps.host.list().find((s) => s.id === callerId);
    if (!caller) return textResult('このセッションは tanacode にありません', true);
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
      result.content.push({ type: 'text', text: `（前回のツールの呼び出しから、人がチェックリストを変えました）\n${lines.join('\n')}` });
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
        return `リスト「${list.name}」を作りました。`;
      }
      case 'list_update': {
        const list = this.listArg(id, args.list);
        const updated = store.updateList(id, 'claude', list.id, { name: optionalString(args.name), description: optionalString(args.description) });
        return `リスト「${updated.name}」を変えました。`;
      }
      case 'list_delete': {
        const list = this.listArg(id, args.list);
        store.deleteList(id, 'claude', list.id);
        return `リスト「${list.name}」をゴミ箱に入れました（人が画面から戻せます）。`;
      }
      case 'card_add': {
        const raw = Array.isArray(args.cards) ? (args.cards as { title?: unknown; body?: unknown }[]) : [];
        if (raw.length === 0) throw new ChecklistError('cards に、足すカードを 1 つ以上渡してください');
        const cards = raw.map((c) => ({ title: typeof c?.title === 'string' ? c.title : '', body: typeof c?.body === 'string' ? c.body : undefined }));
        let list = store.findList(id, stringArg(args.list, 'list'));
        let note = '';
        if (!list) {
          const description = optionalString(args.list_description);
          if (description === undefined) {
            throw new ChecklistError(`リスト「${args.list}」がありません。${listNames(store.lists(id))}作るなら list_description（使い方のルール）も渡してください`);
          }
          list = store.createList(id, 'claude', String(args.list), description);
          note = `リスト「${list.name}」を作りました。`;
        }
        const added = store.addCards(id, 'claude', list.id, cards);
        return `${note}「${list.name}」に ${added.map((c) => `#${c.number}「${c.title}」`).join('、')} を足しました。`;
      }
      case 'card_update': {
        const list = this.listArg(id, args.list);
        const [card] = this.cardsArg(list, args.number);
        const updated = store.updateCard(id, 'claude', list.id, card.id, { title: optionalString(args.title), body: optionalString(args.body) });
        return `「${list.name}」#${updated.number} を変えました。`;
      }
      case 'card_check':
      case 'card_uncheck': {
        const check = name === 'card_check';
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        const comment = check ? optionalString(args.comment) : stringArg(args.reason, 'reason');
        const changed = store.setChecked(id, 'claude', list.id, cards.map((c) => c.id), check, comment);
        const same = cards.filter((c) => !changed.includes(c));
        const done = changed.length > 0 ? `「${list.name}」の ${formatNumbers(changed.map((c) => c.number))} の${check ? 'チェックを付けました' : 'チェックを外しました'}。` : '';
        const skipped = same.length > 0 ? `${formatNumbers(same.map((c) => c.number))} は、もとから${check ? 'チェック済み' : 'チェックなし'}です。` : '';
        const { done: checked, total } = progressOf(list);
        const left = check ? ` 「${list.name}」の残りは ${total - checked} 枚です。` : '';
        return `${done}${skipped}${left}`.trim();
      }
      case 'card_reply': {
        const list = this.listArg(id, args.list);
        const [card] = this.cardsArg(list, args.number);
        store.reply(id, 'claude', list.id, card.id, stringArg(args.text, 'text'));
        return `「${list.name}」#${card.number} のスレッドに返信しました。`;
      }
      case 'card_move': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        const toName = stringArg(args.to_list, 'to_list');
        const to = store.findList(id, toName) ?? store.createList(id, 'claude', toName, '');
        if (to.id === list.id) throw new ChecklistError('移す先が同じリストです');
        const before = cards.map((c) => c.number);
        const moved = store.moveCards(id, 'claude', list.id, cards.map((c) => c.id), to.id);
        return `「${list.name}」の ${formatNumbers(before)} を「${to.name}」に移しました（新しい番号: ${formatNumbers(moved.map((c) => c.number))}）。`;
      }
      case 'card_delete': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers);
        store.deleteCards(id, 'claude', list.id, cards.map((c) => c.id));
        return `「${list.name}」の ${formatNumbers(cards.map((c) => c.number))} をゴミ箱に入れました（card_restore で戻せます）。`;
      }
      case 'card_restore': {
        const list = this.listArg(id, args.list);
        const cards = this.cardsArg(list, args.numbers, true);
        const restored = store.restoreCards(id, 'claude', list.id, cards.map((c) => c.id));
        return restored.length > 0 ? `「${list.name}」の ${formatNumbers(restored.map((c) => c.number))} を戻しました。` : 'ゴミ箱に入っているカードはありませんでした。';
      }
      case 'cards_copy':
        return this.copyByClaude(caller, args);
      default:
        throw new ChecklistError(`知らないツールです: ${name}`);
    }
  }

  private copyByClaude(caller: SessionSummary, args: Record<string, unknown>): string {
    const from = this.sessionArg(caller, args.from_session);
    const to = this.sessionArg(caller, args.to_session);
    if (from.id === to.id) throw new ChecklistError('コピー元とコピー先が同じセッションです。同じセッションの中で移すなら card_move を使ってください');
    if (to.archived) throw new ChecklistError(`「${nameOf(to)}」はアーカイブしたセッションなので、コピーできません`);
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
    const where = to.id === caller.id ? 'このセッション' : `セッション「${nameOf(to)}」（${to.id.slice(0, 8)}）`;
    return [
      `セッション「${nameOf(from)}」の「${list.name}」${formatNumbers(cards.map((c) => c.number))} を、${where}の「${result.list.name}」に ${formatNumbers(result.cards.map((c) => c.number))} としてコピーしました。`,
      result.createdList ? `（「${result.list.name}」は無かったので作りました）` : '',
      notify ? 'コピー先の Claude に、手が空いたら知らせます。' : '',
    ]
      .filter(Boolean)
      .join('');
  }

  private notifyCopy(from: SessionSummary, to: string, list: Checklist, cards: Card[]): void {
    const text = `セッション「${nameOf(from)}」から「${list.name}」に ${formatNumbers(cards.map((c) => c.number))}（${cards.map((c) => `「${c.title}」`).join('、')}）が届きました。`;
    this.notices.add(to, `copy:${cards[0]?.id ?? ''}`, { text: clipNotice(text, 600), refs: cards.slice(0, 20).map((c) => ({ listId: list.id, cardId: c.id })) });
  }

  // --- 引数 ---

  private listArg(sessionId: string, raw: unknown): Checklist {
    const name = stringArg(raw, 'list');
    const list = this.deps.store.findList(sessionId, name);
    if (!list) throw new ChecklistError(`リスト「${name}」がありません。${listNames(this.deps.store.lists(sessionId))}`);
    return list;
  }

  // 番号の指定から、カード（ゴミ箱のものは trashed のときだけ）。無い番号があれば、そう返す
  private cardsArg(list: Checklist, raw: unknown, trashed = false): Card[] {
    const numbers = parseNumbers(raw);
    if (!numbers || numbers.length === 0) throw new ChecklistError('番号は "3"・"5-8"・"5,7,9" のように書いてください');
    const pool = trashed ? list.cards.filter((c) => c.deletedAt) : liveCards(list);
    const found = numbers.map((n) => pool.find((c) => c.number === n));
    const missing = numbers.filter((_, i) => !found[i]);
    if (missing.length > 0) {
      const what = trashed ? 'ゴミ箱に' : '';
      throw new ChecklistError(`「${list.name}」の${what} ${formatNumbers(missing)} はありません。checklist_overview で番号を確かめてください`);
    }
    return found as Card[];
  }

  // 見えるセッション（tanacode-sessions と同じ）。省くと呼び出し元
  private sessionArg(caller: SessionSummary, raw: unknown): SessionSummary {
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!id) return caller;
    if (id.length < 8) throw new ChecklistError('セッションの ID は、先頭 8 文字以上で渡してください');
    const matches = this.deps.host.list().filter((s) => canSee(caller, s) && s.id.startsWith(id));
    if (matches.length === 0) throw new ChecklistError(`見えるセッションに、ID が ${id} のものはありません（tanacode-sessions の list_sessions で確かめてください）`);
    if (matches.length > 1) throw new ChecklistError(`ID が ${id} で始まるセッションが 2 つ以上あります。もっと長く渡してください`);
    return matches[0];
  }
}

// --- 結果の文 ---

function overview(lists: Checklist[]): string {
  const live = liveLists(lists);
  if (live.length === 0) return 'このセッションには、まだチェックリストがありません。list_create で作れます。';
  return live
    .map((list) => {
      const { done, total } = progressOf(list);
      const cards = liveCards(list).map((c) => {
        const unread = claudeUnread(c);
        return `- [${c.checked ? 'x' : ' '}] #${c.number} ${c.title}${unread > 0 ? `（未読の返信 ${unread} 件）` : ''}`;
      });
      return [`## ${list.name}（${done}/${total} チェック済み）`, `説明: ${list.description || '（なし）'}`, ...(cards.length > 0 ? cards : ['（カードはありません）'])].join('\n');
    })
    .join('\n\n');
}

function cardText(list: Checklist, card: Card): string {
  const state = card.checked ? `チェック済み（${card.checkedBy === 'claude' ? 'Claude' : '人'}・${time(card.checkedAt ?? 0)}）` : 'チェックなし';
  const thread = card.thread.map((e) => {
    const who = e.author === 'human' ? '人' : 'Claude';
    if (e.kind === 'event') return `- ${time(e.at)} ${eventText(e.event, who)}`;
    const unread = e.author === 'human' && e.at > card.readByClaude ? '（未読）' : '';
    return `- ${time(e.at)} ${withParticle(who, 'の')}返信${unread}:\n${indent(e.text)}`;
  });
  return [
    `## 「${list.name}」#${card.number} ${card.title}`,
    `- 状態: ${state}`,
    `- 作った人: ${card.createdBy === 'human' ? '人' : 'Claude'}`,
    '',
    '### 説明文',
    card.body || '（なし）',
    '',
    '### スレッド',
    ...thread,
  ].join('\n');
}

function listNames(lists: Checklist[]): string {
  const names = liveLists(lists).map((l) => `「${l.name}」`);
  return names.length > 0 ? `あるのは${names.join('、')}です。` : 'リストはまだありません。';
}

function nameOf(s: SessionSummary): string {
  return s.title ?? '新しいセッション';
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
  if (typeof value !== 'string' || !value.trim()) throw new ChecklistError(`${name} を渡してください`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（${text.length - max} 文字を省略）` : text;
}
