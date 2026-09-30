import type { ITerminalOptions } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { token } from '../theme';

// Claude Code の画面・統合ターミナルで共通の見た目（ターミナルは読む場所なので bg-panel）
export function xtermOptions(): ITerminalOptions {
  return {
    fontFamily: '"JetBrains Mono", Menlo, monospace',
    fontSize: 12,
    cursorBlink: true,
    // 16 色のままだと背景に対して読みにくい組み合わせがあるので、コントラスト比 4.5 まで自動で調整させる
    minimumContrastRatio: 4.5,
    theme: {
      background: token('bg-panel'),
      foreground: token('text-primary'),
      cursor: token('text-secondary'),
      selectionBackground: token('bg-selected'),
      scrollbarSliderBackground: token('border-strong'),
      scrollbarSliderHoverBackground: token('text-tertiary'),
      scrollbarSliderActiveBackground: token('text-secondary'),
      black: token('ansi-black'),
      red: token('ansi-red'),
      green: token('ansi-green'),
      yellow: token('ansi-yellow'),
      blue: token('ansi-blue'),
      magenta: token('ansi-magenta'),
      cyan: token('ansi-cyan'),
      white: token('ansi-white'),
      brightBlack: token('ansi-bright-black'),
      brightRed: token('ansi-bright-red'),
      brightGreen: token('ansi-bright-green'),
      brightYellow: token('ansi-bright-yellow'),
      brightBlue: token('ansi-bright-blue'),
      brightMagenta: token('ansi-bright-magenta'),
      brightCyan: token('ansi-bright-cyan'),
      brightWhite: token('ansi-bright-white'),
    },
  };
}
