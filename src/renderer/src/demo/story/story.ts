import { REPO_URL } from '@shared/app-update';
import type { ChatEvent } from '@shared/chat';
import { DemoBackend } from '../backend';
import { cafeProject, DEMO_CATALOG, demoUsage, ROOT } from '../data';
import { type Director, sleep } from '../director';
import { Claude, pastTurn, statusLine } from '../scenarios/claude';
import { installDemoWebview } from '../webview';
import { DISCOVERED } from './chapters/app';
import { TRANSLATIONS } from './chapters/wrapup';
import { cafePage } from './page';

// デモのサイトのツアー（1 本）の、章をまたいで持つ状態と、章の台本が使う手助け。
// ツアーは、カフェのメニューのサイト（data.ts の cafeProject）に機能を足していくひとつのセッションを、始めから終わりまで追う

// 章 1 で始めるセッション（ツアーの主役）
export const MAIN = 'demo-main';
// そのセッションの worktree
export const WORKTREE = { name: 'tc-1004-k3x9', branch: 'worktree-tc-1004-k3x9', root: ROOT };
export const MAIN_CWD = `${ROOT}/.claude/worktrees/${WORKTREE.name}`;
// 前からあるセッション（一覧を賑やかにする。ツアーを流さずに触るときは、これを開いておく）
const README_SESSION = 'demo-readme';
const IMAGES_SESSION = 'demo-images';

export type Sent = { sessionId: string; text: string; images: string[] };

export class Story {
  d!: Director;
  private readonly claudes = new Map<string, Claude>();
  // 書き出した HTML を開いて見せる・閉じる（デモのサイトでは、親のページが重ねて見せる。紹介画像では何もしない）
  showExport: (html: string) => void = () => {};
  hideExport: () => void = () => {};
  // 台本の目印の場面に来た（紹介画像は、目印 'showcase' の場面で止めて撮る。デモのサイトでは何もしない）
  mark: (name: string) => Promise<void> = async () => {};

  constructor(readonly backend: DemoBackend) {}

  // セッションごとの作り物の Claude（出来事の ID が重ならないよう、セッションごとに分ける）
  claude(id = MAIN): Claude {
    let c = this.claudes.get(id);
    if (!c) {
      c = new Claude(this.backend, id, `${id}:`);
      this.claudes.set(id, c);
    }
    return c;
  }

  // 次に送られる発言を待つ。届いた発言は、そのセッションの会話に足す
  nextSend(): Promise<Sent> {
    return new Promise((resolve) => {
      this.backend.onUserMessage = (sessionId, text, images) => {
        this.backend.push(sessionId, { type: 'user', id: this.claude(sessionId).next('u'), text, images } satisfies ChatEvent);
        resolve({ sessionId, text, images });
      };
    });
  }

  // チャットの入力欄に打って送り、届くのを待つ
  async send(text: string): Promise<Sent> {
    const sent = this.nextSend();
    await this.d.click('.chat-input textarea');
    await this.d.type('.chat-input textarea', text);
    await sleep(300);
    await this.d.click('.chat-input-row [aria-label="送信"]');
    return sent;
  }

  // 次に選ばれる選択肢（質問・許可の確認）を待つ
  nextChoice(): Promise<void> {
    return new Promise((resolve) => {
      this.backend.onChoose = () => resolve();
    });
  }

  // エクスプローラーのフォルダを開く（開いていれば何もしない。押すと閉じてしまうので）
  async expand(path: string, ms = 600): Promise<void> {
    const row = await this.d.find(`.tree-row[title="${path}"]`);
    if (row.querySelector('.disclosure.open')) return;
    await this.d.click(row, { ms });
    await sleep(250);
  }

  // 選択欄で選ぶ（カーソルを乗せてから、値を差し替えて change の出来事を起こす）
  async choose(selector: string, value: string): Promise<void> {
    const el = (await this.d.find(selector)) as HTMLSelectElement;
    await this.d.moveTo(el, { ms: 600 });
    await sleep(300);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);
  }

  // チャットを末尾まで送る（開いたカードが見えるように）
  toBottom(): void {
    const list = document.querySelector('.claude .chat-list');
    list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }

  // ツアーを流さずに触るとき。前からあるセッションを開いておく
  showStart(): void {
    this.backend.select(README_SESSION);
  }
}

// ツアーの作り物の API を用意して、window.tanacode を差し替える（アプリの最初の描画より先に呼ぶ）
export function prepareStory(): Story {
  // 列の幅を決める（アプリは列の幅を localStorage から読む）。前に開いたファイルなど、アプリが保存した状態は持ち越さない
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('tanacode.')) localStorage.removeItem(key);
    localStorage.setItem('tanacode.columns', JSON.stringify({ sessions: 270, claude: 580, side: 290 }));
  } catch {
    // 保存できなくても既定の幅で動く
  }
  const backend = new DemoBackend(cafeProject(), demoUsage(), DEMO_CATALOG);
  const hour = 3600_000;
  backend.addSession(
    README_SESSION,
    { title: 'README のセットアップ手順を見直す', updatedAt: Date.now() - 5 * hour },
    pastTurn('rd', 'README のセットアップ手順を、今の package.json に合わせて見直して', [['Read', 'package.json', 500], ['Edit', 'README.md', 800]], 'README の手順を `npm install` → `npm run dev` の順に直しました。', 5 * hour),
  );
  backend.addSession(
    IMAGES_SESSION,
    { title: 'メニュー画像の置き場所を決める', updatedAt: Date.now() - 26 * hour },
    pastTurn('img', 'メニューに画像を出したい。どこに置くのがいい？', [['Read', 'src/components/MenuCard.tsx', 600]], '`public/menu/` に置き、`MenuCard` で品目の ID から読み込むのがよいと思います。', 26 * hour),
  );
  backend.setStatusLine(README_SESSION, statusLine(6, 12_000));
  backend.setStatusLine(IMAGES_SESSION, statusLine(4, 8_000));
  installDemoWebview((url) => cafePage(backend, url));
  // 翻訳のボタンを出すかは、アプリが最初に 1 回だけ聞くので、始めから訳せるようにしておく（日本語の応答には出ない）
  backend.translations = TRANSLATIONS;
  // tanacode は最新バージョン（章 8 で新しいバージョンが出る）。「既存の会話を開く…」には、ターミナルで始めた会話を並べておく
  backend.setAppUpdate({ latest: __APP_VERSION__, available: false, url: `${REPO_URL}/releases/latest` });
  backend.discovered = DISCOVERED;
  window.tanacode = backend.api();
  return new Story(backend);
}
