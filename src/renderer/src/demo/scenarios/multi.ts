import type { Menu } from '@shared/screen';
import type { WorkflowRun } from '@shared/workflow';
import type { DemoBackend } from '../backend';
import { ROOT } from '../data';
import { sleep, type Director } from '../director';
import { Claude, option, pastTurn, statusLine } from './claude';

// 動画 4「複数のセッション」: いくつものセッションを並行して動かし、一覧の印と文言でそれぞれの状態を追う。
// 作業中（回る弧）・バックグラウンドの完了待ち（輪）・質問への回答待ち（脈打つ黄色）・新しい応答（青）が入れ替わる中で、
// 回答待ちのセッションに移って答え、新しい応答が来たセッションを順に読む

export const MULTI_SESSION = 'demo-images';
const README = 'demo-readme';
const TESTS = 'demo-tests';
const A11Y = 'demo-a11y';
const TAX = 'demo-tax';

const QUESTION = 'Node のバージョンの案内はどうしますか？';
const ANSWER = '.nvmrc を置いて、README から案内する';

const QUESTION_MENU: Menu = {
  kind: 'question',
  tabs: [],
  title: QUESTION,
  context: [],
  options: [
    option('1', ANSWER, 'nvm や fnm を使う人は、そのまま切り替えられる'),
    option('2', 'README に「Node 22 以上」とだけ書く', 'ファイルは増やさない'),
    option('3', 'package.json の engines に書く', 'npm install のときに警告が出る'),
  ],
  multiSelect: false,
  hint: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
};

const WORKFLOW: WorkflowRun = {
  toolUseId: 'a11y-wf',
  runId: 'wf_a11y',
  name: 'a11y-audit',
  summary: 'メニューのページを観点ごとに並列で点検し、見つかった問題を直して確かめる',
  status: 'running',
  phases: [{ title: '点検', detail: null }],
  agents: [],
  startedAt: Date.now() - 40_000,
  durationMs: null,
  totalTokens: null,
  totalToolCalls: null,
  resumed: false,
  resumedLater: false,
};

export function setupMulti(backend: DemoBackend): void {
  const min = 60_000;
  const now = Date.now();
  backend.addSession(TAX, { title: 'メニューに税込価格を出す', updatedAt: now - 180 * min }, pastTurn('tax', 'メニューの価格を税込みでも表示して', [['Read', 'src/lib/price.ts', 700], ['Edit', 'src/lib/price.ts', 900]], 'メニューに税込価格を出しました。', 180 * min));
  backend.addSession(
    A11Y,
    { title: 'メニューのアクセシビリティを点検する', updatedAt: now - 4 * min, backgroundTasks: 1 },
    [
      { type: 'user', id: 'a-u', text: 'メニューのページのアクセシビリティを点検して、見つかった問題を直して' },
      { type: 'tool-use', id: 'a11y-wf', name: 'Workflow', target: 'a11y-audit', input: 'a11y-audit', description: 'アクセシビリティを点検して直す', at: now - 4 * min },
      { type: 'tool-result', id: 'a11y-wf', isError: false, at: now - 4 * min + 500 },
      { type: 'assistant-text', id: 'a-t', text: '点検・修正・確認の 3 段で進めます。終わったら結果をまとめます。' },
      { type: 'turn-end' },
    ],
  );
  backend.setWorkflows(A11Y, [WORKFLOW]);
  backend.addSession(TESTS, { title: '価格まわりのテストを増やす', updatedAt: now - 2 * min }, [
    { type: 'user', id: 't-u', text: '価格まわりのテストを増やして。端数の切り捨ても確かめて' },
  ]);
  backend.addSession(README, { title: 'README のセットアップ手順を見直す', updatedAt: now - min }, [
    { type: 'user', id: 'r-u', text: 'README のセットアップ手順を、今の package.json に合わせて見直して' },
  ]);
  backend.addSession(MULTI_SESSION, { title: 'メニュー画像を遅延読み込みにする', updatedAt: now }, [
    ...pastTurn('img-past', 'メニューに画像を出したい。どこに置くのがいい？', [['Read', 'src/components/MenuCard.tsx', 600]], '`public/menu/` に置き、`MenuCard` で品目の ID から読み込むのがよいと思います。', 30 * min),
    { type: 'user', id: 'img-u', text: 'メニューの画像を遅延読み込みにして。最初の 1 枚だけはすぐ読み込んで' },
  ]);
  for (const id of [MULTI_SESSION, README, TESTS, A11Y, TAX]) backend.setStatusLine(id, statusLine(14, 28_000));
}

// 見ていないセッションで応答が終わったら「新しい応答」にする（本物は main がする）
function finish(backend: DemoBackend, claude: Claude, id: string, reply: string): void {
  claude.stopWorking();
  claude.say(reply);
  backend.push(id, { type: 'turn-end' });
  if (backend.focused !== id) backend.update(id, { unread: true });
}

export async function runMulti(backend: DemoBackend, d: Director): Promise<void> {
  const images = new Claude(backend, MULTI_SESSION, 'img-');
  const readme = new Claude(backend, README, 'rd-');
  const tests = new Claude(backend, TESTS, 'ts-');
  const a11y = new Claude(backend, A11Y, 'ay-');
  const answered = new Promise<void>((resolve) => {
    backend.onChoose = () => resolve();
  });

  // 1. 3 つのセッションが作業中、1 つがバックグラウンドの完了待ち。見ているのは画像のセッション
  d.caption('セッションの一覧の印で、作業中（回る弧）・バックグラウンドの完了待ち（輪）が分かります');
  images.startWorking();
  readme.startWorking();
  tests.startWorking();
  await sleep(800);
  const grep = images.use('Grep', '<img', { input: '<img' });
  await sleep(700);
  const pkg = readme.use('Read', 'package.json', { filePath: `${ROOT}/package.json` });
  images.result(grep, { output: 'src/components/MenuCard.tsx' });
  await sleep(700);
  const testRead = tests.use('Read', 'src/lib/price.test.ts', { filePath: `${ROOT}/src/lib/price.test.ts` });
  const read = images.use('Read', 'src/components/MenuCard.tsx', { filePath: `${ROOT}/src/components/MenuCard.tsx` });
  await sleep(900);
  images.result(read);
  tests.result(testRead);

  // 2. テストのセッションが終わる（新しい応答）。README のセッションが質問してくる（回答待ち）
  d.caption('終わったセッションは「新しい応答」（青）、質問してきたセッションは「回答待ち」（黄色）に');
  finish(backend, tests, TESTS, [
    '価格まわりのテストを 4 件足しました。',
    '',
    '- `withTax` の端数の切り捨て（755 円 → 830 円）',
    '- 0 円・1 円の境目',
    '- `formatPrice` の 3 桁区切り（1,000 円・10,000 円）',
    '',
    '`npm test` で 7 件とも通ります。',
  ].join('\n'));
  await sleep(900);
  const imgEdit = images.use('Edit', 'src/components/MenuCard.tsx', { filePath: `${ROOT}/src/components/MenuCard.tsx`, input: '+        loading={index === 0 ? "eager" : "lazy"}' });
  readme.result(pkg);
  readme.stopWorking();
  backend.setScreen(README, { state: { kind: 'menu', menu: QUESTION_MENU } });
  backend.update(README, { attention: 'question' });
  await sleep(1800);

  // 3. 回答待ちのセッションに移って、質問に答える
  d.caption('回答待ちのセッションに移って、質問に答えます');
  await d.click(d.byText('.session-row', 'README のセットアップ'), { ms: 900 });
  await sleep(1500);
  await d.moveTo(d.byText('.menu-option', 'README に「Node'), { ms: 700 });
  await sleep(900);
  await d.click(d.byText('.menu-option', ANSWER), { ms: 500 });
  await answered;
  backend.setScreen(README, { state: { kind: 'prompt' } });
  backend.update(README, { attention: null });
  const ask = readme.next('ask');
  backend.push(README, { type: 'tool-use', id: ask, name: 'AskUserQuestion', target: QUESTION, input: QUESTION, at: Date.now() });
  backend.push(README, { type: 'tool-result', id: ask, isError: false, answers: [{ header: 'Node', question: QUESTION, answer: ANSWER }], at: Date.now() });
  readme.startWorking();
  await sleep(1000);
  const nvmrc = readme.use('Write', '.nvmrc', { filePath: `${ROOT}/.nvmrc` });

  // 4. 画像のセッションが終わる（見ていないので新しい応答）
  d.caption('見ていない間に終わったセッションにも、新しい応答の印が付きます');
  images.result(imgEdit, { filePath: `${ROOT}/src/components/MenuCard.tsx`, added: 2, removed: 1 });
  finish(backend, images, MULTI_SESSION, [
    'メニューの画像を遅延読み込みにしました。',
    '',
    '- 2 枚目からは `loading="lazy"` で、画面に近づいてから読み込みます',
    '- 最初の 1 枚は `loading="eager"` のまま、すぐ出るようにしています',
  ].join('\n'));
  await sleep(900);
  readme.result(nvmrc, { filePath: `${ROOT}/.nvmrc`, added: 1, removed: 0 });
  await sleep(700);

  // 5. 新しい応答が来たテストのセッションを読む
  d.caption('新しい応答が来たセッションを、順に読んでいきます');
  await d.click(d.byText('.session-row', '価格まわりのテスト'), { ms: 900 });
  await sleep(2400);

  // 6. ワークフローが終わり、Claude が結果をまとめる。README のセッションも終わる
  d.caption('バックグラウンドのワークフローも終わり、結果が届きます');
  backend.setWorkflows(A11Y, [{ ...WORKFLOW, status: 'completed', durationMs: 260_000 }]);
  backend.update(A11Y, { backgroundTasks: 0 });
  backend.push(A11Y, { type: 'notice', id: 'ay-done', text: 'ワークフロー a11y-audit が終わりました' });
  a11y.startWorking();
  const edit = readme.use('Edit', 'README.md', { filePath: `${ROOT}/README.md` });
  await sleep(1400);
  readme.result(edit, { filePath: `${ROOT}/README.md`, added: 4, removed: 1 });
  finish(backend, readme, README, 'README に `.nvmrc` の案内を足し、`nvm use` から始める手順にしました。');
  await sleep(800);
  finish(backend, a11y, A11Y, [
    'アクセシビリティの点検と修正が終わりました。',
    '',
    '- **コントラスト**: 税抜の文字色を濃くし、3.9:1 → 5.2:1 に',
    '- **読み上げ**: 価格に `aria-label` を付け、「税込 572 円（税抜 520 円）」と読まれるように',
    '- **キーボード操作**: 問題なし',
  ].join('\n'));
  await sleep(1600);

  // 7. 残りの新しい応答を読む
  d.caption('残りの新しい応答も読みます。どのセッションが手待ちか、一目で分かります');
  await d.click(d.byText('.session-row', 'アクセシビリティ'), { ms: 900 });
  await sleep(2200);
  await d.click(d.byText('.session-row', 'メニュー画像'), { ms: 900 });
  await sleep(3000);
}
