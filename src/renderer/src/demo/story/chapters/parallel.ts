import type { Menu } from '@shared/screen';
import type { BashTask } from '@shared/task';
import { ROOT } from '../../data';
import { sleep } from '../../director';
import { option, statusLine } from '../../scenarios/claude';
import { readerLog, WORKFLOW_TOOL, WorkflowPlayer } from '../../scenarios/workflow';
import { MAIN, type Story } from '../story';

// 章 7「並行して進める」: 残りの作業を、親（このセッション）の Claude が子セッションに分けて任せる。
// 子の起動の許可 → 子が親の下に並ぶ → 一覧の印で状態を追う → 回答待ちの子に答える（子のチャットには「親セッションからの指示」）→
// 別の子のワークフローのフロー図を見る → 親の開発サーバー（バックグラウンドの Bash）を止める → 子が終わると親に知らせが届く

const PROMPT = '残りの作業を子セッションに分けて、並行で進めて。README に価格の表記のルールを書くのと、メニューのページのアクセシビリティの点検';

// 子セッションの ID（チャットのカードから子へ移れるよう、16 進数の UUID の形にする）
const README_CHILD = 'c0de0001-0000-4000-8000-000000000001';
const A11Y_CHILD = 'c0de0002-0000-4000-8000-000000000002';

const CHILDREN: Record<string, { name: string; prompt: string }> = {
  [README_CHILD]: { name: 'README に価格の表記を書く', prompt: 'README に、価格の表記のルール（税込を大きく・税抜を小さく・テイクアウトは 8%）を書いてください。' },
  [A11Y_CHILD]: { name: 'アクセシビリティの点検', prompt: 'メニューのページのアクセシビリティを点検し、見つかった問題を直してください。' },
};

const QUESTION = '価格の表記のルールは、README のどこに書きますか？';
const ANSWER = '「表示のルール」の節を新しく作る';

const START_PERMISSION = (name: string, prompt: string): Menu => ({
  kind: 'permission',
  tabs: [],
  title: 'Do you want to proceed?',
  context: [
    'Tool use',
    `tanacode-sessions - start_session(prompt: "${prompt}", worktree: true, name: "${name}") (MCP)`,
    '子セッションを起動します。子は tanacode のセッションとして動き、Claude の利用枠を子の数だけ使います',
  ],
  options: [option('1', 'Yes', ''), option('2', 'No, and tell Claude what to do differently (esc)', '')],
  multiSelect: false,
  hint: 'Esc to cancel',
});

const QUESTION_MENU: Menu = {
  kind: 'question',
  tabs: [],
  title: QUESTION,
  context: [],
  options: [option('1', ANSWER, '「セットアップ」の下に置く'), option('2', '「セットアップ」の節に書き足す', '節は増やさない')],
  multiSelect: false,
  hint: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
};

const DEV_SERVER = 'bg-dev';

export async function runParallel(story: Story): Promise<void> {
  const { backend, d } = story;
  const parent = story.claude();

  // 1. 親に、子セッションに分けて進めるよう頼む
  d.caption('残りの作業を、子セッションに分けて並行で進めるよう頼みます', '.chat-input');
  await story.send(PROMPT);
  parent.startWorking();
  await sleep(1200);

  // 開発サーバーをバックグラウンドで動かしておく（子の確認用）
  const dev = parent.use('Bash', 'npm run dev', { description: '開発サーバーを起動する', input: 'npm run dev' });
  const devTask = (state: BashTask['state']): BashTask => ({
    toolUseId: dev,
    taskId: DEV_SERVER,
    command: 'npm run dev',
    description: '開発サーバーを起動する',
    state,
    startedAt: Date.now() - 4000,
    endedAt: state === 'running' ? null : Date.now(),
    exitCode: state === 'running' ? null : 143,
    output: '  VITE v7.3.6  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/',
    truncated: false,
  });
  backend.setBash(MAIN, [devTask('running')]);
  parent.result(dev, { output: 'バックグラウンドで実行しています（id: bg-dev）' });
  await sleep(600);
  parent.say('2 つの作業を、それぞれ子セッションに任せます。');

  // 2. 子を始めるたびに、許可の確認が出る
  const startChild = async (child: string, first: boolean) => {
    const { name, prompt } = CHILDREN[child];
    const tool = parent.use('mcp__tanacode-sessions__start_session', prompt, {
      input: JSON.stringify({ prompt, worktree: true, name }, null, 2),
    });
    parent.stopWorking();
    const chosen = story.nextChoice();
    backend.setScreen(MAIN, { state: { kind: 'menu', menu: START_PERMISSION(name, prompt) } });
    backend.update(MAIN, { attention: 'permission' });
    await sleep(first ? 1600 : 700);
    await d.click(d.byText('.menu-option', 'Yes'), { ms: first ? 800 : 500 });
    await chosen;
    backend.setScreen(MAIN, { state: { kind: 'prompt' } });
    backend.update(MAIN, { attention: null });
    parent.startWorking();
    const worktree = `tc-1004-${child.slice(6, 8)}a${first ? '1' : '2'}`;
    backend.addSession(
      child,
      { title: name, cwd: `${ROOT}/.claude/worktrees/${worktree}`, parentId: MAIN, worktree: { name: worktree, branch: `worktree-${worktree}`, root: ROOT, preparing: null } },
      [{ type: 'user', id: `${child}:u`, text: prompt, parent: MAIN }],
    );
    backend.setStatusLine(child, statusLine(5, 10_000));
    parent.result(tool, {
      output: JSON.stringify({ session_id: child, name, folder: `${ROOT}/.claude/worktrees/${worktree}`, worktree: { name: worktree, branch: `worktree-${worktree}` }, permission_mode: 'acceptEdits', state: 'starting' }, null, 2),
    });
    story.claude(child).startWorking();
    await sleep(500);
  };
  d.caption('子セッションを始めるたびに、許可の確認が出ます。子も Claude の利用枠を使うためです', '.menu-card');
  await startChild(README_CHILD, true);
  await startChild(A11Y_CHILD, false);
  parent.stopWorking();
  parent.say('2 つの子セッションを始めました。終わったら結果をまとめます。');
  backend.push(MAIN, { type: 'turn-end' });
  backend.update(MAIN, { backgroundTasks: 1 });

  // 3. 子は親の下に並ぶ。一覧の印で、それぞれの状態が分かる
  d.caption('子セッションは、一覧で親の下に並びます。行の印で、作業中・回答待ち・バックグラウンドの完了待ちが分かります', '.session-list');
  const readme = story.claude(README_CHILD);
  const a11y = story.claude(A11Y_CHILD);
  await sleep(800);
  await readme.tool('Read', 'README.md', 700, { filePath: `${ROOT}/README.md` });
  readme.stopWorking();
  const answered = story.nextChoice();
  backend.setScreen(README_CHILD, { state: { kind: 'menu', menu: QUESTION_MENU } });
  backend.update(README_CHILD, { attention: 'question' });
  // アクセシビリティの子は、ワークフローを動かす
  const flow = new WorkflowPlayer(backend, A11Y_CHILD);
  a11y.say('観点ごとに並列で点検し、見つかった問題を直すワークフローを動かします。');
  backend.push(A11Y_CHILD, { type: 'tool-use', id: WORKFLOW_TOOL, name: 'Workflow', target: 'a11y-audit', input: 'a11y-audit', description: 'アクセシビリティを点検して直す', at: Date.now() });
  backend.setAgentLog(A11Y_CHILD, `${WORKFLOW_TOOL}:reader`, readerLog(1));
  flow.start('contrast');
  flow.start('reader');
  flow.start('keyboard');
  backend.push(A11Y_CHILD, { type: 'tool-result', id: WORKFLOW_TOOL, isError: false, output: 'ワークフロー a11y-audit をバックグラウンドで開始しました', at: Date.now() });
  a11y.stopWorking();
  backend.push(A11Y_CHILD, { type: 'turn-end' });
  await d.moveTo(d.byText('.session-row', 'README に価格'), { ms: 900 });
  await sleep(1800);

  // 4. 回答待ちの子を開いて答える。子のチャットには、親からの指示に見出しが付く
  d.caption('回答待ちの子を開いて答えます。子のチャットでは、親からの指示に「親セッションからの指示」の見出しが付きます', d.byText('.session-row', 'README に価格'));
  await d.click(d.byText('.session-row', 'README に価格'), { ms: 600 });
  await sleep(1200);
  await d.moveTo('.chat-from-parent', { ms: 800 });
  await sleep(1500);
  flow.tool('contrast', 'Read');
  flow.tool('reader', 'Read');
  await d.click(d.byText('.menu-option', ANSWER), { ms: 800 });
  await answered;
  backend.setScreen(README_CHILD, { state: { kind: 'prompt' } });
  backend.update(README_CHILD, { attention: null });
  readme.startWorking();
  const editReadme = readme.use('Edit', 'README.md', { filePath: `${ROOT}/README.md` });
  flow.finish('keyboard');
  await sleep(900);

  // 5. ワークフローを動かしている子を開き、フロー図を見る
  d.caption('ワークフローを動かしている子では、入力欄の上のトレイから、フロー図で段階ごとの進み具合を見られます', d.byText('.session-row', 'アクセシビリティ'));
  await d.click(d.byText('.session-row', 'アクセシビリティ'), { ms: 800 });
  await sleep(1000);
  await d.click(d.byText('.task-tray .task-row', 'a11y-audit'), { ms: 900 });
  flow.tool('reader', 'Grep');
  backend.setAgentLog(A11Y_CHILD, `${WORKFLOW_TOOL}:reader`, readerLog(3));
  await sleep(1200);
  flow.finish('contrast');
  readme.result(editReadme, { filePath: `${ROOT}/README.md`, added: 8, removed: 0 });
  readme.stopWorking();
  readme.say('README に「表示のルール」の節を足しました。');
  backend.push(README_CHILD, { type: 'turn-end' });
  backend.update(README_CHILD, { unread: true });
  await sleep(1000);
  backend.setAgentLog(A11Y_CHILD, `${WORKFLOW_TOOL}:reader`, readerLog(5));
  flow.finish('reader');
  flow.start('fix-card');
  flow.start('fix-css');
  await sleep(1200);
  flow.tool('fix-card', 'Edit');
  flow.tool('fix-css', 'Edit');
  await sleep(1000);
  flow.finish('fix-css');
  flow.finish('fix-card');
  flow.start('verify');
  await sleep(1200);
  flow.tool('verify', 'Bash');
  await sleep(900);
  flow.finish('verify');
  flow.complete();
  await sleep(800);

  // 6. 親に戻り、使い終わった開発サーバー（バックグラウンドの Bash）を止める
  d.caption('親に戻り、使い終わった開発サーバーを止めます。バックグラウンドの作業は、トレイの「止める」で止められます', '.task-tray .task-row .task-stop');
  await d.click(d.byText('.session-row', 'メニューに税込価格'), { ms: 900 });
  await sleep(900);
  const stopped = new Promise<void>((resolve) => {
    backend.onStopTask = () => resolve();
  });
  await d.click('.task-tray .task-row .task-stop', { ms: 900 });
  await stopped;
  await sleep(1200);
  backend.setBash(MAIN, [devTask('killed')]);
  backend.update(MAIN, { backgroundTasks: 0 });
  await sleep(1200);

  // 7. 子の作業が終わると、親に知らせが届き、親の Claude が結果をまとめる
  d.caption('子の作業が終わると、親に知らせが届き、親の Claude が続きを始めます', '.chat-notice');
  a11y.say('アクセシビリティの点検と修正が終わりました。コントラストと読み上げの 2 件を直しています。');
  backend.push(A11Y_CHILD, { type: 'turn-end' });
  backend.update(A11Y_CHILD, { unread: true });
  backend.push(MAIN, {
    type: 'notice',
    id: 'notice-children',
    text: `子セッション「${CHILDREN[README_CHILD].name}」（c0de0001）と「${CHILDREN[A11Y_CHILD].name}」（c0de0002）の作業が終わりました。get_session で確かめてください。`,
    sessions: [README_CHILD, A11Y_CHILD],
  });
  parent.startWorking();
  await sleep(800);
  await parent.tool('mcp__tanacode-sessions__get_session', README_CHILD, 600, { input: JSON.stringify({ session_id: README_CHILD }, null, 2) });
  await parent.tool('mcp__tanacode-sessions__get_session', A11Y_CHILD, 600, { input: JSON.stringify({ session_id: A11Y_CHILD }, null, 2) });
  parent.stopWorking();
  parent.say(
    [
      '子セッションの作業が終わりました。',
      '',
      '- **README に価格の表記を書く**: 「表示のルール」の節を新しく作りました',
      '- **アクセシビリティの点検**: 税抜の文字のコントラストと、価格の読み上げを直しました',
      '',
      'どちらも子セッションの worktree のブランチに入っています。',
    ].join('\n'),
  );
  backend.push(MAIN, { type: 'turn-end' });
  await sleep(1000);
  await d.moveTo('.chat-notice', { ms: 800 });
  await sleep(2500);
}
