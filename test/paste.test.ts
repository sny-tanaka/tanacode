import { describe, expect, it } from 'vitest';
import { bracketedPaste, isLongPaste, stripControlChars } from '@shared/paste';

// 外から来た文・貼る文から、制御文字を除く（チャットの入力・親セッションからの指示・MCP から届く文・シェルに書くコマンド・TUI に貼る文）。
// ESC が残ると貼り付けの外に出たりキー操作として届いたりし、^U・^H や双方向の制御文字は、見えている文字と送る文字をずらせる

describe('stripControlChars', () => {
  it('ESC・^U・^H・DEL・C1 の制御文字を除く', () => {
    expect(stripControlChars('a\x1b[201~b')).toBe('a[201~b');
    expect(stripControlChars('a\x15b\x08c\x7fd\x9be\x00f')).toBe('abcdef');
  });

  it('双方向の制御文字・方向の印（見た目と中身をずらせるもの）を除く', () => {
    expect(stripControlChars('rm \u202Etxt.exe\u202C \u2066x\u2069 \u200E\u200F\u061C')).toBe('rm txt.exe x ');
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

describe('isLongPaste', () => {
  it('4 行以上か、800 文字より長い貼り付けは、札にする。それより短いものは、文字のまま入れる', () => {
    expect(isLongPaste('1 行目\n2 行目\n3 行目')).toBe(false);
    expect(isLongPaste('1 行目\n2 行目\n3 行目\n4 行目')).toBe(true);
    expect(isLongPaste('a'.repeat(800))).toBe(false);
    expect(isLongPaste('a'.repeat(801))).toBe(true);
    expect(isLongPaste('')).toBe(false);
  });
});
