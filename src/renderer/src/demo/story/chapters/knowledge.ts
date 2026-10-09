import type { HookRun } from '@shared/chat';
import { demoUsage, ROOT } from '../../data';
import { sleep } from '../../director';
import { statusLine } from '../../scenarios/claude';
import { MENU_WITH_ALLERGENS, menuCardWithAllergens, TYPES_WITH_ALLERGENS } from '../files';
import { addCards, ASK_BODY, ASK_LIST, ASK_TITLE, checkCards, DONE_LIST, showPanel } from '../checklist';
import { MAIN, type Story } from '../story';

// 章 3「Claude が知っている範囲」: 次の指示（アレルギー表示）を進める間に、Claude が読んだ・書いたファイルの点、
// コンテキストのメーター、hooks（型チェックが止めた理由）、利用枠を見る。
// 迷うところは質問させずに決めさせ、チェックリストの「確認事項」に残させる（人は章 5 で答える）

const PROMPT = 'メニューに、アレルギーの表示も足して。迷うところは質問せずに決めて、「確認事項」に残しておいて';
const CHECK = 'npx tsc --noEmit';

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

export async function runKnowledge(story: Story): Promise<void> {
  const { backend, d } = story;
  const claude = story.claude();
  const id = MAIN;
  // コンテキストの使用量（statusLine の値でメーターが動く）
  const context = (tokens: number) => backend.setStatusLine(id, statusLine(Math.round((tokens / 200_000) * 100), tokens));

  // 1. エクスプローラーの点。章 2 で読んだファイルは青、書いたファイルは橙
  d.caption('エクスプローラーの行頭の点で、Claude が今の会話で読んだファイル（青）と書いたファイル（橙）が分かります', '.explorer');
  await story.expand('src');
  await story.expand('src/data', 400);
  await story.expand('src/lib', 400);
  await d.moveTo('.tree-row[title="src/lib/price.ts"]', { ms: 800 });
  await sleep(2000);

  // 2. 次の指示を送る
  d.caption('続けて、次の指示を送ります', '.chat-input');
  await story.send(PROMPT);
  claude.startWorking();

  // 3. 読んだファイルに青い点が付き、コンテキストが伸びる
  d.caption('Claude が読んだファイルに青い点が付き、ヘッダーのコンテキストのメーターが伸びます', '.claude-header .context-meter');
  await sleep(1000);
  for (const [path, tokens] of [
    ['src/types.ts', 52_000],
    ['src/data/menu.ts', 56_000],
    ['src/components/MenuList.tsx', 58_000],
  ] as const) {
    await claude.tool('Read', path, 600, { filePath: `${ROOT}/${path}` });
    backend.know(id, { [path]: 'read' });
    context(tokens);
    await sleep(300);
  }

  // 4. 書いたファイルに橙の点。編集のたびに PostToolUse の hooks（型チェック）が動く
  d.caption('編集のたびに、hooks（型チェック）が動きます。hooks の結果は、編集のカードの下に出ます', () => [...document.querySelectorAll('.claude .tool-group')].at(-1));
  const edited = async (path: string, text: string, patch: string[], tokens: number, run: Partial<HookRun> = {}) => {
    const toolId = await claude.edit(path, text, 800, patch);
    await sleep(500);
    backend.push(id, { type: 'hook', id: claude.next('hook'), run: hook(toolId, 'PostToolUse', run) });
    context(tokens);
    await sleep(400);
  };
  await edited('src/types.ts', TYPES_WITH_ALLERGENS, ['+  // 含まれるアレルギー物質（特定原材料）', '+  allergens?: string[];'], 61_000);
  await edited('src/data/menu.ts', MENU_WITH_ALLERGENS, ["-  { id: 'latte', name: 'カフェラテ', note: '自家焙煎', price: 520 },", "+  { id: 'latte', name: 'カフェラテ', note: '自家焙煎', price: 520, allergens: ['乳'] },"], 64_000);
  const error = "src/components/MenuCard.tsx(15,8): error TS18048: 'allergens' is possibly 'undefined'.";
  await edited('src/components/MenuCard.tsx', menuCardWithAllergens(false), ['+      {allergens.length > 0 && (', "+        <p className=\"allergens\">アレルギー: {allergens.join('・')}</p>", '+      )}'], 67_000, {
    outcome: 'blocked',
    exitCode: 2,
    durationMs: 1400,
    stderr: error,
    message: error,
  });

  // 5. 畳んだ操作を開くと、編集のカードの下に hooks が出る。止めたもの（赤）を開いて理由を見る
  d.caption('hooks に止められたもの（赤）は、開くと理由が読めます', () => [...document.querySelectorAll('.claude .tool-group')].at(-1));
  await sleep(600);
  await d.click(() => [...document.querySelectorAll('.tool-group-head')].at(-1), { ms: 800 });
  await sleep(900);
  story.toBottom();
  await sleep(700);
  await d.click('.hook-run.blocked .hook-chip', { ms: 700 });
  await sleep(200);
  story.toBottom();
  // README の紹介画像は、この場面（エクスプローラーの読んだ・書いたファイルの点、コンテキストのメーター、hooks が止めた理由）
  await story.mark('showcase');
  await sleep(2200);
  await d.click(() => [...document.querySelectorAll('.tool-group-head')].at(-1), { ms: 700 });
  story.toBottom();
  await sleep(500);

  // 6. Claude が型のエラーを直し、今度は hooks が通る
  d.caption('Claude が型のエラーを直し、今度は hooks が通ります', () => [...document.querySelectorAll('.claude .tool-group')].at(-1));
  claude.say('型チェックの hooks で、`allergens` が無い品目のことを考えていないと止められました。直します。');
  await sleep(600);
  await edited('src/components/MenuCard.tsx', menuCardWithAllergens(true), ['-      {allergens.length > 0 && (', '+      {allergens && allergens.length > 0 && ('], 70_000);

  // 7. 完了前チェックにカードを足して確かめ、自分で決めたことを「確認事項」に残す
  await sleep(500);
  await addCards(story, DONE_LIST, [{ title: 'アレルギー物質の無い品目には、表示を出さない' }], 700);
  await checkCards(story, DONE_LIST, [5], '`allergens` が無い品目で出ないことを、型チェックの hooks と表示で確かめました', 700);
  await addCards(story, ASK_LIST, [{ title: ASK_TITLE, body: ASK_BODY }], 800);

  // 8. 応答が届いて完了。ターンの終わりに Stop の hooks が動く。利用枠も進む
  await sleep(500);
  claude.stopWorking();
  claude.say(
    [
      'メニューにアレルギーの表示を足しました。',
      '',
      '- `MenuItem` に `allergens`（省略できる）を追加',
      '- 3 品のデータに原材料を追加',
      '- カードの下に「アレルギー: 小麦・乳」の形で出します（無い品目では出しません）',
      '',
      '出すのを特定原材料の 8 品目だけにしたのは私の判断なので、「確認事項」に残しました。',
    ].join('\n'),
  );
  backend.push(id, { type: 'hook', id: claude.next('hook'), run: hook(null, 'Stop', { command: 'npm test', durationMs: 3200 }) });
  backend.push(id, { type: 'turn-end' });
  const usage = demoUsage();
  backend.setUsage({ ...usage, limits: usage.limits.map((l, i) => ({ ...l, percent: l.percent + (i === 0 ? 4 : 1) })) });
  d.caption('応答が届いて完了。左下の利用枠も、使った分だけ進みます', '.account-panel');
  await sleep(1000);
  await d.moveTo('.account-panel', { ms: 900 });
  await sleep(2000);

  // 9. 迷ったところは、作業を止めずに「確認事項」に残っている。人は手が空いたときに見る（章 5）
  d.caption('Claude は迷ったところで作業を止めずに自分で決め、「確認事項」に残しました。人は手が空いたときに見て答えます', '.activity-bar [aria-label^="チェックリスト"]');
  await showPanel(d, 'チェックリスト', 900);
  await sleep(2600);
}
