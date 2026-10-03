import { describe, expect, it } from 'vitest';
import { applyTranslation, isMostlyForeign, planTranslation } from '@shared/translate';

// チャットの思考・応答の翻訳で、翻訳に渡す前後の文字の扱いと、ボタンを出すかの判定

// 渡した文字に「訳」を付けて返す、作り物の翻訳
const fake = (texts: string[]) => texts.map((t) => `訳(${t})`);

describe('翻訳に渡す行と、組み直し', () => {
  it('1 行ずつ渡し、空行はそのまま残す', () => {
    const plan = planTranslation('First line.\n\nSecond line.');
    expect(plan.texts).toEqual(['First line.', 'Second line.']);
    expect(applyTranslation(plan, fake(plan.texts))).toBe('訳(First line.)\n\n訳(Second line.)');
  });

  it('コードブロックの中は訳さない（``` と ~~~、長い印の中の短い印も）', () => {
    const text = ['Run this:', '```bash', 'npm test', '```', '~~~~', '~~~', 'still code', '~~~~', 'Done.'].join('\n');
    const plan = planTranslation(text);
    expect(plan.texts).toEqual(['Run this:', 'Done.']);
    expect(applyTranslation(plan, fake(plan.texts)).split('\n')).toEqual(['訳(Run this:)', '```bash', 'npm test', '```', '~~~~', '~~~', 'still code', '~~~~', '訳(Done.)']);
  });

  it('行頭のリスト・見出し・引用・字下げの印は外して渡し、付け直す', () => {
    const text = ['## Design', '- First item', '  - Nested item', '1. Numbered', '> Quoted', '- [x] Done task'].join('\n');
    const plan = planTranslation(text);
    expect(plan.texts).toEqual(['Design', 'First item', 'Nested item', 'Numbered', 'Quoted', 'Done task']);
    expect(applyTranslation(plan, fake(plan.texts)).split('\n')).toEqual([
      '## 訳(Design)',
      '- 訳(First item)',
      '  - 訳(Nested item)',
      '1. 訳(Numbered)',
      '> 訳(Quoted)',
      '- [x] 訳(Done task)',
    ]);
  });

  it('文字の無い行（表の区切り・記号だけ）は渡さない', () => {
    const plan = planTranslation('| Name | Value |\n| --- | :-: |\n---\n| a | b |');
    expect(plan.texts).toEqual(['| Name | Value |', '| a | b |']);
  });

  it('表の行は、区切りの | の数が変わったら原文のままにする', () => {
    const plan = planTranslation('| Name | Value |\n| a | b |');
    expect(applyTranslation(plan, ['| 名前 | 値 |', '| a b |'])).toBe('| 名前 | 値 |\n| a | b |');
  });

  it('引用の中のコードブロックも訳さない', () => {
    const plan = planTranslation(['Run this:', '> ```bash', '> npm test', '> ```', '> Then check the log.'].join('\n'));
    expect(plan.texts).toEqual(['Run this:', 'Then check the log.']);
  });

  it('言語名の付いた印では閉じない（入れ子の中の開く印）。印だけの行で閉じる', () => {
    const plan = planTranslation(['Example:', '````markdown', '```bash', 'const a = 1;', '```', '````', 'After.'].join('\n'));
    expect(plan.texts).toEqual(['Example:', 'After.']);
  });

  it('リンクの参照の定義は訳さない。CRLF の行も分ける', () => {
    const plan = planTranslation('See [the docs][1].\r\n\r\n[1]: https://example.com/docs');
    expect(plan.texts).toEqual(['See [the docs][1].']);
    expect(applyTranslation(plan, ['[ドキュメント][1]を見てください。'])).toBe('[ドキュメント][1]を見てください。\n\n[1]: https://example.com/docs');
  });

  it('訳が空のときは原文を残す', () => {
    const plan = planTranslation('Hello there.');
    expect(applyTranslation(plan, [''])).toBe('Hello there.');
  });
});

describe('翻訳のボタンを出すか', () => {
  it('英語の思考には出す（日本語の引用が少し混ざっていても）', () => {
    expect(isMostlyForeign('The user wants a translate button. They said 「翻訳」 so I should add it to each block.')).toBe(true);
  });

  it('日本語の応答には出さない（ファイル名やコマンドが多くても）', () => {
    expect(isMostlyForeign('src/main/index.ts と src/preload/index.ts を直しました。npm run typecheck は通っています。')).toBe(false);
    expect(isMostlyForeign('`npm run build` のあと `node_modules/.bin/electron .` で起動します。\n```bash\nnpm run build && electron . --user-data-dir=/tmp/x\n```')).toBe(false);
  });

  it('日本語の応答には出さない（バッククォートの無いパスや URL が多くても）', () => {
    expect(isMostlyForeign('以下を直しました:\n- src/renderer/src/translate/BlockTranslation.tsx\n- src/renderer/src/chat/ChatRow.tsx\n- src/shared/translate.ts')).toBe(false);
    expect(isMostlyForeign('PR を作りました: https://github.com/sny-tanaka/tanacode/pull/65')).toBe(false);
  });

  it('コードだけ・短い英語には出さない', () => {
    expect(isMostlyForeign('```ts\nconst translation = useBlockTranslation(text);\n```')).toBe(false);
    expect(isMostlyForeign('Done.')).toBe(false);
  });
});
