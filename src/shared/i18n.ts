import en from './locales/en.json';
import ja from './locales/ja.json';

// 画面の文言。文言は言語ごとの JSON（src/shared/locales/ja.json・en.json）に置き、コードでは t('sidebar.newSession') のようにキーで読む。
// main と画面（renderer）で、それぞれのプロセスが今の言語を持つ。既定は日本語（テストもこのまま日本語で動く）

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

// en.json に足りないキーがあれば、型チェックで止める（足りないキーがエラーに並ぶ）。余分なキーと埋め込みの違いは test/i18n.test.ts で確かめる
function complete<Missing extends never>(): void {}
complete<Exclude<MessageKey, Leaves<typeof en>>>();

// 文言に埋め込む値（文言の中の {name} を置き換える）
export type Params = Record<string, string | number>;

const MESSAGES: Record<Language, Tree> = { ja, en };

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
  const own = MESSAGES[current];
  return (count === 1 ? lookup(own, `${key}_one`) : undefined) ?? lookup(own, key) ?? lookup(MESSAGES.ja, key) ?? key;
}

// キーの文言に、params の値を埋め込む。呼んだときの言語で選ぶので、モジュールの一番上（読み込み時）では呼ばない。
// params.count が 1 なら単数形を使う（message）
export function t(key: MessageKey, params?: Params): string {
  const text = message(key, params?.count);
  return params ? fill(text, params) : text;
}

// 文言の中の {name} を params の値で置き換える。params に無い名前は、そのまま残す
export function fill(text: string, params: Params): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}
