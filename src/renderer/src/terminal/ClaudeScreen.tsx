import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bracketedPaste, stripControlChars } from '@shared/paste';
import type { SessionState } from '@shared/session-tools';
import { xtermOptions } from './xterm';

type Term = { term: Terminal; fit: FitAddon; element: HTMLDivElement; opened: boolean };

// セッションごとの xterm。画面を出していない間（チャットを見ている・ほかのセッションや新規セッションの画面を見ている）も
// pty の出力を受け取っておくので、部品（ClaudeScreen）の外に持つ。element は、出すときに部品の中へ移す
const terms = new Map<string, Term>();
// 出力を受け取っているもの（App と、出ている ClaudeScreen）の数
let holders = 0;
let offData: (() => void) | null = null;

function termFor(sessionId: string): Term {
  let t = terms.get(sessionId);
  if (!t) {
    const term = new Terminal(xtermOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => window.tanacode.pty.write(sessionId, data));
    term.onResize(({ cols, rows }) => window.tanacode.pty.resize(sessionId, cols, rows));
    const element = document.createElement('div');
    element.className = 'terminal-instance';
    t = { term, fit, element, opened: false };
    terms.set(sessionId, t);
  }
  return t;
}

// pty の出力を受け取り始める。返す関数で終える。最後の 1 つが終えたら、xterm も片付ける
function hold(): () => void {
  if (holders++ === 0) offData = window.tanacode.pty.onData(({ sessionId, data }) => termFor(sessionId).term.write(data));
  return () => {
    if (--holders > 0) return;
    offData?.();
    offData = null;
    for (const t of terms.values()) {
      t.term.dispose();
      t.element.remove();
    }
    terms.clear();
  };
}

// アプリが動いている間、どのセッションの Claude Code の画面の出力も受け取っておく（App が呼ぶ）。
// 画面を出したときに、それまでの出力をさかのぼって読める
export function useClaudeScreenOutput(): void {
  useEffect(hold, []);
}

const IMAGE_PASTE_MS = 300;

// 今は貼れないターミナルモードのセッション。TUI が許可の確認・質問のメニューを出している間（一覧の attention。main の tuiAsk）は、
// 貼るとメニューへの入力に混ざる。ターミナルモードで止まっている・起動や切り替えの途中は、貼る先の TUI が無い。
// その間に貼るものは預かり、TUI が動いてメニューが閉じたら順に貼る（main が貼る知らせと同じ。SessionManager.pasteIntoTerminal）。
// 止まっている間に預かったものは、「再開」で TUI が動いたら貼る（チャットの、再開したら送る発言と同じ）。
// 預かっている間にターミナルモードでなくなったら、貼る先の TUI が無いので捨てる
const asking = new Set<string>();
const held = new Map<string, { text: string; attachments: string[] }[]>();

// セッションの一覧が変わった（App が呼ぶ）
export function noteClaudeScreenSessions(
  sessions: readonly { id: string; terminal?: boolean; state?: SessionState | null; attention: string | null }[],
): void {
  for (const session of sessions) {
    if (session.terminal && (session.state !== 'terminal' || session.attention === 'permission' || session.attention === 'question')) {
      asking.add(session.id);
      continue;
    }
    asking.delete(session.id);
    const waiting = held.get(session.id);
    if (!waiting) continue;
    held.delete(session.id);
    if (!session.terminal) continue;
    void (async () => {
      for (const paste of waiting) await writePaste(session.id, paste.text, paste.attachments);
    })();
  }
}

// Claude Code の入力欄に貼る（送らない。人が画面で続きを打ち、Enter で送る）。メニューが出ている間・止まっている間は、貼れるように
// なってから貼る（上の asking）。
// 画像は、パスを貼り付けとして送ると [Image #n] として添付される（TUI の決まり）。
// 貼る文は、ファイルの中身・Claude が書いた文・ターミナルの出力などから来るので、ここで必ず制御文字を取り除く
// （ESC が残ると、ESC[201~ で貼り付けを抜け、あとの文字が Enter・Shift+Tab などのキーとして TUI に届く）
export async function pasteIntoClaudeScreen(sessionId: string, text: string, attachments: string[] = []): Promise<void> {
  if (asking.has(sessionId)) {
    held.set(sessionId, [...(held.get(sessionId) ?? []), { text, attachments }]);
    return;
  }
  await writePaste(sessionId, text, attachments);
}

async function writePaste(sessionId: string, text: string, attachments: string[]): Promise<void> {
  for (const path of attachments) {
    window.tanacode.pty.write(sessionId, bracketedPaste(stripControlChars(path)));
    await new Promise((resolve) => setTimeout(resolve, IMAGE_PASTE_MS));
    window.tanacode.pty.write(sessionId, ' ');
  }
  const safe = stripControlChars(text);
  if (safe) window.tanacode.pty.write(sessionId, bracketedPaste(safe));
  terms.get(sessionId)?.term.focus();
}

// Claude Code の生の画面。ターミナルモードで、チャットの代わりに Claude Code ペインに出す。
// 出した時点の大きさに pty をリサイズするので、Claude が画面全体を描き直す。
// 隠したら pty を既定の大きさに戻す（次に出したときに大きさが変わり、TUI が画面全体を描き直す）
export function ClaudeScreen({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useClaudeScreenOutput();

  useEffect(() => {
    const host = hostRef.current!;
    const t = termFor(sessionId);
    host.appendChild(t.element);
    if (!t.opened) {
      t.term.open(t.element);
      t.opened = true;
    }
    t.fit.fit();
    // 大きさが前に出したときと同じだと onResize が来ないので、ここでも pty に伝える
    window.tanacode.pty.resize(sessionId, t.term.cols, t.term.rows);
    t.term.focus();
    const observer = new ResizeObserver(() => t.fit.fit());
    observer.observe(host);
    return () => {
      observer.disconnect();
      t.element.remove();
      window.tanacode.pty.resetSize(sessionId);
    };
  }, [sessionId]);

  return <div className="claude-screen" ref={hostRef} />;
}
