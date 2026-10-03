import type { HookRun } from '@shared/chat';
import type { DemoBackend } from '../backend';
import { demoUsage, ROOT } from '../data';
import { sleep, type Director } from '../director';
import { Claude, pastTurn, statusLine } from './claude';

// 動画 6「見える化」: Claude が今の会話で知っている範囲・コンテキスト・hooks・利用枠を、作業に合わせて見せる。
// 読んだファイルに青い点、書いたファイルに橙の点が付き、コンテキストのメーターが伸びる →
// 編集のたびに PostToolUse の hooks が動き、1 回は型のエラーで止める → Claude が直す → Stop の hooks →
// 「圧縮」で区切りが入り、点が白抜き（圧縮前に読んだだけ）になってメーターが下がる

export const VISIBILITY_SESSION = 'demo-visibility';

const PROMPT = 'メニューに、アレルギーの表示を足して';
const CHECK = 'npx tsc --noEmit';

const TYPES = `export type MenuItem = {
  id: string;
  name: string;
  note: string;
  // 税抜の価格（円）
  price: number;
  // 含まれるアレルギー物質（特定原材料）
  allergens?: string[];
};
`;

const MENU = `import type { MenuItem } from '../types';

export const menu: MenuItem[] = [
  { id: 'latte', name: 'カフェラテ', note: '自家焙煎', price: 520, allergens: ['乳'] },
  { id: 'toast', name: 'あんバタートースト', note: '粒あん', price: 680, allergens: ['小麦', '乳'] },
  { id: 'tart', name: '季節のタルト', note: '日替わり', price: 750, allergens: ['小麦', '卵', '乳'] },
];
`;

const card = (guarded: boolean) => `import { formatPrice } from '../lib/price';
import type { MenuItem } from '../types';

export function MenuCard({ item }: { item: MenuItem }) {
  const { name, note, price, allergens } = item;
  return (
    <article className="menu-card">
      <h3>{name}</h3>
      <p className="note">{note}</p>
      <p className="price">{formatPrice(price)}</p>
      ${guarded ? '{allergens && allergens.length > 0 && (' : '{allergens.length > 0 && ('}
        <p className="allergens">アレルギー: {allergens.join('・')}</p>
      )}
    </article>
  );
}
`;

const hook = (toolUseId: string | null, event: string, patch: Partial<HookRun> = {}): HookRun => ({
  event,
  name: toolUseId ? `${event}:Edit` : event,
  command: CHECK,
  outcome: 'success',
  exitCode: 0,
  durationMs: 1200,
  stdout: '',
  stderr: '',
  message: '',
  toolUseId,
  ...patch,
});

export function setupVisibility(backend: DemoBackend): void {
  const hour = 3600_000;
  backend.addSession('demo-readme', { title: 'README のセットアップ手順を見直す', updatedAt: Date.now() - 5 * hour });
  backend.addSession('demo-images', { title: 'メニュー画像を遅延読み込みにする', updatedAt: Date.now() - 26 * hour });
  backend.addSession(
    VISIBILITY_SESSION,
    { title: 'メニューにアレルギー表示を足す' },
    pastTurn('past', 'このリポジトリで、メニューのデータはどこにある？', [['Glob', 'src/**/*.ts', 500]], 'メニューのデータは `src/data/menu.ts` にあります。型は `src/types.ts` の `MenuItem` です。', 3 * 60_000),
  );
  backend.know(VISIBILITY_SESSION, {}, 9_000);
  backend.setStatusLine(VISIBILITY_SESSION, statusLine(5, 9_000));
}

export async function runVisibility(backend: DemoBackend, d: Director): Promise<void> {
  const id = VISIBILITY_SESSION;
  const claude = new Claude(backend, id);
  const sends: string[] = [];
  let onSend = () => {};
  backend.onUserMessage = (_sid, text) => {
    claude.user(text);
    sends.push(text);
    onSend();
  };
  const sent = (count: number) => new Promise<void>((resolve) => (sends.length >= count ? resolve() : (onSend = () => sends.length >= count && resolve())));
  // コンテキストの使用量（statusLine の値でメーターが動く）
  const context = (tokens: number) => backend.setStatusLine(id, statusLine(Math.round((tokens / 200_000) * 100), tokens));

  // 1. ファイルツリーを開いておく（まだ点は付いていない）
  await sleep(900);
  await d.click('.tree-row[title="src"]', { ms: 800 });
  await sleep(200);
  await d.click('.tree-row[title="src/components"]', { ms: 400 });
  await sleep(200);
  await d.click('.tree-row[title="src/data"]', { ms: 400 });
  await sleep(200);
  await d.click('.tree-row[title="src/lib"]', { ms: 400 });
  await sleep(500);

  // 2. 指示を送る
  await d.click('.chat-input textarea', { ms: 800 });
  await d.type('.chat-input textarea', PROMPT);
  await sleep(300);
  await d.click('.chat-input-row [aria-label="送信"]');
  await sent(1);
  claude.startWorking();

  // 3. 読んだファイルに青い点が付き、コンテキストが伸びる
  await sleep(1200);
  for (const [path, tokens] of [
    ['src/types.ts', 14_000],
    ['src/data/menu.ts', 19_000],
    ['src/components/MenuCard.tsx', 25_000],
  ] as const) {
    await claude.tool('Read', path, 600, { filePath: `${ROOT}/${path}` });
    backend.know(id, { [path]: 'read' });
    context(tokens);
    await sleep(300);
  }

  // 4. 書いたファイルに橙の点。編集のたびに PostToolUse の hooks（型チェック）が動く
  const edited = async (path: string, text: string, patch: string[], tokens: number, run: Partial<HookRun> = {}) => {
    const toolId = await claude.edit(path, text, 800, patch);
    await sleep(500);
    backend.push(id, { type: 'hook', id: claude.next('hook'), run: hook(toolId, 'PostToolUse', run) });
    context(tokens);
    await sleep(400);
  };
  await edited('src/types.ts', TYPES, ['+  // 含まれるアレルギー物質（特定原材料）', '+  allergens?: string[];'], 29_000);
  await edited('src/data/menu.ts', MENU, ["-  { id: 'latte', name: 'カフェラテ', note: '自家焙煎', price: 520 },", "+  { id: 'latte', name: 'カフェラテ', note: '自家焙煎', price: 520, allergens: ['乳'] },"], 33_000);
  const error = "src/components/MenuCard.tsx(11,8): error TS18048: 'allergens' is possibly 'undefined'.";
  await edited('src/components/MenuCard.tsx', card(false), ['+      {allergens.length > 0 && (', "+        <p className=\"allergens\">アレルギー: {allergens.join('・')}</p>", '+      )}'], 37_000, {
    outcome: 'blocked',
    exitCode: 2,
    durationMs: 1400,
    stderr: error,
    message: error,
  });

  // 5. 畳んだ操作を開くと、編集のカードの下に hooks が出る。止めたもの（赤）を開いて理由を見る
  await sleep(600);
  await d.click(() => [...document.querySelectorAll('.tool-group-head')].at(-1), { ms: 800 });
  await sleep(900);
  const list = document.querySelector('.claude .chat-list');
  const toBottom = () => list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  toBottom();
  await sleep(700);
  await d.click('.hook-run.blocked .hook-chip', { ms: 700 });
  // 開いた理由が見えるところまで送る
  await sleep(200);
  toBottom();
  await sleep(2200);
  // 閉じて、チャットの末尾に戻る（末尾にいれば、新しい行を追いかける）
  await d.click(() => [...document.querySelectorAll('.tool-group-head')].at(-1), { ms: 700 });
  toBottom();
  await sleep(500);

  // 6. Claude が型のエラーを直し、今度は hooks が通る
  claude.say('型チェックの hooks で、`allergens` が無い品目のことを考えていないと止められました。直します。');
  await sleep(600);
  await edited('src/components/MenuCard.tsx', card(true), ['-      {allergens.length > 0 && (', '+      {allergens && allergens.length > 0 && ('], 40_000);

  // 7. 応答が届いて完了。ターンの終わりに Stop の hooks が動く。利用枠も進む
  await sleep(500);
  claude.stopWorking();
  claude.say(
    [
      'メニューにアレルギーの表示を足しました。',
      '',
      '- `MenuItem` に `allergens`（省略できる）を追加',
      '- 3 品のデータに原材料を追加',
      '- カードの下に「アレルギー: 小麦・乳」の形で出します（無い品目では出しません）',
    ].join('\n'),
  );
  backend.push(id, { type: 'hook', id: claude.next('hook'), run: hook(null, 'Stop', { command: 'npm test', durationMs: 3200 }) });
  backend.push(id, { type: 'turn-end' });
  const usage = demoUsage();
  backend.setUsage({ ...usage, limits: usage.limits.map((l, i) => ({ ...l, percent: l.percent + (i === 0 ? 4 : 1) })) });
  await sleep(1200);
  await d.moveTo('.usage-panel', { ms: 900 });
  await sleep(1500);

  // 8. 「圧縮」で会話を要約する。区切りが入り、点は白抜き（圧縮前に読んだだけ）になって、メーターが下がる
  await d.click('.claude-header button[aria-label="圧縮"]', { ms: 900 });
  await sent(2);
  claude.startWorking();
  await sleep(2600);
  claude.stopWorking();
  backend.push(id, { type: 'divider', id: claude.next('compact'), text: '会話を圧縮しました（40k tokens から）' });
  backend.push(id, { type: 'turn-end' });
  const files = backend.sessions.get(id)!.knowledge;
  backend.know(id, Object.fromEntries(Object.keys(files).map((path) => [path, 'stale' as const])));
  context(7_000);
  await sleep(800);
  await d.moveTo('.tree-row[title="src/components/MenuCard.tsx"]', { ms: 900 });
  await sleep(3500);
}
