// アプリ全体のキーボードショートカット（メニューバーの「移動」に並べるもの）。main（メニューとアプリ内ブラウザのページ）と画面で同じ表を使う。
// キーは英字・数字・矢印・Tab だけにする（記号のキーは、JIS 配列と US 配列で場所が違い、押せないことがあるため）。
// 間違えて押しにくいよう、どれも ⌘ か ⌃ と組み合わせる
export type Shortcut =
  | 'focusSessions'
  | 'focusChat'
  | 'focusSide'
  | 'focusContent'
  | 'toggleTerminal'
  | 'previousSession'
  | 'nextSession'
  | 'nextTab'
  | 'previousTab'
  | 'closeTab'
  | 'focusQuestion';

type Keys = {
  // 押すキー。英字・数字は KeyboardEvent.code（配列や入力モードで変わらない場所）、ほかは key で見る
  code?: string;
  key?: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
};

export type ShortcutDef = Keys & {
  id: Shortcut;
  // メニューの accelerator（macOS がメニューの右に出す）
  accelerator: string;
  // 画面（ツールチップ・GUIDE）に出すときの書き方
  label: string;
};

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'focusSessions', code: 'Digit1', meta: true, accelerator: 'Cmd+1', label: '⌘1' },
  { id: 'focusChat', code: 'Digit2', meta: true, accelerator: 'Cmd+2', label: '⌘2' },
  { id: 'focusSide', code: 'Digit3', meta: true, accelerator: 'Cmd+3', label: '⌘3' },
  { id: 'focusContent', code: 'Digit4', meta: true, accelerator: 'Cmd+4', label: '⌘4' },
  { id: 'toggleTerminal', code: 'KeyJ', meta: true, accelerator: 'Cmd+J', label: '⌘J' },
  { id: 'previousSession', key: 'ArrowUp', meta: true, ctrl: true, accelerator: 'Ctrl+Cmd+Up', label: '⌃⌘↑' },
  { id: 'nextSession', key: 'ArrowDown', meta: true, ctrl: true, accelerator: 'Ctrl+Cmd+Down', label: '⌃⌘↓' },
  { id: 'nextTab', key: 'Tab', ctrl: true, accelerator: 'Ctrl+Tab', label: '⌃Tab' },
  { id: 'previousTab', key: 'Tab', ctrl: true, shift: true, accelerator: 'Ctrl+Shift+Tab', label: '⌃⇧Tab' },
  { id: 'closeTab', code: 'KeyW', meta: true, accelerator: 'Cmd+W', label: '⌘W' },
  { id: 'focusQuestion', code: 'KeyA', meta: true, shift: true, accelerator: 'Cmd+Shift+A', label: '⌘⇧A' },
];

// 押したキー（画面の KeyboardEvent と、main の before-input-event の Input を、同じ形にしたもの）
export type PressedKey = { code: string; key: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean };

// 押したキーに当たるショートカット。修飾キーは、表のものと過不足なく同じときだけ（⌥ を足したものなどは、ほかの操作に残す）
export function matchShortcut(pressed: PressedKey): Shortcut | null {
  if (pressed.alt) return null;
  const found = SHORTCUTS.find(
    (s) =>
      (s.code ? s.code === pressed.code : s.key === pressed.key) &&
      !!s.meta === pressed.meta &&
      !!s.ctrl === pressed.ctrl &&
      !!s.shift === pressed.shift,
  );
  return found?.id ?? null;
}

export function shortcutLabel(id: Shortcut): string {
  return SHORTCUTS.find((s) => s.id === id)!.label;
}
