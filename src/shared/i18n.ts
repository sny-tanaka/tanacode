import ja from './locales/ja.json';

// 画面の文言。文言は言語ごとの JSON（src/shared/locales/ja.json など）に置き、コードでは t('sidebar.newSession') のようにキーで読む。
// main と画面（renderer）で、それぞれのプロセスが今の言語を持つ。既定は日本語（テストもこのまま日本語で動く）

export type Language = 'ja';

type Messages = typeof ja;
type Tree = { [key: string]: string | Tree };

// JSON の入れ子を「.」でつないだキー（例: 'sidebar.newSession'）。無いキーを書くと型チェックで止まる
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Messages>;

// 文言に埋め込む値（文言の中の {name} を置き換える）
export type Params = Record<string, string | number>;

const MESSAGES: Record<Language, Tree> = { ja };

let current: Language = 'ja';

export function language(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  current = lang;
}

// 日付・数の書式（toLocaleString など）に渡すロケール
export function locale(): string {
  return 'ja-JP';
}

// キーの文言（埋め込む前のもの）。今の言語に無ければ日本語、それも無ければキーのまま
export function message(key: MessageKey): string {
  return lookup(MESSAGES[current], key) ?? lookup(MESSAGES.ja, key) ?? key;
}

// キーの文言に、params の値を埋め込む。呼んだときの言語で選ぶので、モジュールの一番上（読み込み時）では呼ばない
export function t(key: MessageKey, params?: Params): string {
  const text = message(key);
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
