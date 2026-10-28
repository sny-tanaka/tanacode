import type { KeyboardInputEvent, WebContents } from 'electron';

// Claude（アプリ内ブラウザの MCP）がページに送るキー。sendInputEvent で送ったキーも、人が押したキーと同じく、ページの
// before-input-event を通る。そこでアプリのショートカット（⌘W・⌘1〜4・⌃⌘↓ など）として扱うと、Claude のキーが、人のフォーカスが
// どこにあっても、タブを閉じたり、人のフォーカスを移したり、セッションを切り替えたりしてしまう。
// 送っている間だけ印を付け、before-input-event では、印のあるキーをショートカットにしない（ページにだけ届ける）。
// before-input-event は、sendInputEvent の中で、その場で呼ばれる
const sending = new WeakSet<WebContents>();

export function sendAsClaude(contents: WebContents, event: KeyboardInputEvent): void {
  sending.add(contents);
  try {
    contents.sendInputEvent(event);
  } finally {
    sending.delete(contents);
  }
}

// 今 before-input-event に来たキーが、Claude の送ったものか
export function isClaudeInput(contents: WebContents): boolean {
  return sending.has(contents);
}
