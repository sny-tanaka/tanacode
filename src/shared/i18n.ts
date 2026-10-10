import type en from './locales/en.json';
import type ja from './locales/ja.json';
// 文言は文字列のまま入れておき、使う言語の分だけ、はじめて使うときに読む（1 つの言語で使い続けるなら、もう 1 つは読まない）
import enSource from './locales/en.json?raw';
import jaSource from './locales/ja.json?raw';

// 画面の文言。文言は言語ごとの JSON（src/shared/locales/ja.json・en.json）に置き、コードでは t('sidebar.newSession') のようにキーで読む。
// main と画面（renderer）で、それぞれのプロセスが今の言語を持つ。言語は起動するときに決めて、終わるまで変えない
// （設定を変えたら、再起動で反映する）。既定は日本語（テストもこのまま日本語で動く）

export type Language = 'ja' | 'en';
// 設定で選べるもの。system は Mac の言語の設定に合わせる
export type LanguageSetting = Language | 'system';
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['system', 'ja', 'en'];

type Messages = typeof ja;
type Tree = { [key: string]: string | Tree };

// JSON の入れ子を「.」でつないだキー（例: 'sidebar.newSession'）。無いキーを書くと型チェックで止まる
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Messages>;

// en.json に足りないキーがあれば、型チェックで止める（足りないキーがエラーに並ぶ。型だけで、動くコードは無い）。
// 余分なキーと埋め込みの違いは test/i18n.test.ts で確かめる
type Complete<Missing extends never> = Missing;
export type EnglishComplete = Complete<Exclude<MessageKey, Leaves<typeof en>>>;

// 文言に埋め込む値（文言の中の {name} を置き換える）
export type Params = Record<string, string | number>;

const SOURCES: Record<Language, string> = { ja: jaSource, en: enSource };
// 読んだ言語の文言
const trees: Partial<Record<Language, Tree>> = {};
// 言語ごとの、使ったキー → 文言（無ければ null）。入れ子をたどるのは、そのキーをはじめて使うときだけ
const found: Record<Language, Map<string, string | null>> = { ja: new Map(), en: new Map() };
// 埋め込みのある文言を、文字と名前に分けたもの（[文字, 名前, 文字, …, 文字]）。文言ごとに、はじめて埋め込むときに分ける
const templates = new Map<string, string[]>();

let current: Language = 'ja';

export function language(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  current = lang;
}

export function isLanguage(value: unknown): value is Language {
  return value === 'ja' || value === 'en';
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === 'system' || isLanguage(value);
}

// 設定から、使う言語を決める。system なら、Mac の優先する言語（例: ['en-US', 'ja-JP']）に日本語があれば日本語、無ければ英語。
// 日本語が 2 番目以降でも日本語にする（英語の macOS を使っていても日本語を読める人には、これまでどおり日本語で出す）
export function resolveLanguage(setting: LanguageSetting, preferred: readonly string[]): Language {
  if (setting !== 'system') return setting;
  return preferred.some((tag) => /^ja(?:-|_|$)/i.test(tag)) ? 'ja' : 'en';
}

// 日付・数の書式（toLocaleString など）に渡すロケール
export function locale(): string {
  return current === 'en' ? 'en-US' : 'ja-JP';
}

// キーの文言（埋め込む前のもの）。今の言語に無ければ日本語、それも無ければキーのまま。
// count が 1 なら、単数形（キーの末尾に _one を付けたもの。英語の "1 file" など）があればそれを使う
export function message(key: MessageKey, count?: unknown): string {
  return messageIn(current, key, count);
}

// キーの文言に、params の値を埋め込む。params.count が 1 なら単数形を使う（message）。
// モジュールの一番上（読み込み時）では呼ばない（画面は、言語を決める前にモジュールを読み込むため）
export function t(key: MessageKey, params?: Params): string {
  const text = messageIn(current, key, params?.count);
  return params ? fillTemplate(text, params) : text;
}

// 今の言語でなく、lang の文言（言語の設定を変えたときに、変えた先の言語で再起動を聞くのに使う）
export function tFor(lang: Language, key: MessageKey, params?: Params): string {
  const text = messageIn(lang, key, params?.count);
  return params ? fillTemplate(text, params) : text;
}

// 文言の中の {name} を params の値で置き換える。params に無い名前は、そのまま残す
export function fill(text: string, params: Params): string {
  return join(text.split(PLACEHOLDER), params);
}

const PLACEHOLDER = /\{(\w+)\}/;

// JSON の文言に埋め込む（分けた形を覚えて使い回す。文言の数だけしか増えない）
function fillTemplate(text: string, params: Params): string {
  let parts = templates.get(text);
  if (!parts) templates.set(text, (parts = text.split(PLACEHOLDER)));
  return join(parts, params);
}

function join(parts: string[], params: Params): string {
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    out += (name in params ? String(params[name]) : `{${name}}`) + parts[i + 1];
  }
  return out;
}

function messageIn(lang: Language, key: string, count: unknown): string {
  return (count === 1 ? lookup(lang, `${key}_one`) : null) ?? lookup(lang, key) ?? (lang === 'ja' ? null : lookup('ja', key)) ?? key;
}

function lookup(lang: Language, key: string): string | null {
  const memo = found[lang];
  let text = memo.get(key);
  if (text === undefined) {
    text = walk((trees[lang] ??= JSON.parse(SOURCES[lang]) as Tree), key);
    memo.set(key, text);
  }
  return text;
}

function walk(tree: Tree, key: string): string | null {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return null;
    node = node[part];
  }
  return typeof node === 'string' ? node : null;
}
