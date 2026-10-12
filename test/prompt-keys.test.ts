import { describe, expect, it } from 'vitest';
import { bracketedPaste, pastedLines, promptKeys, stripControlChars } from '@shared/prompt-keys';

// pty に打つ文字から、制御文字を除く（チャットの入力・親セッションからの指示・MCP から届く文・シェルに書くコマンド）。
// ESC が残ると貼り付けの外に出たりキー操作として届いたりし、^U・^H や双方向の制御文字は、見えている文字と送る文字をずらせる

describe('stripControlChars', () => {
  it('ESC・^U・^H・DEL・C1 の制御文字を除く', () => {
    expect(stripControlChars('a\x1b[201~b')).toBe('a[201~b');
    expect(stripControlChars('a\x15b\x08c\x7fd\x9be\x00f')).toBe('abcdef');
  });

  it('双方向の制御文字・方向の印（見た目と中身をずらせるもの）を除く', () => {
    expect(stripControlChars('rm ‮txt.exe‬ ⁦x⁩ ‎‏؜')).toBe('rm txt.exe x ');
  });

  it('改行とタブは残し、CR（\\r\\n・\\r）は改行にそろえる', () => {
    expect(stripControlChars('一\r\n二\r三\n\t四')).toBe('一\n二\n三\n\t四');
  });

  it('ふつうの文字（日本語・絵文字・記号）は変えない', () => {
    const text = '日本語と English、絵文字 🎉、記号 ~!@#$%^&*()';
    expect(stripControlChars(text)).toBe(text);
  });
});

describe('bracketedPaste', () => {
  it('貼り付けの囲み（ESC [200~ と ESC [201~）で包む', () => {
    expect(bracketedPaste('/tmp/a.png')).toBe('\x1b[200~/tmp/a.png\x1b[201~');
  });
});

// 発言の打ち込み方。丸ごと 1 つの貼り付けにすると、ログインして使う Claude Code（2.1.296）は、4 行以上・長い貼り付けを
// <pasted_content> の囲みに入れて Claude に渡す。ユーザー自身の長い発言や親セッションからの指示が「貼り付けられた文」になり、
// Claude が従う前に確認を求めて止まることがある。行ごとの短い貼り付けに分けると、囲みが付かない（本物の Claude Code で確かめた）
describe('promptKeys', () => {
  const paste = bracketedPaste;

  it('1 行の短い発言は、打鍵で送る', () => {
    expect(promptKeys('こんにちは')).toBe('こんにちは');
    expect(promptKeys('@src/a.ts を見て')).toBe('@src/a.ts を見て');
    expect(promptKeys('あ'.repeat(800))).toBe('あ'.repeat(800));
  });

  it('複数行の発言は、行ごとの貼り付けに分けて、改行は LF で打つ（丸ごと 1 つの貼り付けにしない）', () => {
    expect(promptKeys('1 行目\n2 行目')).toBe(`${paste('1 行目')}\n${paste('2 行目')}`);
    const text = ['# 見出し', '', '- 箇条書き  ', '  - 入れ子', '```ts', '\treturn 1;', '```', '', '', '@src/a.ts と !ls と /api は、行のはじめでもそのまま'].join('\n');
    const keys = promptKeys(text);
    // 空行は、貼り付けなしで改行だけ
    expect(keys).toBe(text.split('\n').map((line) => (line ? paste(line) : '')).join('\n'));
    // 貼り付けの中に改行は入らない（4 行以上の貼り付けは、囲みに入るため）
    for (const piece of keys.split('\x1b[201~')) expect(piece.replace(/^\n+/, '')).not.toContain('\n');
    // 囲みと改行を除けば、元の文字のまま
    expect(keys.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '')).toBe(text);
  });

  it('長い行は、300 文字までの貼り付けに分ける（およそ 800 文字より長い貼り付けは、囲みに入るため）。サロゲートペアの途中では切らない', () => {
    const long = `${'x'.repeat(299)}🎉${'y'.repeat(700)}`;
    const keys = promptKeys(long);
    const parts = keys.split('\x1b[201~').filter(Boolean).map((p) => p.replace('\x1b[200~', ''));
    expect(parts.map((p) => p.length)).toEqual([299, 300, 300, 102]);
    expect(parts[1].startsWith('🎉')).toBe(true);
    expect(parts.join('')).toBe(long);
    // 複数行の中の長い行も同じ
    expect(pastedLines(`短い行\n${'あ'.repeat(650)}`)).toBe(`${paste('短い行')}\n${paste('あ'.repeat(300))}${paste('あ'.repeat(300))}${paste('あ'.repeat(50))}`);
  });

  it('親セッションからの指示・アプリの知らせも、複数行なら行ごとに分ける（目印のタグごと囲みに入ると、親からの指示に見えない）', () => {
    const text = '<tanacode-parent-message session="0f8c2a1e-0000-4000-8000-000000000001">1 行目\n2 行目\n3 行目\n4 行目</tanacode-parent-message>';
    expect(promptKeys(text)).toBe(text.split('\n').map(paste).join('\n'));
  });

  it('/ か ! で始まる発言は、行ごとに分けない（1 行めが、コマンドやシェルのコマンドとして扱われる）。複数行は丸ごと貼り付け、1 行は打鍵のまま', () => {
    expect(promptKeys('/api のエンドポイントを直して\n詳しく')).toBe(paste('/api のエンドポイントを直して\n詳しく'));
    expect(promptKeys('!important な話です\n2 行目\n3 行目\n4 行目')).toBe(paste('!important な話です\n2 行目\n3 行目\n4 行目'));
    expect(promptKeys('!ls')).toBe('!ls');
    expect(promptKeys('/clear')).toBe('/clear');
    const long = `/${'a'.repeat(900)}`;
    expect(promptKeys(long)).toBe(long);
  });
});
