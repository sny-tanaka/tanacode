import { isLocalUrl } from '@shared/browser-tools';

// アプリ内ブラウザのログイン欄に、1Password のアイテムのユーザー名・パスワードを入れる（fill_credential）。
// Claude が渡すのは 1Password のアイテムのリンク（「プライベートリンクをコピー」）と、入れる欄の selector だけ。値を取り出すのはメインプロセスで、
// 取り出し役（CredentialSource）を差し替えられる。使うのは sdkSource（1Password の JavaScript SDK のデスクトップアプリ連携。
// ユーザーに足すセットアップは、1Password の設定 → 開発者 →「1Password SDKs と連携」をオンにすることだけ。1Password アプリが承認を求める）。
// 1Password CLI（op）は使わない（op を入れるセットアップを増やしたくない、というユーザーの判断）
// - 値は Claude に返さない。エラー文・ログにも出さない
// - アイテムに登録された URL と、今のページのオリジンが合うときだけ入れる（ページに書かれたリンクで、別のサイトの値を入れさせない）
// - 入れる前に tanacode からは確かめない（リンクを渡した・控えた時点で、人はそのアイテムを使うことを許している、というユーザーの判断）。
//   人の承認は、1Password アプリが出すもの（使わずに 10 分たつと切れる）だけ
// - 入れたあとは、そのページで JavaScript の実行（evaluate）を断り、パスワードの欄が文字のまま見える形に変えられていたら、読むツールを断る
//   （CredentialGuard。ページを移るまで）

// アイテムの参照（リンクの a・v・i。アカウント・保管庫・アイテムの ID）
export type ItemRef = { account: string; vault: string; item: string };

// 取り出したログイン。username・password は、アイテムにその欄が無ければ null
export type Login = { title: string; urls: string[]; username: string | null; password: string | null };

// 取り出し役。参照からログインの値を読む。失敗は CredentialError（Claude に返す英語の文。値を入れない）
export type CredentialSource = { read: (ref: ItemRef) => Promise<Login> };

export class CredentialError extends Error {}

const ID = /^[a-z0-9]{26}$/i;

// Claude が渡したリンクを読む（1Password の「プライベートリンクをコピー」: https://start.1password.com/open/i?a=<アカウント>&v=<保管庫>&i=<アイテム>&h=<サインインの先>）
export function parseItemRef(input: string): ItemRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CredentialError('Pass a 1Password item link (in 1Password, "Copy Private Link" on the item: https://start.1password.com/open/i?...).');
  }
  if (url.protocol !== 'https:' || !/(^|\.)1password\.(com|ca|eu)$/.test(url.hostname) || url.pathname !== '/open/i') {
    throw new CredentialError('The link is not a 1Password item link (expected https://start.1password.com/open/i?a=...&v=...&i=...).');
  }
  const account = url.searchParams.get('a') ?? '';
  const vault = url.searchParams.get('v') ?? '';
  const item = url.searchParams.get('i') ?? '';
  if (![account, vault, item].every((id) => ID.test(id))) throw new CredentialError('The 1Password item link is missing the account, vault or item ID, or they are malformed.');
  return { account, vault, item };
}

// ---- 1Password SDK（デスクトップアプリ連携） ----
// SDK の型のうち、使うものだけ（SDK を読み込まなくても型を書けるように。SDK 0.5.0 の dist/types.d.ts・client_builder.d.ts に合わせた）
export type SdkItem = {
  title: string;
  category: string;
  websites: { url: string }[];
  fields: { id: string; fieldType: string; value: string; sectionId?: string }[];
};
export type SdkClient = { items: { get: (vaultId: string, itemId: string) => Promise<SdkItem> } };
export type SdkModule = {
  createClient: (config: { auth: unknown; integrationName: string; integrationVersion: string }) => Promise<SdkClient>;
  DesktopAuth: new (accountName: string) => unknown;
};

const SDK_SETUP_HINT = 'Ask the user to open and unlock the 1Password app, and turn on "Integrate with 1Password SDKs" in its Settings > Developer.';

// SDK の失敗を、Claude に返す文にする。SDK のエラー文は値を含まない（アイテムの値は成功したときの答えにだけ入る）。
// どの文で失敗するかは、本物の 1Password で確かめていない（文書にも無い）ので、当たらなければ 1 行目を添える
export function sdkFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lower = text.toLowerCase();
  if (/desktop application not found|native library is not available/.test(lower)) {
    return 'Could not reach the 1Password app: it is not installed in /Applications, or tanacode could not load its integration library. Ask the user to install the 1Password app for Mac.';
  }
  if (/denied|declined|dismiss|cancel|reject/.test(lower)) return 'The user did not approve the 1Password prompt, so nothing was filled. Do not retry unless the user asks.';
  if (/not enabled|integration.*(off|disabled)|sdk.*disabled|connection refused|could not connect|failed to connect/.test(lower)) return `Could not connect to the 1Password app. ${SDK_SETUP_HINT}`;
  if (/locked/.test(lower)) return 'The 1Password app is locked. Ask the user to unlock it, then try again.';
  if (/account/.test(lower) && /not found|no account|unknown/.test(lower)) return 'The 1Password account in the link was not found in the 1Password app (the user may not be signed in to that account there).';
  if (/not found|no item|invalid.*id/.test(lower)) return 'The 1Password item was not found (check the link, or ask the user for the right item).';
  const first = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return `1Password could not read the item${first ? `: ${first.slice(0, 200)}` : '.'}`;
}

// SDK のアイテムから、ログインの値を取り出す。ユーザー名とパスワードは、組み込みの欄（ID が username・password で、セクションに入っていないもの）
export function loginFromSdkItem(item: SdkItem): Login {
  const field = (id: string) => {
    const found = item.fields.find((f) => f.id === id && !f.sectionId && f.value !== '');
    return found ? found.value : null;
  };
  return { title: item.title || '(untitled)', urls: item.websites.map((w) => w.url).filter((u) => u !== ''), username: field('username'), password: field('password') };
}

// SDK を使う取り出し役。load: SDK を読み込む（初めて使うときに読み込む。SDK は読み込むときに 14MB の WebAssembly をコンパイルするので、
// アプリの起動では読み込まない）。version: 1Password の承認のダイアログ・連携の一覧に出す tanacode のバージョン。
// クライアントはアカウントごとに使い回す（1Password の承認はプロセスとアカウントごと。使わずに 10 分たつと切れる。切れたら作り直して 1 回だけやり直す）
export function sdkSource(load: () => Promise<SdkModule>, version: string): CredentialSource {
  const clients = new Map<string, Promise<SdkClient>>();
  const client = async (account: string): Promise<SdkClient> => {
    let made = clients.get(account);
    if (!made) {
      made = load().then((sdk) => sdk.createClient({ auth: new sdk.DesktopAuth(account), integrationName: 'tanacode', integrationVersion: version }));
      clients.set(account, made);
      // 作れなかったら忘れる（次はまた作る）
      made.catch(() => clients.delete(account));
    }
    return made;
  };
  const get = async (ref: ItemRef, retry: boolean): Promise<SdkItem> => {
    try {
      return await (await client(ref.account)).items.get(ref.vault, ref.item);
    } catch (error) {
      if (retry && error instanceof Error && error.name === 'DesktopSessionExpiredError') {
        clients.delete(ref.account);
        return get(ref, false);
      }
      throw error;
    }
  };
  return {
    read: async (ref) => {
      try {
        return loginFromSdkItem(await get(ref, true));
      } catch (error) {
        throw new CredentialError(sdkFailure(error));
      }
    },
  };
}

// アイテムの URL のうち、今のページに合うもの（無ければ null）。
// ホストが同じか、ページがその下のサブドメイン（example.com のアイテムは login.example.com にも入れる。1Password の拡張と同じ考え）。
// アイテムの URL にポートがあれば、ポートも合わせる。ページは https に限る（localhost と、アイテムの URL が http のものは http も可）
export function matchingUrl(pageUrl: string, itemUrls: readonly string[]): string | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return null;
  for (const raw of itemUrls) {
    let item: URL;
    try {
      item = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      continue;
    }
    if (item.protocol !== 'https:' && item.protocol !== 'http:') continue;
    const host = item.hostname.toLowerCase();
    const pageHost = page.hostname.toLowerCase();
    // 「com」のような、ドットの無いホスト（localhost を除く）には、サブドメインで合わせない
    const sub = host.includes('.') && pageHost.endsWith(`.${host}`);
    if (pageHost !== host && !sub) continue;
    if (item.port && item.port !== page.port) continue;
    if (page.protocol === 'http:' && !isLocalUrl(pageUrl) && !(item.protocol === 'http:' && pageHost === host)) continue;
    return raw;
  }
  return null;
}

// 入れる欄。selector を省くと、ページの中で見つける（見えているパスワードの欄と、その前の入力欄）
export type FillTarget = { usernameSelector?: string; passwordSelector?: string; username: string | null; password: string | null };

// 目印（作り物のテストがスクリプトの種類を見分ける。test/helpers/fake-electron.ts）
export const FILL_MARK = '__tanacodeCredentialFill';
export const CHECK_MARK = '__tanacodeCredentialCheck';

// 欄を見つけて値を入れるスクリプト（ページとは別の JavaScript の世界で動かす。ページのスクリプトには、この中の変数は見えない）。
// 値は、ページの中では欄に入れるだけで、結果には返さない（返すのは、入れた欄の名前か、入れられなかった理由）。
// いちばん外の文書の欄だけに入れる（iframe の中は、オリジンを確かめられないので入れない）。
// React などが値の変化に気づくよう、input と change を送る。入れた欄は、この世界の変数に控える（CHECK_SCRIPT が見る）
export function fillScript(target: FillTarget): string {
  const values = JSON.stringify({ u: target.username, p: target.password });
  const selectors = JSON.stringify({ u: target.usernameSelector ?? null, p: target.passwordSelector ?? null });
  return `(() => {
  const ${FILL_MARK} = true;
  const values = ${values};
  const sel = ${selectors};
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.name ? '[name="' + e.name + '"]' : '');
  const pick = (s) => { try { return document.querySelector(s); } catch (e) { return { error: 'bad selector: ' + s }; } };
  let pass = null, user = null;
  if (values.p !== null || sel.p) {
    pass = sel.p ? pick(sel.p) : [...document.querySelectorAll('input[type=password]')].find(shown) || null;
    if (pass && pass.error) return { error: pass.error };
    if (!pass) return { error: sel.p ? 'no element matches ' + sel.p : 'no visible password field on the page' };
    if (pass.tagName !== 'INPUT' || pass.type !== 'password') return { error: name(pass) + ' is not a password field (<input type=password>)' };
  }
  if (sel.u) {
    user = pick(sel.u);
    if (user && user.error) return { error: user.error };
    if (!user) return { error: 'no element matches ' + sel.u };
  } else if (values.u !== null) {
    const scope = (pass && pass.form) || document;
    const inputs = [...scope.querySelectorAll('input')].filter((el) => shown(el) && /^(text|email|tel|)$/.test(el.getAttribute('type') || ''));
    user = inputs.find((el) => /username|email/.test(el.autocomplete || '')) ||
      (pass ? inputs.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).pop() : inputs[0]) || null;
  }
  if (user && (user.tagName !== 'INPUT' || user.type === 'password' || user.type === 'hidden')) return { error: name(user) + ' is not a text field for the username' };
  for (const el of [user, pass]) if (el && el.disabled) return { error: name(el) + ' is disabled' };
  const put = (el, value) => {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const filled = [];
  if (user && values.u !== null) { put(user, values.u); filled.push({ field: 'username', element: name(user) }); }
  if (pass && values.p !== null) { put(pass, values.p); filled.push({ field: 'password', element: name(pass) }); }
  if (pass) pass.blur();
  window.__tanacodeFilled = [...(window.__tanacodeFilled || []).filter((el) => el.isConnected), ...(pass && values.p !== null ? [pass] : [])];
  return { filled };
})()`;
}

// 入れたパスワードの欄が、文字のまま見える形（type が password でない）に変えられて、値が残っているか
export const CHECK_SCRIPT = `(() => {
  const ${CHECK_MARK} = true;
  return (window.__tanacodeFilled || []).some((el) => el.isConnected && el.type !== 'password' && el.value !== '');
})()`;

// 見えているパスワード欄があるか（ask_user_to_act の帯に 1Password の案内を添えるかを決める。値は読まない）
export const HAS_PASSWORD_MARK = '__tanacodeHasPassword';
export const HAS_PASSWORD_SCRIPT = `(() => {
  const ${HAS_PASSWORD_MARK} = true;
  return [...document.querySelectorAll('input[type=password]')].some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
})()`;

// 頼みごとがログインに見えるか。頼みの文にログインの語があるか、今のページに見えているパスワード欄があるとき（控えめに: 二段階認証・決済だけの頼みは含めない）
const LOGIN_WORDS = /\b(log ?in|sign ?in|password|credentials?)\b|ログイン|サインイン|パスワード/i;
export async function looksLikeLoginRequest(message: string, passwordField: () => Promise<boolean>): Promise<boolean> {
  if (LOGIN_WORDS.test(message)) return true;
  return passwordField();
}

export type FillResult = { filled: { field: string; element: string }[] } | { error: string };

// 入れたページを控え、Claude の読み取りを止める。ページ（webContents）ごと。トップのフレームが別の文書へ移ったら忘れる
export class CredentialGuard {
  private readonly filled = new Map<number, string>();
  private readonly watched = new WeakSet<object>();

  // 入れた。url: 入れたときのページ
  mark(contents: Pick<Electron.WebContents, 'id' | 'on' | 'once'>, url: string): void {
    this.filled.set(contents.id, url);
    if (this.watched.has(contents)) return;
    this.watched.add(contents);
    const id = contents.id;
    contents.on('did-start-navigation', (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (event.isMainFrame && !event.isSameDocument) this.filled.delete(id);
    });
    contents.once('destroyed', () => this.filled.delete(id));
  }

  // ツールを断る理由（断らなければ null）。check: パスワードの欄が見える形に変えられたかをページで確かめる
  async refusal(tool: string, contentsId: number, check: () => Promise<boolean>): Promise<string | null> {
    if (!this.filled.has(contentsId)) return null;
    if (tool === 'evaluate') {
      return 'evaluate is not available on this page because a credential from 1Password was filled into it (so that the values cannot be read). It becomes available again after the page navigates (for example, after the form is submitted) or is reloaded.';
    }
    if (!['screenshot', 'get_text', 'get_accessibility_tree', 'inspect', 'wait_for'].includes(tool)) return null;
    const exposed = await check().catch(() => true);
    return exposed
      ? `${tool} is not available on this page because the password filled from 1Password is now shown as plain text (the field is no longer a password field). Submit the form or reload the page first.`
      : null;
  }
}
