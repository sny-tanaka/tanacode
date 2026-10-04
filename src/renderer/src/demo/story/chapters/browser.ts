import type { BrowserRect } from '@shared/ipc';
import { ROOT } from '../../data';
import { type Director, sleep } from '../../director';
import { demoWebview, refreshDemoWebviews } from '../../webview';
import { CSS_PRICE_STACKED } from '../files';
import { ADMIN_URL, DEV_URL, setLoggedIn } from '../page';
import { MAIN, type Story } from '../story';

// 章 4「ブラウザで確かめる」: 開発中のページをアプリ内ブラウザで開き、スマホの幅で崩れている要素を指さして直してもらう。
// 直したあとは Claude 自身がブラウザでページを確かめる（「Claude が操作中」の帯・押す要素の枠・スクリーンショット）。
// ログインは Claude にさせず、作業の途中で「あなたの番です」と頼まれる

const PROMPT = 'スマホだと税抜の表示が途中で折り返して読みにくいので、税抜は価格の下の行に出して';
const BROWSER = 'mcp__tanacode-browser__';

// ブラウザのページの中の要素へカーソルを動かす（ページには、動いた位置の出来事を送る）
async function moveInPage(d: Director, selector: string, ms = 700): Promise<{ x: number; y: number }> {
  const wv = demoWebview();
  const target = wv?.pageElement(selector);
  if (!wv || !target) throw new Error(`demo: ページの要素が見つかりません: ${selector}`);
  await d.moveToPoint(target.x, target.y, ms);
  wv.dispatchMouse('mousemove', target.x, target.y);
  return target;
}

// ページの中の要素の位置（Claude が押す要素の枠に使う。ページの見えている範囲の左上から）
function boxOf(selector: string): BrowserRect | null {
  const el = demoWebview()?.pageElement(selector)?.el;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

let shots = 0;

export async function runBrowser(story: Story): Promise<void> {
  const { backend, d } = story;
  const claude = story.claude();
  const id = MAIN;
  const activity = (label: string | null, box: BrowserRect | null = null, active = true) =>
    backend.browserActivity({ sessionId: id, active, label, box });
  // 今のページのスクリーンショットを撮って、ツールの結果に出せる画像にする
  const screenshot = async (): Promise<string> => {
    const image = await demoWebview()!.capturePage();
    const key = `/tmp/demo-screenshot-${++shots}.png`;
    backend.addImage(key, image.toDataURL());
    return key;
  };

  // 1. アクティビティバーの「ブラウザ」を開き、開発サーバーの URL を開く
  d.caption('アプリ内のブラウザで、開発中のページを開きます');
  await sleep(800);
  await d.click('.activity-bar [aria-label="ブラウザ"]', { ms: 900 });
  await sleep(700);
  await d.click('.preview-address input', { ms: 600 });
  await d.type('.preview-address input', DEV_URL, 70);
  await sleep(300);
  (document.querySelector('.preview-address') as HTMLFormElement).requestSubmit();
  await sleep(2000);

  // 2. 表示幅をスマホにすると、価格の行が折り返して崩れている
  d.caption('表示幅をスマホにすると、価格の行が途中で折り返して崩れています');
  await d.click('.preview-width', { ms: 700 });
  const select = document.querySelector('.preview-width') as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, '390');
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(1200);
  await moveInPage(d, '.menu-card:nth-child(1) .price', 900);
  await sleep(500);
  await moveInPage(d, '.menu-card:nth-child(2) .price', 500);
  await sleep(900);

  // 3. 「要素を選ぶ」で価格を選ぶ（入力欄にセレクタ・HTML と、切り出した画像が入る）
  d.caption('「要素を選ぶ」で崩れた要素をクリック。セレクタ・HTML・切り出した画像が、入力欄に入ります');
  await d.click('.preview-pane [aria-label="要素を選ぶ"]', { ms: 800 });
  await sleep(500);
  await moveInPage(d, '.menu-card:nth-child(2) .note', 600);
  await sleep(400);
  const price = await moveInPage(d, '.menu-card:nth-child(1) .price', 600);
  await sleep(900);
  d.press();
  demoWebview()!.dispatchMouse('click', price.x, price.y);
  await sleep(1400);

  // 4. 書き足して送る
  d.caption('直してほしいことを書き足して送ります');
  await story.send(PROMPT);
  claude.startWorking();

  // 5. Claude が CSS を直すと、開発サーバーの更新でブラウザの表示も直る
  await sleep(1300);
  await claude.tool('Read', 'src/styles.css', 700, { filePath: `${ROOT}/src/styles.css` });
  await claude.edit('src/styles.css', CSS_PRICE_STACKED, 1000, ['+  display: block;', '-  margin-left: 6px;']);
  refreshDemoWebviews();
  d.caption('Claude が CSS を直すと、ブラウザの表示もその場で直ります');
  await sleep(1500);

  // 6. Claude が自分でブラウザを使って確かめる（操作中の帯と、押す要素の枠）
  d.caption('直したあとは、Claude 自身がアプリ内ブラウザでページを開いて確かめます。操作中は「Claude が操作中」の帯が出ます');
  claude.say('直った見た目を、アプリ内ブラウザで確かめます。');
  activity('開く');
  const nav = claude.use(`${BROWSER}navigate`, `http://${DEV_URL}/`);
  backend.browserOpen(id, `http://${DEV_URL}/`);
  await sleep(1500);
  claude.result(nav, { output: `http://${DEV_URL}/ を開きました（Café Hinata）` });
  activity('スクリーンショット');
  const shot = claude.use(`${BROWSER}screenshot`, `http://${DEV_URL}/`);
  await sleep(900);
  claude.result(shot, { images: [await screenshot()], output: 'スクリーンショットを撮りました' });
  await sleep(600);
  d.caption('クリックの前には、押す要素に橙の枠が出ます');
  activity('クリック');
  const click = claude.use(`${BROWSER}click`, '.menu-card:nth-child(2) .price');
  await sleep(500);
  activity(null, boxOf('.menu-card:nth-child(2) .price'));
  await sleep(1400);
  activity(null);
  claude.result(click, { output: 'クリックしました' });
  await sleep(800);

  // 7. ログインは Claude にさせず、あなたに頼む（「あなたの番です」）
  d.caption('ログインなど Claude にさせない操作は、作業の途中であなたに頼みます');
  const admin = claude.use(`${BROWSER}navigate`, `http://${ADMIN_URL}`);
  backend.browserOpen(id, `http://${ADMIN_URL}`);
  await sleep(1300);
  claude.result(admin, { output: `http://${ADMIN_URL} を開きました（ログイン · Café Hinata）` });
  activity(null, null, false);
  const askTool = claude.use(`${BROWSER}ask_user_to_act`, '管理画面にログインしてください');
  const answered = new Promise<void>((resolve) => {
    backend.onBrowserAnswer = () => resolve();
  });
  backend.browserAsk(id, { id: 'ask-login', message: '管理画面で、税込価格の表示も確かめます。ログインしてから「終わった」を押してください。' });
  backend.update(id, { attention: 'browser' });
  await sleep(1800);
  d.caption('ログインが済んだら「終わった」を押すと、Claude が続きから再開します');
  await moveInPage(d, '.login input', 800);
  await sleep(700);
  await d.click(d.byText('.preview-ask button', '終わった'), { ms: 800 });
  await answered;
  setLoggedIn(true);
  backend.update(id, { attention: null });
  claude.result(askTool, { output: '終わった（http://localhost:5173/admin · 管理画面 · Café Hinata）' });
  refreshDemoWebviews();
  await sleep(800);
  activity('スクリーンショット');
  const adminShot = claude.use(`${BROWSER}screenshot`, `http://${ADMIN_URL}`);
  await sleep(900);
  claude.result(adminShot, { images: [await screenshot()], output: 'スクリーンショットを撮りました' });
  activity(null, null, false);

  // 8. 応答が届いて完了。畳んだ操作を開くと、スクリーンショットも見られる
  await sleep(600);
  claude.stopWorking();
  claude.say(
    [
      '税抜の表示を、価格の下の行に出すようにしました。',
      '',
      '- `.price small` を `display: block` にし、左の余白を外しました',
      '- スマホの 2 列でも、価格と税抜がそれぞれ 1 行に収まることを、ブラウザで確かめました',
      '- 管理画面の税込価格も、表示に合っています',
    ].join('\n'),
  );
  backend.push(id, { type: 'turn-end' });
  d.caption('Claude の操作は、チャットに「アプリ内ブラウザ」の操作として残り、スクリーンショットも見られます');
  await sleep(800);
  await d.click(() => [...document.querySelectorAll('.tool-group-head')].at(-1), { ms: 800 });
  await sleep(600);
  story.toBottom();
  await sleep(2800);
  await d.click(() => [...document.querySelectorAll('.tool-group-head')].at(-1), { ms: 600 });
  story.toBottom();
  await sleep(600);
}
