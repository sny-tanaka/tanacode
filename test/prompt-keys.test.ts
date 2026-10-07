import { describe, expect, it } from 'vitest';
import { bracketedPaste, stripControlChars } from '@shared/prompt-keys';

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
