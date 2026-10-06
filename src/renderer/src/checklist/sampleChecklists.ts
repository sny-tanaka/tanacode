import type { Author, Card, CardEvent, Checklist, ThreadEntry } from '@shared/checklist';
import type { SessionSummary } from '@shared/ipc';

// ストーリーで使う、作り物のチェックリスト（税率を可変にする作業）
const base = Date.parse('2026-10-06T10:00:00+09:00');
let seq = 0;
const id = (prefix: string) => `${prefix}-${(++seq).toString(16).padStart(4, '0')}-0000-0000-000000000000`;
const at = (minutes: number) => base + minutes * 60_000;

const event = (author: Author, minutes: number, e: CardEvent): ThreadEntry => ({ id: id('e'), at: at(minutes), author, kind: 'event', event: e });
const reply = (author: Author, minutes: number, text: string, notify?: boolean): ThreadEntry => ({
  id: id('r'),
  at: at(minutes),
  author,
  kind: 'reply',
  text,
  ...(notify ? { notify } : {}),
});

function card(number: number, title: string, options: Partial<Card> & { by?: Author } = {}): Card {
  const by = options.by ?? 'claude';
  return {
    id: id('c'),
    number,
    title,
    body: '',
    checked: false,
    createdBy: by,
    createdAt: at(number),
    updatedAt: at(number),
    thread: [event(by, number, { type: 'created' })],
    readByHuman: at(1000),
    readByClaude: at(1000),
    ...options,
  };
}

export const todoList: Checklist = {
  id: id('l'),
  name: 'やること',
  description: '要件を整理した作業。上から順に進め、終わったらチェックする',
  nextNumber: 5,
  createdBy: 'claude',
  createdAt: at(0),
  cards: [
    card(1, '税率を設定ファイルから読む', { checked: true, checkedBy: 'claude', checkedAt: at(20) }),
    card(2, '税込価格の計算を 1 か所にまとめる', { checked: true, checkedBy: 'claude', checkedAt: at(35) }),
    card(3, '画面の税込表示を、まとめた計算に差し替える'),
    card(4, '税率を変えたときのテストを足す'),
  ],
};

export const goalList: Checklist = {
  id: id('l'),
  name: '完了前チェック',
  description: '作業を終える前に、すべて満たされているかを実際に確かめる。満たしていなければ直す',
  nextNumber: 4,
  createdBy: 'human',
  createdAt: at(0),
  cards: [
    card(1, '税率を可変にする', { by: 'human', checked: true, checkedBy: 'human', checkedAt: at(40) }),
    card(2, '税込表示が整数であること', { by: 'human' }),
    card(3, '税率0%でも壊れないこと', { by: 'human' }),
  ],
};

export const rounding = card(1, '端数の処理を切り捨てにした', {
  body: '税込価格の端数は **切り捨て** にしました。\n\n- 既存の請求書（`src/invoice/total.ts`）が切り捨てなので、それに合わせています\n- 四捨五入にするなら、`roundTax` の 1 か所を変えるだけです',
  thread: [
    event('claude', 10, { type: 'created' }),
    reply('claude', 10, '質問せずに進めるため、既存の請求書に合わせて切り捨てにしました。違っていたら教えてください。'),
    reply('human', 50, '四捨五入にしてください。経理からそう言われています。', true),
    reply('claude', 55, '四捨五入に変えました（`roundTax` を `Math.round` に）。テストも直して通っています。'),
    event('human', 60, { type: 'checked' }),
  ],
  checked: true,
  checkedBy: 'human',
  checkedAt: at(60),
  readByHuman: at(52),
});

export const decisionList: Checklist = {
  id: id('l'),
  name: '確認事項',
  description: '迷ったら質問せずに判断して進め、判断と理由をここに書く。人があとでまとめて見て、承認（チェック）するか訂正する',
  nextNumber: 3,
  createdBy: 'human',
  createdAt: at(0),
  cards: [rounding, card(2, '税率は環境変数ではなく設定ファイルに置いた', { thread: [event('claude', 12, { type: 'created' }), reply('claude', 12, '環境ごとに変える必要がないので、設定ファイルにしました。')], readByHuman: 0 })],
};

export const humanList: Checklist = {
  id: id('l'),
  name: '人のやること',
  description: 'Claude にはできない作業。人が済ませたらチェックする',
  nextNumber: 2,
  createdBy: 'claude',
  createdAt: at(0),
  cards: [card(1, '本番の設定ファイルの税率を、経理に確かめる')],
};

export const sampleLists: Checklist[] = [todoList, goalList, decisionList, humanList];

// ゴミ箱に入れたカードとリスト
export const trashedLists: Checklist[] = [
  { ...todoList, cards: [...todoList.cards, card(5, '間違って足したカード', { deletedAt: at(70) })] },
  { ...humanList, deletedAt: at(80) },
];

const session = (sid: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid,
  title,
  cwd: '/Users/me/work/shop',
  archived: false,
  createdAt: base,
  updatedAt: base,
  running: true,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
  parentId: null,
  ...extra,
});

export const sampleSession = session('11111111-0000-0000-0000-000000000000', '税率を可変にする');
export const sampleSessions: SessionSummary[] = [
  sampleSession,
  session('22222222-0000-0000-0000-000000000000', '請求書の PDF を直す'),
  session('33333333-0000-0000-0000-000000000000', '別のリポジトリの作業', { cwd: '/Users/me/work/other' }),
];
