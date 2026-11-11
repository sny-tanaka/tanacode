import { randomUUID } from 'node:crypto';
import type { AuthInfo, WebContents } from 'electron';
import { isLocalUrl } from '@shared/browser-tools';
import type { BrowserLogin, BrowserLoginAnswer, BrowserLoginChange } from '@shared/ipc';

// アプリ内ブラウザのページが求めた HTTP の認証（Basic など。サーバーの 401・プロキシの 407）。人にだけ入力欄を出す。
// 流れ:
// 1. Electron の login が来たら、すぐに取り消す（ページには 401 の本文が出る）。そのタブに入力欄を出す（画面の帯。PreviewPane の LoginBar）
//    待たずに取り消すのは、読み込みを止めたままにしないため（Claude の navigate が、人が入れるまで返らなくなる。
//    最初の読み込みでは、画面がタブの webview を main に知らせる dom-ready も来ない）
// 2. 人が入れたら、その値を、求めたページ（タブか、そのタブから開いた別ウインドウ）に 1 回だけ使えるように控え、読み込み直す。
//    読み込み直したページの login が、同じ先（プロキシか・方式・ホスト・ポート・realm）なら、控えた値で答える。
//    通ったあとは、Chromium がセッションの中で覚えて、同じ先には自分で送る（Cookie と同じく、ログインを共有する）
// Claude には値を渡さない（ツールの引数でも受け取らない）。伝えるのは、認証を求められて人に入力欄を出したこと・人が入れたこと・断ったことだけ（notes）。
// 守り:
// - 入力欄は、タブごとに先に出したものだけ。出している間に、ページが別の先の認証を求めても、差し替えない
//   （人が入れている最中に、相手の先を入れ替えて、別のサイトへ送らせないように）
// - 控えた値は、求めた先と同じ先にだけ、1 回だけ、少しの間だけ使う。タブを閉じたら捨てる
// - タブ（か、求めた別ウインドウ）が別のページへ移り始めたら、入力欄を消す（前のページの認証なので）

// 人が入れてから、読み込み直したページの認証に使うまでの上限
const SAVED_TTL_MS = 60_000;
// 控えた値で答えたあと、同じ先にまた求められたら「通らなかった」と見なす間
const RETRY_WINDOW_MS = 30_000;
// 入力欄に出す realm の長さ（文字の数）と、人が入れる値の長さの上限
const MAX_REALM = 120;
const MAX_VALUE = 4096;

type Place = { sessionId: string; tabId: string };
// asker: 認証を求めたページ（タブか、タブから開いた別ウインドウ）/ root: 入力欄を出すタブ / place: タブの場所（画面がまだ知らせていなければ null）
type Entry = { login: BrowserLogin; key: string; asker: WebContents; root: WebContents; place: Place | null };
type Saved = { key: string; username: string; password: string; until: number };
type Outcome = { where: string; entered: boolean };
export type LoginRequest = { url: string; authInfo: AuthInfo };
type Callback = (username?: string, password?: string) => void;

export class BrowserLogins {
  // タブ → 出している入力欄
  private readonly pending = new Map<WebContents, Entry>();
  // 求めたページ → 人が入れた値（読み込み直したページの認証に 1 回だけ使う）
  private readonly saved = new Map<WebContents, Saved>();
  // 求めたページ → 控えた値で答えた先（また求められたら、通らなかった）
  private readonly tried = new Map<WebContents, { key: string; until: number }>();
  // タブ → 人が入れた・断った（Claude に 1 回だけ伝える）
  private readonly outcomes = new Map<WebContents, Outcome>();
  private readonly watched = new WeakSet<WebContents>();

  constructor(
    private readonly send: (change: BrowserLoginChange) => void,
    private readonly now: () => number = Date.now,
  ) {}

  // ページが認証を求めた（Electron の login。呼ぶ側が event.preventDefault() したもの）。callback はかならず、すぐに呼ぶ
  request(asker: WebContents, root: WebContents, place: Place | null, { url, authInfo }: LoginRequest, callback: Callback): void {
    const key = keyOf(authInfo);
    const now = this.now();
    const saved = this.saved.get(asker);
    this.saved.delete(asker);
    if (saved && saved.until > now && saved.key === key) {
      this.tried.set(asker, { key, until: now + RETRY_WINDOW_MS });
      callback(saved.username, saved.password);
      return;
    }
    callback();
    if (asker.isDestroyed() || root.isDestroyed() || this.pending.has(root)) return;
    const tried = this.tried.get(asker);
    this.tried.delete(asker);
    const login: BrowserLogin = {
      id: randomUUID(),
      origin: whereOf(url, authInfo),
      realm: cleanRealm(authInfo.realm ?? ''),
      proxy: authInfo.isProxy,
      insecure: !authInfo.isProxy && isInsecure(url),
      retry: !!tried && tried.key === key && tried.until > now,
      popup: asker !== root,
    };
    this.watch(asker, root);
    this.watch(root, root);
    this.outcomes.delete(root);
    this.pending.set(root, { login, key, asker, root, place });
    if (place) this.send({ ...place, login });
  }

  // 画面がタブの webview を知らせた（BrowserControl.attach）。知らせる前に求められていた入力欄を、そのタブに出す
  place(root: WebContents, place: Place): void {
    const entry = this.pending.get(root);
    if (!entry || (entry.place?.sessionId === place.sessionId && entry.place.tabId === place.tabId)) return;
    if (entry.place) this.send({ ...entry.place, login: null });
    entry.place = place;
    this.send({ ...place, login: entry.login });
  }

  // 今出している入力欄（画面を作り直したとき用）
  list(): BrowserLoginChange[] {
    return [...this.pending.values()].flatMap((e) => (e.place ? [{ ...e.place, login: e.login }] : []));
  }

  // 人が入れた・キャンセルした。今出している入力欄への返事でなければ（もう消えた・前のもの）、何もしない
  answer(sessionId: string, loginId: unknown, answer: unknown): void {
    const entry = [...this.pending.values()].find((e) => e.login.id === loginId && e.place?.sessionId === sessionId);
    const parsed = parseAnswer(answer);
    if (!entry || parsed === undefined) return;
    this.close(entry);
    this.outcomes.set(entry.root, { where: describe(entry.login), entered: !!parsed });
    if (!parsed || entry.asker.isDestroyed()) return;
    const saved: Saved = { key: entry.key, ...parsed, until: this.now() + SAVED_TTL_MS };
    this.saved.set(entry.asker, saved);
    // 使われなかった値も、上限を過ぎたら捨てる（パスワードを持ち続けない）
    const asker = entry.asker;
    setTimeout(() => {
      if (this.saved.get(asker) === saved) this.saved.delete(asker);
    }, SAVED_TTL_MS).unref?.();
    asker.reload();
  }

  // Claude に伝えること（英語。タブの操作の結果に添える）。出している入力欄と、人が入れた・断ったこと（1 回だけ）
  notes(root: WebContents): string[] {
    const entry = this.pending.get(root);
    if (entry) {
      const page = entry.login.popup ? 'A popup window opened from this tab' : 'This page';
      return [
        `${page} asked for HTTP authentication (${describe(entry.login)}). tanacode shows the user a sign-in form for it above the page; you can neither see nor fill it in. ` +
          'Do not ask the user for the user name or password in the chat. To go on, ask the user to sign in with that form using ask_user_to_act.',
      ];
    }
    const outcome = this.outcomes.get(root);
    if (!outcome) return [];
    this.outcomes.delete(root);
    return [
      outcome.entered
        ? `The user entered credentials for the HTTP authentication (${outcome.where}) in tanacode's sign-in form, and tanacode reloaded the page.`
        : `The user closed tanacode's sign-in form for the HTTP authentication (${outcome.where}) without signing in.`,
    ];
  }

  // セッションを消した・アーカイブした
  forget(sessionId: string): void {
    for (const entry of [...this.pending.values()]) if (entry.place?.sessionId === sessionId) this.drop(entry.root);
  }

  // 入力欄を消す
  private close(entry: Entry): void {
    if (this.pending.get(entry.root) !== entry) return;
    this.pending.delete(entry.root);
    if (entry.place) this.send({ ...entry.place, login: null });
  }

  // contents（タブか、求めた別ウインドウ）が別のページへ移り始めた・閉じたら、root のタブの入力欄を消す。閉じたら、控えも捨てる
  private watch(contents: WebContents, root: WebContents): void {
    if (this.watched.has(contents)) return;
    this.watched.add(contents);
    contents.on('did-start-navigation', (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      const entry = this.pending.get(root);
      if (entry && (entry.asker === contents || entry.root === contents)) this.close(entry);
    });
    contents.once('destroyed', () => {
      this.saved.delete(contents);
      this.tried.delete(contents);
      const entry = this.pending.get(root);
      if (entry && (entry.asker === contents || entry.root === contents)) this.close(entry);
      if (contents === root) this.drop(root);
    });
  }

  private drop(root: WebContents): void {
    const entry = this.pending.get(root);
    if (entry) {
      this.close(entry);
      this.saved.delete(entry.asker);
      this.tried.delete(entry.asker);
    }
    this.saved.delete(root);
    this.tried.delete(root);
    this.outcomes.delete(root);
  }
}

// 控えた値を使ってよい先か見分ける印（プロキシか・方式・ホスト・ポート・realm が同じ）
function keyOf(info: AuthInfo): string {
  return JSON.stringify([info.isProxy, info.scheme.toLowerCase(), info.host.toLowerCase(), info.port, info.realm ?? '']);
}

// 入力欄に出す、認証を求めた先。サーバーはページのオリジン（国際化ドメインは xn-- のまま。似た字のドメインで欺かせない）、プロキシは host:port
function whereOf(url: string, info: AuthInfo): string {
  if (info.isProxy) return `${info.host}:${info.port}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  } catch {
    // 読めない URL は、認証の先の host:port で出す
  }
  return `${info.host}:${info.port}`;
}

// Claude に伝える先（realm はサイトが自由に書けるので、Claude には渡さない）
function describe(login: BrowserLogin): string {
  return login.proxy ? `the proxy ${login.origin}` : login.origin;
}

// 暗号化されていない通信で送るか（この Mac の外の http）。Basic 認証の値は、そのまま読める形で送られる
function isInsecure(url: string): boolean {
  return /^http:/i.test(url) && !isLocalUrl(url);
}

// realm の、入力欄に出す形。空白は 1 つに詰め、制御文字と書式の文字（並びを入れ替える双方向の制御文字など）を除き、長さを切る
function cleanRealm(realm: string): string {
  const cleaned = realm
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > MAX_REALM ? `${chars.slice(0, MAX_REALM).join('')}…` : cleaned;
}

// 画面からの返事。null: キャンセル / 値: 入れたもの / undefined: 形が違う（何もしない）
function parseAnswer(answer: unknown): BrowserLoginAnswer | undefined {
  if (answer === null) return null;
  if (!answer || typeof answer !== 'object') return undefined;
  const { username, password } = answer as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > MAX_VALUE || password.length > MAX_VALUE) return undefined;
  return { username, password };
}
