// チャットの思考・応答の翻訳（macOS 標準の翻訳で日本語に訳す）。main と画面の両方で使う型と、訳す前後の文字の扱い

// 訳せないわけ。same-language: 元が日本語 / not-installed: 翻訳データ（言語）が入っていない /
// unsupported: macOS の翻訳が対応していない言語・言語を判定できない / failed: そのほか（message にわけ）
export type TranslateError = 'same-language' | 'not-installed' | 'unsupported' | 'failed';

// texts は渡したものと同じ順・同じ数。source は元の言語（en など）
export type TranslateResult = { ok: true; texts: string[]; source?: string } | { ok: false; error: TranslateError; source?: string; message?: string };

// 1 回に訳す量の上限（長い思考でも収まる大きさ。1 行に 50 ミリ秒ほどかかる）
export const MAX_TRANSLATE_TEXTS = 1000;
export const MAX_TRANSLATE_CHARS = 100_000;

// ---- 訳す前後の文字の扱い ----
// macOS の翻訳に複数行をまとめて渡すと、改行が空行に増える。そのため 1 行ずつ渡す。
// コードブロック（引用の中のものも）とリンクの参照の定義は訳さない。行頭の字下げ・引用・リスト・見出しの印は外して渡し、訳したあとに付け直す
// （インラインコードは、訳しても `…` のまま残る。2026-10 に macOS 26 で確かめた）

// 囲みの印（引用の > の後ろも見る）と、その後ろ（開く印には言語名などが付く。閉じる印には付かない）
const FENCE = /^\s*(?:>\s?)*\s*(`{3,}|~{3,})(.*)$/;
// リンクの参照の定義（[1]: https://…）。訳すと、本文のリンクとつながらなくなる
const LINK_DEFINITION = /^\s*\[[^\]]+\]:\s*\S/;
const PREFIX = /^(\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+)?)/;
// 文字（どの言語でも）を含む行だけ訳す。表の区切りの行（| --- | :-: |）も、文字を含まないので訳さない
const LETTER = /\p{L}/u;

export type TranslationPlan = {
  lines: string[];
  // 訳す行の番号と、外した行頭の印
  slots: { line: number; prefix: string }[];
  // 翻訳に渡す文字（slots と同じ順）
  texts: string[];
};

export function planTranslation(text: string): TranslationPlan {
  const lines = text.split(/\r?\n/);
  const slots: TranslationPlan['slots'] = [];
  const texts: string[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const [, mark, rest] = line.match(FENCE) ?? [];
    if (fence) {
      // 開いたときと同じ文字で、同じ長さ以上の印だけの行が来たら閉じる（```bash などは、入れ子の中の開く印）
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && !rest.trim()) fence = null;
      return;
    }
    if (mark) {
      fence = mark;
      return;
    }
    if (LINK_DEFINITION.test(line)) return;
    const prefix = line.match(PREFIX)![1];
    const body = line.slice(prefix.length);
    if (!LETTER.test(body)) return;
    slots.push({ line: i, prefix });
    texts.push(body);
  });
  return { lines, slots, texts };
}

// 訳した文字を元の行に戻す。表の行は、区切りの | の数が変わったら（崩れたら）原文のままにする
export function applyTranslation(plan: TranslationPlan, translated: string[]): string {
  const lines = [...plan.lines];
  plan.slots.forEach(({ line, prefix }, i) => {
    const text = translated[i]?.trim();
    if (!text) return;
    const original = plan.texts[i];
    if (original.includes('|') && pipes(original) !== pipes(text)) return;
    lines[line] = prefix + text;
  });
  return lines.join('\n');
}

const pipes = (s: string) => s.split('|').length;

// ---- 翻訳のボタンを出すか ----
// 1 つのブロックの一部だけが英語、ということはないので、ブロック全体で見る。
// コード（コードブロック・インラインコード）と、URL・パス（日本語の応答にも多い）を除いた文字で、
// 日本語の文字がラテン文字の 1 割に満たなければ、日本語でない文とみなす（ラテン文字の言語だけが対象）

const JAPANESE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g;
const LATIN = /[A-Za-z]/g;
// URL と、/ や文字にはさまれた . を含む語（src/main/index.ts・e.g. など）
const NOT_PROSE = /https?:\/\/\S+|\S*(?:\/|\w\.\w)\S*/g;
// これより短いもの（英語の 1〜2 語など）には出さない
const MIN_LATIN = 20;

export function isMostlyForeign(text: string): boolean {
  const prose = planTranslation(text).texts.join('\n').replace(/`[^`\n]*`/g, '').replace(NOT_PROSE, '');
  const latin = prose.match(LATIN)?.length ?? 0;
  const japanese = prose.match(JAPANESE)?.length ?? 0;
  return latin >= MIN_LATIN && japanese * 10 < latin;
}
