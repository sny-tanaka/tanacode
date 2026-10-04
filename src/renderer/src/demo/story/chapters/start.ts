import { ROOT } from '../../data';
import { sleep } from '../../director';
import { statusLine } from '../../scenarios/claude';
import { MAIN, MAIN_CWD, type Story, WORKTREE } from '../story';

// 章 1「セッションを始める」: 新規セッションの画面で、フォルダ・モデル・権限モードを選び、worktree に分けて始める。
// worktree の準備（node_modules の複製）が終わるまで、最初の指示は預かっておき、終わったら送る

export const FIRST_PROMPT = 'メニューの価格を税込みでも表示して。税率は 10%、1 円未満は切り捨てで。';

export async function runStart(story: Story): Promise<void> {
  const { backend, d } = story;

  // 1. 「新規セッション」を押す
  d.caption('「新規セッション」から、作業を始めます');
  await sleep(900);
  await d.click('nav.sidebar .new-session-button', { ms: 900 });
  await sleep(900);

  // 2. フォルダを選ぶ
  d.caption('作業するフォルダを、最近のフォルダから選びます');
  await d.click('.new-session-chips .folder-picker > button.new-session-chip');
  await sleep(700);
  await d.click(`.folder-menu-item[title="${ROOT}"]`, { ms: 600 });
  await sleep(800);

  // 3. モデルと権限モードを選ぶ（このセッションだけに効く）
  d.caption('モデル・エフォート・権限モードは、このセッションだけに効きます。Claude Code の既定値は変わりません');
  await story.choose('.chat-options select[title^="モデル"]', 'opus');
  await story.choose('.chat-options select[title^="権限モード"]', 'acceptEdits');

  // 4. worktree に分けて始める
  d.caption('「worktree を使う」で、このセッション専用の作業フォルダとブランチに分けます。並行するほかの作業とぶつかりません');
  await d.click('.new-session-check input[type="checkbox"]', { ms: 700 });
  await sleep(900);

  // 5. 最初の指示を送ると、セッションが始まる（worktree の準備の間は、指示を預かっておく）
  backend.onCreate = (_cwd, options) => {
    backend.project.branch = WORKTREE.branch;
    backend.addSession(
      MAIN,
      { title: null, cwd: MAIN_CWD, model: options.model, worktree: { ...WORKTREE, preparing: 'creating' } },
      [],
      { ready: false },
    );
    // 選んだ権限モードは、始めたセッションの入力欄の下にも出る
    backend.setScreen(MAIN, { mode: options.mode ?? 'manual' });
    return MAIN;
  };
  d.caption('最初の指示を送ります');
  const sent = story.nextSend();
  await d.click('.chat-input textarea');
  await d.type('.chat-input textarea', FIRST_PROMPT);
  await sleep(300);
  await d.click('.chat-input-row [aria-label="送信"]');
  await sleep(1200);

  d.caption('worktree を作り、node_modules を元のフォルダから複製します。準備が終わるまで、最初の指示は預かっておきます');
  backend.update(MAIN, { worktree: { ...WORKTREE, preparing: 'copying' } });
  await sleep(2600);
  backend.update(MAIN, { worktree: { ...WORKTREE, preparing: null }, title: 'メニューに税込価格を出す' });
  backend.push(MAIN, {
    type: 'info',
    id: 'worktree-info',
    text: `worktree .claude/worktrees/${WORKTREE.name}（ブランチ ${WORKTREE.branch}）で始めました。node_modules を元のフォルダから複製しました`,
  });
  backend.push(MAIN, { type: 'ready' });
  backend.setStatusLine(MAIN, statusLine(6, 12_000));
  await sent;
  story.claude().startWorking();

  // 6. 一覧の行の枝分かれの印
  d.caption('一覧の行には、元のフォルダと worktree の名前が、枝分かれの印を挟んで並びます');
  await sleep(600);
  await d.moveTo('.session-row .session-worktree', { ms: 900 });
  await sleep(2200);
}
