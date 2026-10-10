import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bracketedPaste } from '@shared/prompt-keys';
import { enterClaudeScreen, leaveClaudeScreen } from './claudeScreenTyping';
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
    for (const [id, t] of terms) {
      t.term.dispose();
      t.element.remove();
      leaveClaudeScreen(id);
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

// Claude Code の入力欄に貼る（送らない。人が画面で続きを打ち、Enter で送る）。
// 画像は、パスを貼り付けとして送ると [Image #n] として添付される（main の submit と同じ）。制御文字は、呼ぶ側で取り除いておく
export async function pasteIntoClaudeScreen(sessionId: string, text: string, attachments: string[] = []): Promise<void> {
  for (const path of attachments) {
    window.tanacode.pty.write(sessionId, bracketedPaste(path));
    await new Promise((resolve) => setTimeout(resolve, IMAGE_PASTE_MS));
    window.tanacode.pty.write(sessionId, ' ');
  }
  if (text) window.tanacode.pty.write(sessionId, bracketedPaste(text));
  terms.get(sessionId)?.term.focus();
}

// Claude Code の生の画面。ターミナルモードで、チャットの代わりに Claude Code ペインに出す。
// 出した時点の大きさに pty をリサイズするので、Claude が画面全体を描き直す。
// 隠したら pty を既定の大きさに戻す（チャットに出す質問や確認は、main が画面から読む。読むのに向いた大きさにしておく）
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
    // 出している間は、人が Claude Code の入力欄に打っているものとして、書きかけをチャットの入力欄に移さない（隠したら移す）
    enterClaudeScreen(sessionId);
    const observer = new ResizeObserver(() => t.fit.fit());
    observer.observe(host);
    return () => {
      observer.disconnect();
      t.element.remove();
      window.tanacode.pty.resetSize(sessionId);
      leaveClaudeScreen(sessionId);
    };
  }, [sessionId]);

  return <div className="claude-screen" ref={hostRef} />;
}
